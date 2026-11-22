import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCalendarServer } from "../../server/app.js";
import { openAccountStore } from "../../server/accounts.js";
import { normalizeEvent } from "../../shared/domain.js";
import { COGNITIVE_LEVELS } from "../../server/ai.js";

const boot = async (instance) => {
  await new Promise((resolve) =>
    instance.server.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${instance.server.address().port}`;
};

const withAiServer = async (callback, options = {}) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "calendar-ai-test-"),
  );
  const dataDir = path.join(directory, "data");
  const distDir = path.join(directory, "dist");
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(distDir, "index.html"),
    "<!doctype html><html><head><title>fixture</title></head><body></body></html>",
  );
  let nowValue = options.nowValue ?? 1_795_150_000_000;
  const now = () => nowValue;
  const store = openAccountStore(path.join(dataDir, "accounts.sqlite"), {
    now,
  });
  const alice = await store.createUser("alice", "correct horse battery");
  const bob = await store.createUser("bob", "another long passphrase");
  store.close();

  const serverOptions = {
    dataDir,
    distDir,
    secureCookies: false,
    ai: options.ai ?? {},
    aiRateLimit: options.aiRateLimit ?? 30,
    now,
  };
  const instance = createCalendarServer(serverOptions);
  const instances = [instance];
  let base = await boot(instance);

  const api = (pathname, { method = "GET", body, headers = {} } = {}) =>
    fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(body !== undefined
          ? {
              "content-type": "application/json",
              "x-calendar-request": "1",
            }
          : {}),
        ...headers,
      },
      body:
        body === undefined || typeof body === "string"
          ? body
          : JSON.stringify(body),
    });

  const login = async (
    username = "alice",
    password = "correct horse battery",
  ) => {
    const response = await api("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    const setCookie = response.headers.getSetCookie()[0] || "";
    const cookie = setCookie.split(";")[0];
    return { response, cookie };
  };

  const applyEvents = async (headers, { upserts = [], deletes = [] }) => {
    const snapshot = await (
      await api("/api/sync/snapshot", { headers })
    ).json();
    const versions = new Map(
      snapshot.changes.map((c) => [c.id, c.revision]),
    );
    return api("/api/sync/push", {
      method: "POST",
      headers,
      body: {
        epoch: snapshot.epoch,
        operations: [
          ...upserts.map((event) => ({ id: event.id, event })),
          ...deletes.map((id) => ({ id, event: null })),
        ].map((op) => ({
          ...op,
          opId: randomUUID(),
          baseRevision: versions.get(op.id) ?? 0,
        })),
      },
    });
  };

  try {
    await callback({
      directory,
      dataDir,
      base,
      alice,
      bob,
      api,
      login,
      applyEvents,
      advance: (ms) => {
        nowValue += ms;
      },
      reopen: async (nextAi = serverOptions.ai) => {
        await instances[instances.length - 1].close();
        const next = createCalendarServer({
          ...serverOptions,
          ai: nextAi,
        });
        instances.push(next);
        base = await boot(next);
        return base;
      },
    });
  } finally {
    for (const item of instances) await item.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const jsonFetchResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const contentOf = (body) => body.input?.[0]?.content ?? [];

test("disabled mode reports enabled=false and rejects AI generation with 503", () =>
  withAiServer(async ({ api, login }) => {
    const { cookie } = await login();
    const headers = { cookie };

    const info = await (await api("/api/info", { headers })).json();
    assert.equal(info.aiEnabled, false);

    const statusRes = await api("/api/ai/status", { headers });
    assert.equal(statusRes.status, 200);
    assert.deepEqual(await statusRes.json(), {
      enabled: false,
      capabilities: {
        quickCapture: false,
        voiceTranscribe: false,
        cognitiveWeight: false,
      },
      models: {
        capture: "gemini-3.8-flash",
        transcribe: "gemini-3.5-transcribe",
        decision: "gemini-decision-1",
      },
    });

    const weightsRes = await api("/api/ai/weights", { headers });
    assert.equal(weightsRes.status, 200);
    assert.deepEqual(await weightsRes.json(), { weights: {} });

    const captureRes = await api("/api/ai/quick-capture", {
      method: "POST",
      headers,
      body: { text: "明天下午三点开会" },
    });
    assert.equal(captureRes.status, 503);
    assert.equal(typeof (await captureRes.json()).error, "string");

    const weightRes = await api("/api/ai/cognitive-weight", {
      method: "POST",
      headers,
      body: {
        events: [
          {
            id: "ev-1",
            title: "深度架构设计",
            start: "2026-11-21T09:00:00+08:00",
            end: "2026-11-21T12:00:00+08:00",
            tag: "work",
          },
        ],
      },
    });
    assert.equal(weightRes.status, 503);
  }));

test("AI endpoints enforce authentication, X-Calendar-Request header and same-origin", () =>
  withAiServer(
    async ({ api, login, base }) => {
      for (const [method, pathname] of [
        ["GET", "/api/ai/status"],
        ["GET", "/api/ai/weights"],
        ["POST", "/api/ai/quick-capture"],
        ["POST", "/api/ai/cognitive-weight"],
      ]) {
        const res = await api(pathname, {
          method,
          body: method === "POST" ? {} : undefined,
        });
        assert.equal(res.status, 401, `${method} ${pathname}`);
      }

      const { cookie } = await login();
      for (const pathname of ["/api/ai/quick-capture", "/api/ai/cognitive-weight"]) {
        const noCsrf = await fetch(`${base}${pathname}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
          },
          body: JSON.stringify({ text: "test" }),
        });
        assert.equal(noCsrf.status, 403, `missing header ${pathname}`);

        const badOrigin = await api(pathname, {
          method: "POST",
          headers: { cookie, origin: "https://evil.example" },
          body: { text: "test" },
        });
        assert.equal(badOrigin.status, 403, `foreign origin ${pathname}`);
      }
    },
    { ai: { apiKey: "test-key" } },
  ));

