import test from "node:test";
import assert from "node:assert/strict";
import { createServerRepository } from "../../src/planner/serverRepository.js";
import { normalizeEvent } from "../../shared/domain.js";

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const capture = (response) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function"
      ? response(url, init)
      : response.clone();
  };
  return { calls, fetchImpl };
};

test("data requests use same-origin JSON writes with the CSRF header", async () => {
  const { calls, fetchImpl } = capture((url) => jsonResponse(url === "/api/sync/snapshot"
    ? { epoch: "test-epoch", changes: [{ id: "1", revision: 7, event: { id: "1" } }] }
    : { results: [{ id: "1", revision: 8, status: "accepted" }] }));
  const repository = createServerRepository({ fetchImpl });
  assert.deepEqual(await repository.list(), [{ id: "1" }]);
  assert.equal(calls[0].url, "/api/sync/snapshot");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.headers, undefined);

  await repository.apply({ upserts: [{ id: "1" }], deletes: [] });
  assert.equal(calls[1].url, "/api/sync/push");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers["X-Calendar-Request"], "1");
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  const sent = JSON.parse(calls[1].init.body);
  assert.equal(sent.epoch, "test-epoch"); assert.equal(sent.operations[0].baseRevision, 7);
  assert.deepEqual(sent.operations[0].event, { id: "1" }); assert.equal(typeof sent.operations[0].opId, "string");

  await repository.setSettings({ theme: "dark" });
  assert.equal(calls[2].init.method, "PATCH");
  assert.equal(calls[2].url, "/api/settings");

  const raw = '[{"id":"raw-1"}]';
  await repository.importText(raw);
  assert.equal(calls[3].url, "/api/import");
  assert.equal(calls[3].init.body, raw);
  assert.equal(calls[3].init.headers["X-Calendar-Request"], "1");
});

test("an HTTP browser can create and save a new event without randomUUID", async (t) => {
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
  t.after(() => { delete globalThis.crypto.randomUUID; });
  const { calls, fetchImpl } = capture((url) => jsonResponse(
    url === "/api/sync/snapshot"
      ? { epoch: "test-epoch", changes: [] }
      : { results: [] },
  ));
  const repository = createServerRepository({ fetchImpl });
  const event = normalizeEvent({
    title: "Local appointment",
    start: "2026-11-20",
    end: "2026-11-21",
    allDay: true,
  });

  await repository.list();
  await repository.apply({ upserts: [event] });

  const [operation] = JSON.parse(calls[1].init.body).operations;
  const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  assert.match(event.id, uuidV4);
  assert.match(operation.opId, uuidV4);
  assert.notEqual(operation.opId, event.id);
  assert.deepEqual(operation.event, event);
});

test("non-OK responses surface server messages without local fallback", async () => {
  const { fetchImpl } = capture(jsonResponse({ error: "日程变更无效" }, 400));
  const repository = createServerRepository({ fetchImpl });
  await assert.rejects(() => repository.list(), (error) => {
    assert.equal(error.message, "日程变更无效");
    assert.equal(error.status, 400);
    return true;
  });

  const html = capture(
    new Response("<html>bad gateway</html>", { status: 502 }),
  );
  const gateway = createServerRepository({ fetchImpl: html.fetchImpl });
  await assert.rejects(
    () => gateway.list(),
    (error) => {
      assert.equal(error.status, 502);
      return true;
    },
  );

  const malformed = capture(
    new Response("<html>not json</html>", { status: 200 }),
  );
  const broken = createServerRepository({ fetchImpl: malformed.fetchImpl });
  await assert.rejects(() => broken.list(), /无法识别的数据/);

  const offline = createServerRepository({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(() => offline.list(), /无法连接服务器/);
  const stalled = createServerRepository({
    fetchImpl: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  await assert.rejects(() => stalled.list(), /超时/);
});

test("a stalled response body is aborted by the transport timeout", async () => {
  const stalledFetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init.signal.addEventListener(
            "abort",
            () =>
              controller.error(
                new DOMException("aborted", "AbortError"),
              ),
            { once: true },
          );
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const repository = createServerRepository({
    fetchImpl: stalledFetch,
    timeoutMs: 20,
  });
  await assert.rejects(() => repository.list(), /超时/);
  const downloader = createServerRepository({
    fetchImpl: stalledFetch,
    timeoutMs: 20,
  });
  await assert.rejects(() => downloader.exportBackup(), /超时/);
});

test("the request timer is cleared after a failed body read", async () => {
  const activeTimers = () =>
    process._getActiveHandles().filter(
      (handle) => handle.constructor?.name === "Timeout",
    ).length;
  const before = activeTimers();
  const repository = createServerRepository({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("stream broke"));
          },
        }),
        { status: 200 },
      ),
    timeoutMs: 60000,
  });
  await assert.rejects(() => repository.list(), /stream broke/);
  assert.equal(activeTimers(), before);
});

