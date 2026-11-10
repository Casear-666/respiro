import test from "node:test";
import assert from "node:assert/strict";
import { createServerRepository } from "../../src/planner/serverRepository.js";

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
  const { calls, fetchImpl } = capture(jsonResponse([{ id: "1" }]));
  const repository = createServerRepository({ fetchImpl });
  assert.deepEqual(await repository.list(), [{ id: "1" }]);
  assert.equal(calls[0].url, "/api/events");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.headers, undefined);

  await repository.apply({ upserts: [{ id: "1" }], deletes: [] });
  assert.equal(calls[1].url, "/api/events/apply");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers["X-Calendar-Request"], "1");
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    upserts: [{ id: "1" }],
    deletes: [],
  });

  await repository.setSettings({ theme: "dark" });
  assert.equal(calls[2].init.method, "PATCH");
  assert.equal(calls[2].url, "/api/settings");

  const raw = '[{"id":"raw-1"}]';
  await repository.importText(raw);
  assert.equal(calls[3].url, "/api/import");
  assert.equal(calls[3].init.body, raw);
  assert.equal(calls[3].init.headers["X-Calendar-Request"], "1");
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