test("quick-capture text uses Gemini 3.8 Flash Interactions REST API and returns normalized drafts", () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return jsonFetchResponse({
      id: "int-1",
      status: "completed",
      steps: [
        {
          type: "thought",
          summary: "thinking...",
          signature: "sig-1",
        },
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                events: [
                  {
                    title: "产品需求评审",
                    start: "2026-11-21T15:00:00+08:00",
                    end: "2026-11-21T16:30:00+08:00",
                    allDay: false,
                    tag: "meeting",
                    description: "二楼会议室",
                  },
                ],
                warnings: ["已按东八区时间安排在明天下午。"],
              }),
            },
          ],
        },
      ],
    });
  };

  return withAiServer(
    async ({ api, login }) => {
      const { cookie } = await login();
      const headers = { cookie };
      const status = await (await api("/api/ai/status", { headers })).json();
      assert.equal(status.enabled, true);

      const res = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: {
          text: "明天下午3点到4点半在二楼开产品需求评审",
          referenceDate: "2026-11-20T13:30:00+08:00",
          timezone: "Asia/Shanghai",
          utcOffset: "+08:00",
        },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].url,
        "https://generativelanguage.googleapis.com/v1/interactions",
      );
      assert.equal(calls[0].init.headers["x-goog-api-key"], "secret-test-key");
      assert.equal(calls[0].init.headers["Api-Revision"], "2026-05-20");

      const sent = calls[0].body;
      assert.equal(sent.model, "gemini-3.8-flash");
      assert.equal(sent.store, false);
      assert.equal(sent.input[0].type, "user_input");
      assert.equal(sent.input[0].content[0].type, "text");
      assert.equal(sent.response_format.type, "text");
      assert.equal(sent.response_format.mime_type, "application/json");
      assert.equal(typeof sent.response_format.schema, "object");
      assert.equal(sent.generation_config?.temperature, undefined);
      assert.equal(sent.generation_config?.top_p, undefined);
      assert.equal(sent.generation_config?.top_k, undefined);
      assert.notEqual(sent.generation_config?.thinking_level, "minimal");

      assert.equal(data.transcript, null);
      assert.equal(data.drafts.length, 1);
      assert.doesNotThrow(() => normalizeEvent(data.drafts[0]));
      assert.equal(data.drafts[0].title, "产品需求评审");
      assert.equal(data.drafts[0].tag, "meeting");
      assert.equal(data.drafts[0].allDay, false);
      assert.deepEqual(data.warnings, ["已按东八区时间安排在明天下午。"]);
      assert.deepEqual(data.models, {
        capture: "gemini-3.8-flash",
        transcribe: null,
      });
    },
    { ai: { apiKey: "secret-test-key", fetchImpl } },
  );
});