test("401 notifies only for data requests, not login or session probes", async () => {
  let notified = 0;
  const { fetchImpl } = capture(jsonResponse({ error: "需要登录" }, 401));
  const repository = createServerRepository({
    fetchImpl,
    onUnauthorized: () => notified++,
  });
  await assert.rejects(() => repository.list());
  assert.equal(notified, 1);
  await assert.rejects(() => repository.session());
  assert.equal(notified, 1);
  await assert.rejects(() => repository.login("alice", "x".repeat(12)));
  assert.equal(notified, 1);
  await assert.rejects(() => repository.register("alice", "Abc12345"));
  assert.equal(notified, 1);
});

test("registration and capability requests use the public auth endpoints", async () => {
  const { calls, fetchImpl } = capture(url => jsonResponse(url === "/api/auth/options"
    ? { registrationEnabled: true } : { user: { id: "new", username: "new-user" } }, url === "/api/auth/register" ? 201 : 200));
  const repository = createServerRepository({ fetchImpl });
  assert.equal((await repository.authOptions()).registrationEnabled, true);
  assert.equal((await repository.register("new-user", "Abc12345")).user.id, "new");
  assert.equal(calls[1].url, "/api/auth/register"); assert.equal(calls[1].init.headers["X-Calendar-Request"], "1");
  assert.deepEqual(JSON.parse(calls[1].init.body), { username: "new-user", password: "Abc12345" });
});

test("login, session and logout hit the auth endpoints", async () => {
  const { calls, fetchImpl } = capture((url) =>
    url === "/api/auth/login"
      ? jsonResponse({ user: { id: "u1", username: "alice" } })
      : url === "/api/auth/me"
        ? jsonResponse({ user: { id: "u1", username: "alice" } })
        : jsonResponse({ ok: true }),
  );
  const repository = createServerRepository({ fetchImpl });
  const login = await repository.login("alice", "p".repeat(12));
  assert.equal(login.user.username, "alice");
  assert.equal(calls[0].url, "/api/auth/login");
  assert.equal(calls[0].init.headers["X-Calendar-Request"], "1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    username: "alice",
    password: "p".repeat(12),
  });
  const session = await repository.session();
  assert.equal(session.user.id, "u1");
  await repository.logout();
  assert.equal(calls[2].url, "/api/auth/logout");
  assert.equal(calls[2].init.method, "POST");
});

test("AI endpoints send proper methods, CSRF headers, query encoding, and support AbortSignal cancellation", async () => {
  const { calls, fetchImpl } = capture((url, init) => {
    if (url === "/api/ai/status") return jsonResponse({ enabled: true });
    if (url === "/api/ai/config") return jsonResponse({ mode: "custom", hasCustomKey: true });
    if (url.startsWith("/api/ai/weights")) return jsonResponse({ weights: {} });
    if (url === "/api/ai/quick-capture") {
      if (init.signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      return new Promise((resolve, reject) => {
        const payload = JSON.parse(init.body);
        if (payload.text === "wait-and-abort") {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          return;
        }
        resolve(jsonResponse({ drafts: [], warnings: [] }));
      });
    }
    return jsonResponse({ weights: [{ id: "e1", score: 4 }] });
  });
  const repository = createServerRepository({ fetchImpl });

  const status = await repository.aiStatus();
  assert.equal(status.enabled, true);
  assert.equal(calls[0].url, "/api/ai/status");
  assert.equal(calls[0].init.method, "GET");

  await repository.aiGetConfig();
  assert.equal(calls[1].url, "/api/ai/config");
  assert.equal(calls[1].init.method, "GET");

  await repository.aiSetConfig({ mode: "custom", apiKey: "AIzaTest1234" });
  assert.equal(calls[2].url, "/api/ai/config");
  assert.equal(calls[2].init.method, "POST");
  assert.equal(calls[2].init.headers["X-Calendar-Request"], "1");

  await repository.aiWeights();
  assert.equal(calls[3].url, "/api/ai/weights");

  await repository.aiWeights(["id 1", "id/2"]);
  assert.equal(calls[4].url, "/api/ai/weights?ids=id%201%2Cid%2F2");

  await repository.aiQuickCapture({ text: "明天开会" });
  assert.equal(calls[5].url, "/api/ai/quick-capture");
  assert.equal(calls[5].init.method, "POST");
  assert.equal(calls[5].init.headers["X-Calendar-Request"], "1");
  assert.equal(calls[5].init.headers["Content-Type"], "application/json");

  await repository.aiCognitiveWeight({ eventIds: ["e1"] });
  assert.equal(calls[6].url, "/api/ai/cognitive-weight");
  assert.equal(calls[6].init.method, "POST");
  assert.equal(calls[6].init.headers["X-Calendar-Request"], "1");

  const controller = new AbortController();
  const pending = repository.aiQuickCapture(
    { text: "wait-and-abort" },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(() => pending, (error) => {
    assert.equal(error.canceled, true);
    assert.equal(error.name, "AbortError");
    return true;
  });
});