test("quick-capture supports image data URLs and voice transcription via gemini-3.5-transcribe", () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (body.model === "gemini-3.5-transcribe") {
      return jsonFetchResponse({
        id: "tr-1",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: "周五早上九点半和设计师碰头一小时" }],
          },
        ],
      });
    }
    return jsonFetchResponse({
      id: "cap-1",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                events: [
                  {
                    title: "和设计师碰头",
                    start: "2026-11-27T09:30:00+08:00",
                    end: "2026-11-27T10:30:00+08:00",
                    allDay: false,
                    tag: "meeting",
                    description: "结合截图与语音确认方案",
                  },
                ],
                warnings: [],
              }),
            },
          ],
        },
      ],
    });
  };

  return withAiServer(
    async ({ api, login }) => {
      const { cookie } = await login();
      const headers = { cookie };

      const pngBytes = Buffer.from("fake-png-content").toString("base64");
      const audioBytes = Buffer.from("fake-webm-opus-audio").toString("base64");

      const res = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: {
          text: "看下这张飞书截图",
          image: {
            data: `data:image/png;base64,${pngBytes}`,
            mimeType: "image/png",
          },
          audio: {
            data: audioBytes,
            mimeType: "audio/webm;codecs=opus",
          },
          languageCodes: ["cmn-Hans-CN"],
        },
      });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(calls.length, 2);
      assert.equal(calls[0].body.model, "gemini-3.5-transcribe");
      assert.equal(calls[0].body.input[0].type, "user_input");
      assert.deepEqual(contentOf(calls[0].body), [
        { type: "audio", data: audioBytes, mime_type: "audio/webm" },
      ]);
      assert.deepEqual(calls[0].body.generation_config, {
        transcription_config: {
          mode: "smart",
          language_codes: ["cmn-Hans-CN"],
        },
      });

      assert.equal(calls[1].body.model, "gemini-3.8-flash");
      assert.equal(calls[1].body.input[0].type, "user_input");
      assert.equal(contentOf(calls[1].body)[0].type, "image");
      assert.equal(contentOf(calls[1].body)[0].data, pngBytes);
      assert.equal(contentOf(calls[1].body)[0].mime_type, "image/png");
      assert.match(contentOf(calls[1].body)[1].text, /周五早上九点半和设计师碰头一小时/);

      assert.equal(data.transcript, "周五早上九点半和设计师碰头一小时");
      assert.equal(data.drafts.length, 1);
      assert.equal(data.drafts[0].title, "和设计师碰头");
      assert.deepEqual(data.models, {
        capture: "gemini-3.8-flash",
        transcribe: "gemini-3.5-transcribe",
      });
    },
    { ai: { apiKey: "secret-test-key", fetchImpl } },
  );
});

test("quick-capture repairs single-day allDay end dates, skips bad drafts, and validates bad inputs", () => {
  const fetchImpl = async () =>
    jsonFetchResponse({
      id: "cap-edge",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text:
                "```json\n" +
                JSON.stringify({
                  events: [
                    {
                      title: "公司周年庆",
                      start: "2026-12-01",
                      end: "2026-12-01",
                      allDay: true,
                      tag: "other",
                    },
                    {
                      title: "时间倒挂的错误草稿",
                      start: "2026-12-02T15:00:00+08:00",
                      end: "2026-12-02T14:00:00+08:00",
                      allDay: false,
                      tag: "work",
                    },
                  ],
                  warnings: [],
                }) +
                "\n```",
            },
          ],
        },
      ],
    });

  return withAiServer(
    async ({ api, login }) => {
      const { cookie } = await login();
      const headers = { cookie };

      const emptyRes = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: { text: "   " },
      });
      assert.equal(emptyRes.status, 400);

      const badMime = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: {
          image: { data: "Zm9v", mimeType: "application/x-msdownload" },
        },
      });
      assert.equal(badMime.status, 400);

      const badBase64 = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: {
          audio: { data: "not!valid!base64", mimeType: "audio/mp3" },
        },
      });
      assert.equal(badBase64.status, 400);

      const res = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: { text: "12月1日公司周年庆全天" },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.drafts.length, 1);
      assert.equal(data.drafts[0].allDay, true);
      assert.equal(data.drafts[0].start, "2026-12-01");
      assert.equal(data.drafts[0].end, "2026-12-02");
      assert.ok(
        data.warnings.some((w) => w.includes("已跳过无效日程草稿")),
        `expected skipped warning, got ${JSON.stringify(data.warnings)}`,
      );
    },
    { ai: { apiKey: "secret-test-key", fetchImpl } },
  );
});

test("cognitive-weight batches via v1beta/decisions, distinguishes 8h deep work vs 5m errand, and caches across restarts & user isolation", () => {
  const decisionCalls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    decisionCalls.push({ url, init, body });
    const answers = {};
    for (const [key, q] of Object.entries(body.questions)) {
      if (q.instructions.includes("8小时")) {
        answers[key] = {
          type: "score",
          probabilities: [0.01, 0.02, 0.07, 0.25, 0.65],
          confidence: 0.91,
        };
      } else if (q.instructions.includes("取快递")) {
        answers[key] = {
          type: "score",
          probabilities: [0.2, 0.65, 0.1, 0.04, 0.01],
          confidence: 0.88,
        };
      } else {
        answers[key] = {
          type: "score",
          probabilities: [0.02, 0.08, 0.6, 0.25, 0.05],
          confidence: 0.8,
        };
      }
    }
    return jsonFetchResponse({ answers });
  };

  const deepWork = {
    id: "deep-8h",
    title: "8小时架构重构攻坚",
    start: "2026-11-20T09:00:00+08:00",
    end: "2026-11-20T17:00:00+08:00",
    tag: "work",
    description: "核心引擎重写与性能压测",
  };
  const errand = {
    id: "errand-5m",
    title: "楼下取快递",
    start: "2026-11-20T17:10:00+08:00",
    end: "2026-11-20T17:15:00+08:00",
    tag: "personal",
    description: "",
  };

  return withAiServer(
    async ({ api, login, applyEvents, reopen }) => {
      const aliceAuth = { cookie: (await login("alice")).cookie };
      const bobAuth = {
        cookie: (await login("bob", "another long passphrase")).cookie,
      };

      await applyEvents(aliceAuth, { upserts: [deepWork, errand] });
      await applyEvents(bobAuth, {
        upserts: [{ ...deepWork, id: "bob-event", title: "鲍勃的会议" }],
      });

      const res1 = await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers: aliceAuth,
        body: { events: [deepWork, errand] },
      });
      assert.equal(res1.status, 200);
      const data1 = await res1.json();

      assert.equal(decisionCalls.length, 1);
      assert.equal(
        decisionCalls[0].url,
        "https://generativelanguage.googleapis.com/v1beta/decisions",
      );
      assert.equal(decisionCalls[0].body.model, "gemini-decision-1");
      assert.equal(
        decisionCalls[0].body.questions.e_0.type,
        "score",
      );
      assert.deepEqual(
        decisionCalls[0].body.questions.e_0.criteria,
        COGNITIVE_LEVELS.map((l) => l.criteria),
      );

      assert.equal(data1.evaluated, 2);
      assert.equal(data1.cacheHits, 0);
      assert.equal(data1.weights[0].id, "deep-8h");
      assert.equal(data1.weights[0].score, 5);
      assert.equal(data1.weights[0].label, "高压攻坚");
      assert.equal(data1.weights[1].id, "errand-5m");
      assert.equal(data1.weights[1].score, 2);
      assert.equal(data1.weights[1].label, "轻量事务");
      assert.ok(data1.weights[0].expectedScore > data1.weights[1].expectedScore);

      // Second call hits cache with zero extra Gemini calls
      const res2 = await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers: aliceAuth,
        body: { eventIds: ["deep-8h", "errand-5m"] },
      });
      const data2 = await res2.json();
      assert.equal(decisionCalls.length, 1);
      assert.equal(data2.cacheHits, 2);
      assert.equal(data2.evaluated, 0);

      // Moving to another day without changing duration or text still hits cache
      const movedDeepWork = {
        ...deepWork,
        start: "2026-11-24T09:00:00+08:00",
        end: "2026-11-24T17:00:00+08:00",
      };
      await applyEvents(aliceAuth, { upserts: [movedDeepWork] });
      const resMoved = await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers: aliceAuth,
        body: { eventIds: ["deep-8h"] },
      });
      const dataMoved = await resMoved.json();
      assert.equal(decisionCalls.length, 1);
      assert.equal(dataMoved.cacheHits, 1);
      assert.equal(dataMoved.evaluated, 0);

      // Reopen server: SQLite cache persists
      await reopen();
      const aliceReauth = { cookie: (await login("alice")).cookie };
      const bobReauth = {
        cookie: (await login("bob", "another long passphrase")).cookie,
      };
      const persisted = await (
        await api("/api/ai/weights", { headers: aliceReauth })
      ).json();
      assert.equal(persisted.weights["deep-8h"].score, 5);
      assert.equal(persisted.weights["errand-5m"].score, 2);

      // Query filter ?ids=...
      const filtered = await (
        await api("/api/ai/weights?ids=errand-5m", { headers: aliceReauth })
      ).json();
      assert.deepEqual(Object.keys(filtered.weights), ["errand-5m"]);

      // User isolation: Bob sees zero cached weights for Alice
      const bobWeights = await (
        await api("/api/ai/weights", { headers: bobReauth })
      ).json();
      assert.deepEqual(bobWeights.weights, {});

      // Changing duration invalidates fingerprint and triggers re-evaluation
      const shortened = {
        ...movedDeepWork,
        end: "2026-11-24T10:00:00+08:00",
      };
      await applyEvents(aliceReauth, { upserts: [shortened] });
      const staleRemoved = await (
        await api("/api/ai/weights", { headers: aliceReauth })
      ).json();
      assert.equal(staleRemoved.weights["deep-8h"], undefined);
      assert.equal(staleRemoved.weights["errand-5m"].score, 2);

      const reeval = await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers: aliceReauth,
        body: { eventIds: ["deep-8h", "errand-5m"] },
      });
      const reevalData = await reeval.json();
      assert.equal(decisionCalls.length, 2);
      assert.equal(reevalData.cacheHits, 1);
      assert.equal(reevalData.evaluated, 1);

      // force: true bypasses cache
      const forced = await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers: aliceReauth,
        body: { eventIds: ["errand-5m"], force: true },
      });
      const forcedData = await forced.json();
      assert.equal(decisionCalls.length, 3);
      assert.equal(forcedData.cacheHits, 0);
      assert.equal(forcedData.evaluated, 1);

      // Deleted events vanish from /api/ai/weights
      await applyEvents(aliceReauth, { deletes: ["errand-5m"] });
      const afterDelete = await (
        await api("/api/ai/weights", { headers: aliceReauth })
      ).json();
      assert.equal(afterDelete.weights["errand-5m"], undefined);
      assert.equal(afterDelete.weights["deep-8h"].score, 5);
    },
    { ai: { apiKey: "secret-test-key", fetchImpl } },
  );
});

test("maps upstream errors without leaking API key and enforces per-user AI rate limit", () => {
  let mode = "rate429";
  const secretKey = "AIzaSuperSecretKey12345";
  const fetchImpl = async (_url, init) => {
    if (mode === "rate429") {
      return new Response(
        JSON.stringify({ error: { message: `Quota exceeded for ${secretKey}` } }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "25",
          },
        },
      );
    }
    if (mode === "auth401") {
      return jsonFetchResponse(
        { error: { message: `Invalid key ${secretKey}` } },
        401,
      );
    }
    if (mode === "timeout") {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    return jsonFetchResponse({
      id: "ok",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify({ events: [], warnings: [] }) }],
        },
      ],
    });
  };

  return withAiServer(
    async ({ api, login, advance }) => {
      const { cookie } = await login();
      const headers = { cookie };

      mode = "rate429";
      const r429 = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: { text: "明天开会" },
      });
      assert.equal(r429.status, 429);
      assert.equal(r429.headers.get("retry-after"), "25");
      const body429 = await r429.json();
      assert.doesNotMatch(body429.error, /SuperSecretKey/);

      mode = "auth401";
      const r401 = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: { text: "明天开会" },
      });
      assert.equal(r401.status, 502);
      const body401 = await r401.json();
      assert.doesNotMatch(body401.error, /SuperSecretKey/);

      mode = "timeout";
      const rTimeout = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: { text: "明天开会" },
      });
      assert.equal(rTimeout.status, 504);

      // Rate limit check (limit = 3 per minute; already consumed 3 above)
      mode = "ok";
      const limited = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: { text: "明天开会" },
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");

      advance(61 * 1000);
      const recovered = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: { text: "明天开会" },
      });
      assert.equal(recovered.status, 200);
    },
    {
      ai: { apiKey: secretKey, timeoutMs: 40, fetchImpl },
      aiRateLimit: 3,
    },
  );
});

test("supports single-model gemini-3.8-flash inline audio and cognitive scoring fallback", async () => {
  const inlineCalls = [];
  const inlineFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    inlineCalls.push({ url, body });
    if (contentOf(body).some((part) => part.type === "audio")) {
      return jsonFetchResponse({
        id: "inline-audio-1",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  transcript: "明天上午十点代码走查",
                  events: [
                    {
                      title: "代码走查",
                      start: "2026-11-21T10:00:00+08:00",
                      end: "2026-11-21T11:00:00+08:00",
                      allDay: false,
                      tag: "work",
                    },
                  ],
                  warnings: [],
                }),
              },
            ],
          },
        ],
      });
    }
    return jsonFetchResponse({
      id: "inline-weight-1",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                weights: [
                  { index: 0, score: 5, confidence: 0.92 },
                  { index: 1, score: 2, confidence: 0.85 },
                ],
              }),
            },
          ],
        },
      ],
    });
  };

  await withAiServer(
    async ({ api, login }) => {
      const { cookie } = await login();
      const headers = { cookie };
      const audioBytes = Buffer.from("fake-audio-single-call").toString("base64");

      const captureRes = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: {
          audio: { data: audioBytes, mimeType: "audio/webm;codecs=opus" },
        },
      });
      assert.equal(captureRes.status, 200);
      const captureData = await captureRes.json();
      assert.equal(inlineCalls.length, 1);
      assert.equal(inlineCalls[0].body.model, "gemini-3.8-flash");
      assert.equal(inlineCalls[0].body.input[0].type, "user_input");
      assert.equal(contentOf(inlineCalls[0].body)[0].type, "audio");
      assert.equal(contentOf(inlineCalls[0].body)[0].mime_type, "audio/webm");
      assert.equal(captureData.transcript, "明天上午十点代码走查");
      assert.equal(captureData.drafts.length, 1);
      assert.deepEqual(captureData.models, {
        capture: "gemini-3.8-flash",
        transcribe: "gemini-3.8-flash",
      });

      const weightRes = await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers,
        body: {
          events: [
            {
              id: "ev-a",
              title: "8小时架构重构",
              start: "2026-11-20T09:00:00+08:00",
              end: "2026-11-20T17:00:00+08:00",
              tag: "work",
            },
            {
              id: "ev-b",
              title: "取快递",
              start: "2026-11-20T18:00:00+08:00",
              end: "2026-11-20T18:05:00+08:00",
              tag: "personal",
            },
          ],
        },
      });
      assert.equal(weightRes.status, 200);
      const weightData = await weightRes.json();
      assert.equal(inlineCalls.length, 2);
      assert.equal(
        inlineCalls[1].url,
        "https://generativelanguage.googleapis.com/v1/interactions",
      );
      assert.equal(weightData.model, "gemini-3.8-flash");
      assert.equal(weightData.weights[0].score, 5);
      assert.equal(weightData.weights[0].label, "高压攻坚");
      assert.equal(weightData.weights[1].score, 2);
      assert.equal(weightData.weights[1].label, "轻量事务");
    },
    {
      ai: {
        apiKey: "free-tier-key",
        captureModel: "gemini-3.8-flash",
        transcribeModel: "gemini-3.8-flash",
        decisionModel: "gemini-3.8-flash",
        fetchImpl: inlineFetch,
      },
    },
  );

  // Automatic fallback from 404 on transcribe & decisions to gemini-3.8-flash
  const fallbackCalls = [];
  const fallbackFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    fallbackCalls.push({ url, model: body.model });
    if (
      body.model === "gemini-3.5-transcribe" ||
      url.endsWith("/v1beta/decisions")
    ) {
      return jsonFetchResponse(
        { error: { message: "Model not found" } },
        404,
      );
    }
    if (contentOf(body).some((p) => p.type === "audio")) {
      return jsonFetchResponse({
        id: "fb-cap",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  transcript: "降级转写成功",
                  events: [
                    {
                      title: "复盘会",
                      start: "2026-11-22T14:00:00+08:00",
                      end: "2026-11-22T15:00:00+08:00",
                      allDay: false,
                      tag: "meeting",
                    },
                  ],
                  warnings: [],
                }),
              },
            ],
          },
        ],
      });
    }
    return jsonFetchResponse({
      id: "fb-weight",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                weights: [{ index: 0, score: 4, confidence: 0.88 }],
              }),
            },
          ],
        },
      ],
    });
  };

  await withAiServer(
    async ({ api, login, applyEvents }) => {
      const { cookie } = await login();
      const headers = { cookie };
      const audioBytes = Buffer.from("fallback-audio").toString("base64");

      const capRes = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: { audio: { data: audioBytes, mimeType: "audio/mp3" } },
      });
      assert.equal(capRes.status, 200);
      const capData = await capRes.json();
      assert.equal(capData.transcript, "降级转写成功");
      assert.deepEqual(capData.models, {
        capture: "gemini-3.8-flash",
        transcribe: "gemini-3.8-flash",
      });

      const evFb = {
        id: "ev-fb",
        title: "撰写技术方案",
        start: "2026-11-22T09:00:00+08:00",
        end: "2026-11-22T12:00:00+08:00",
        tag: "work",
      };
      await applyEvents(headers, { upserts: [evFb] });

      const wRes = await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers,
        body: { events: [evFb] },
      });
      assert.equal(wRes.status, 200);
      const wData = await wRes.json();
      assert.equal(wData.model, "gemini-3.8-flash");
      assert.equal(wData.weights[0].score, 4);
      assert.equal(wData.weights[0].label, "深度专注");

      const persisted = await (
        await api("/api/ai/weights", { headers })
      ).json();
      assert.equal(persisted.weights["ev-fb"].model, "gemini-3.8-flash");
      assert.deepEqual(
        fallbackCalls.map((c) => c.model),
        [
          "gemini-3.5-transcribe",
          "gemini-3.8-flash",
          "gemini-decision-1",
          "gemini-3.8-flash",
        ],
      );
    },
    { ai: { apiKey: "free-tier-key", fetchImpl: fallbackFetch } },
  );
});

test("per-user AI config supports custom API key/baseUrl vs shared API, masks secrets, and isolates users", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      key: init.headers["x-goog-api-key"],
      body: JSON.parse(init.body),
    });
    if (url.endsWith("/v1beta/decisions")) {
      return jsonFetchResponse({
        answers: {
          e_0: {
            type: "score",
            probabilities: [0.05, 0.1, 0.2, 0.45, 0.2],
            confidence: 0.86,
          },
        },
      });
    }
    return jsonFetchResponse({
      id: "cap-custom",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                events: [
                  {
                    title: "个人密钥测试日程",
                    start: "2026-11-23T10:00:00+08:00",
                    end: "2026-11-23T11:00:00+08:00",
                    allDay: false,
                    tag: "work",
                  },
                ],
                warnings: [],
              }),
            },
          ],
        },
      ],
    });
  };

  // Even when the server has NO shared default API key, a user can configure their own API key.
  await withAiServer(
    async ({ api, login, reopen }) => {
      const aliceAuth = { cookie: (await login("alice")).cookie };
      const bobAuth = {
        cookie: (await login("bob", "another long passphrase")).cookie,
      };

      const initialAlice = await (
        await api("/api/ai/config", { headers: aliceAuth })
      ).json();
      assert.equal(initialAlice.mode, "shared");
      assert.equal(initialAlice.sharedAvailable, false);
      assert.equal(initialAlice.enabled, false);
      assert.equal(initialAlice.hasCustomKey, false);

      // Switching to custom without a key leaves enabled=false and rejects invalid URL
      const badUrlRes = await api("/api/ai/config", {
        method: "POST",
        headers: aliceAuth,
        body: {
          mode: "custom",
          apiKey: "AIzaAliceSecret9999",
          baseUrl: "http://evil.example/proxy",
        },
      });
      assert.equal(badUrlRes.status, 400);

      const savedAliceRes = await api("/api/ai/config", {
        method: "POST",
        headers: aliceAuth,
        body: {
          mode: "custom",
          apiKey: "AIzaAliceSecret9999",
          baseUrl: "https://proxy.alice.example/",
        },
      });
      assert.equal(savedAliceRes.status, 200);
      const savedAlice = await savedAliceRes.json();
      assert.equal(savedAlice.mode, "custom");
      assert.equal(savedAlice.hasCustomKey, true);
      assert.equal(savedAlice.customKeyMask, "AIza••••9999");
      assert.equal(savedAlice.customBaseUrl, "https://proxy.alice.example");
      assert.equal(savedAlice.enabled, true);
      assert.doesNotMatch(JSON.stringify(savedAlice), /AliceSecret/);

      // Bob stays isolated and disabled
      const bobCfg = await (
        await api("/api/ai/config", { headers: bobAuth })
      ).json();
      assert.equal(bobCfg.mode, "shared");
      assert.equal(bobCfg.hasCustomKey, false);
      assert.equal(bobCfg.enabled, false);

      // Reopen server: Alice's custom config persists
      await reopen();
      const aliceReauth = { cookie: (await login("alice")).cookie };
      const statusAfterReopen = await (
        await api("/api/ai/status", { headers: aliceReauth })
      ).json();
      assert.equal(statusAfterReopen.enabled, true);

      const capRes = await api("/api/ai/quick-capture", {
        method: "POST",
        headers: aliceReauth,
        body: { text: "周一上午十点个人密钥测试日程" },
      });
      assert.equal(capRes.status, 200);
      assert.equal(
        calls[0].url,
        "https://proxy.alice.example/v1/interactions",
      );
      assert.equal(calls[0].key, "AIzaAliceSecret9999");

      // Switching Alice back to shared mode preserves her masked key for later, and uses shared state
      const switchedShared = await (
        await api("/api/ai/config", {
          method: "POST",
          headers: aliceReauth,
          body: { mode: "shared" },
        })
      ).json();
      assert.equal(switchedShared.mode, "shared");
      assert.equal(switchedShared.hasCustomKey, true);
      assert.equal(switchedShared.customKeyMask, "AIza••••9999");
      assert.equal(switchedShared.enabled, false);

      // Clearing custom key removes it completely
      const cleared = await (
        await api("/api/ai/config", {
          method: "POST",
          headers: aliceReauth,
          body: { apiKey: "" },
        })
      ).json();
      assert.equal(cleared.hasCustomKey, false);
      assert.equal(cleared.customKeyMask, "");
    },
    { ai: { apiKey: "", fetchImpl } },
  );

  // When server DOES provide a shared API key, switching between custom and shared routes to respective keys
  calls.length = 0;
  await withAiServer(
    async ({ api, login }) => {
      const headers = { cookie: (await login("alice")).cookie };
      await api("/api/ai/config", {
        method: "POST",
        headers,
        body: { mode: "custom", apiKey: "AIzaCustomUserKey1234" },
      });
      await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers,
        body: {
          events: [
            {
              id: "cfg-ev-1",
              title: "深度写作",
              start: "2026-11-23T09:00:00+08:00",
              end: "2026-11-23T11:00:00+08:00",
              tag: "work",
            },
          ],
        },
      });
      assert.equal(calls.at(-1).key, "AIzaCustomUserKey1234");

      await api("/api/ai/config", {
        method: "POST",
        headers,
        body: { mode: "shared" },
      });
      await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers,
        body: {
          force: true,
          events: [
            {
              id: "cfg-ev-1",
              title: "深度写作",
              start: "2026-11-23T09:00:00+08:00",
              end: "2026-11-23T11:00:00+08:00",
              tag: "work",
            },
          ],
        },
      });
      assert.equal(calls.at(-1).key, "ServerSharedDefaultKey");
    },
    { ai: { apiKey: "ServerSharedDefaultKey", fetchImpl } },
  );
});

test("OpenAI-compatible baseUrl (e.g. Alibaba DashScope qwen-plus) uses Bearer auth and /chat/completions", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const content =
      calls.length === 1
        ? JSON.stringify({
            events: [
              {
                title: "需求评审",
                start: "2026-11-23T15:00:00+08:00",
                end: "2026-11-23T16:30:00+08:00",
                allDay: false,
                tag: "work",
              },
            ],
            warnings: [],
          })
        : JSON.stringify({
            weights: [{ index: 0, score: 4, confidence: 0.9 }],
          });
    return jsonFetchResponse({
      id: "chatcmpl-test",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content } }],
      usage: { total_tokens: 42 },
    });
  };

  await withAiServer(
    async ({ api, login }) => {
      const headers = { cookie: (await login("alice")).cookie };
      const captureRes = await api("/api/ai/quick-capture", {
        method: "POST",
        headers,
        body: { text: "明天下午3点到4点半开需求评审" },
      });
      assert.equal(captureRes.status, 200);
      const captureData = await captureRes.json();
      assert.equal(captureData.drafts.length, 1);
      assert.equal(captureData.drafts[0].title, "需求评审");

      const weightRes = await api("/api/ai/cognitive-weight", {
        method: "POST",
        headers,
        body: {
          events: [
            {
              id: "dash-ev-1",
              title: "架构重构",
              start: "2026-11-23T09:00:00+08:00",
              end: "2026-11-23T12:00:00+08:00",
              tag: "work",
            },
          ],
        },
      });
      assert.equal(weightRes.status, 200);
      const weightData = await weightRes.json();
      assert.equal(weightData.weights[0].score, 4);

      assert.equal(calls.length, 2);
      assert.equal(
        calls[0].url,
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      );
      assert.equal(calls[0].headers.Authorization, "Bearer sk-ws-test-key");
      assert.equal(calls[0].headers["x-goog-api-key"], undefined);
      assert.equal(calls[0].body.model, "qwen-plus");
      assert.equal(calls[0].body.response_format?.type, "json_object");
      assert.equal(calls[1].body.model, "qwen-plus");
    },
    {
      ai: {
        apiKey: "sk-ws-test-key",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        captureModel: "qwen-plus",
        transcribeModel: "qwen-plus",
        decisionModel: "qwen-plus",
        fetchImpl,
      },
    },
  );
});
