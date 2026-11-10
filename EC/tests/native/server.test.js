import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCalendarServer } from "../../server/app.js";
import { openAccountStore } from "../../server/accounts.js";
import { DatabaseSync } from "node:sqlite";

const event = {
  id: "shared-id",
  title: "云端日程",
  start: "2026-10-20T09:00:00+08:00",
  end: "2026-10-20T10:00:00+08:00",
  tag: "work",
};

const boot = async (instance) => {
  await new Promise((resolve) =>
    instance.server.listen(0, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${instance.server.address().port}`;
};

const withServer = async (callback, options = {}) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "calendar-server-test-"),
  );
  const dataDir = path.join(directory, "data");
  const distDir = path.join(directory, "dist");
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(distDir, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
  );
  fs.writeFileSync(path.join(distDir, "assets", "app.js"), "console.log(1)\n");
  fs.writeFileSync(path.join(directory, "secret.txt"), "outside dist\n");
  let nowValue = options.nowValue ?? 1_700_000_000_000;
  const now = () => nowValue;
  const store = openAccountStore(path.join(dataDir, "accounts.sqlite"), {
    now,
  });
  const alice = await store.createUser("alice", "correct horse battery");
  const bob = await store.createUser("bob", "another long passphrase");
  store.close();
  const { store: _ignored, now: _ignoredNow, ...rest } = options;
  const instance = createCalendarServer({
    dataDir,
    distDir,
    secureCookies: false,
    ...rest,
    now,
  });
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
        body === undefined || typeof body !== "string"
          ? body === undefined
            ? undefined
            : JSON.stringify(body)
          : body,
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
    return { response, cookie, setCookie };
  };
  try {
    await callback({
      directory,
      dataDir,
      distDir,
      base,
      alice,
      bob,
      api,
      login,
      instance,
      advance: (ms) => {
        nowValue += ms;
      },
      reopen: async () => {
        await instances[instances.length - 1].close();
        const next = createCalendarServer({ dataDir, distDir, ...rest, now });
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

test("data endpoints require auth and reject malformed or hostile requests", () =>
  withServer(async ({ api, login, base }) => {
    for (const [method, pathname] of [
      ["GET", "/api/events"],
      ["POST", "/api/events/apply"],
      ["GET", "/api/settings"],
      ["PATCH", "/api/settings"],
      ["POST", "/api/import"],
      ["GET", "/api/export"],
      ["GET", "/api/auth/me"],
      ["GET", "/api/info"],
    ]) {
      const response = await api(pathname, {
        method,
        body: method === "GET" ? undefined : {},
      });
      assert.equal(response.status, 401, `${method} ${pathname}`);
      const data = await response.json();
      assert.equal(typeof data.error, "string");
    }
    const badLogin = await login("alice", "wrong password value");
    assert.equal(badLogin.response.status, 401);
    const { response, cookie, setCookie } = await login();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.username, "alice");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
    assert.match(setCookie, /Max-Age=604800/i);
    assert.doesNotMatch(setCookie, /Secure/i);
    const noHeader = await fetch(`${base}/api/events/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    });
    assert.equal(noHeader.status, 403);
    const cross = await api("/api/events/apply", {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
      body: {},
    });
    assert.equal(cross.status, 403);
    const malformed = await api("/api/events/apply", {
      method: "POST",
      headers: { cookie },
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    const unknown = await api("/api/unknown", { headers: { cookie } });
    assert.equal(unknown.status, 404);
    assert.equal(typeof (await unknown.json()).error, "string");
    const method = await api("/api/events", {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(method.status, 405);
  }));

test("a streamed body over 20 MiB is refused with a 413 response", () =>
  withServer(async ({ login, base }) => {
    const { cookie } = await login();
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 21; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await fetch(`${base}/api/import`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-calendar-request": "1",
          cookie,
        },
        body: stream,
        duplex: "half",
      },
    );
    assert.equal(response.status, 413);
    assert.equal(typeof (await response.json()).error, "string");
  }));

test("calendar CRUD, settings, import and export survive restart and isolate users", () =>
  withServer(async ({ api, login, dataDir, alice, reopen }) => {
    const { cookie } = await login();
    const authed = { cookie };
    let response = await api("/api/events/apply", {
      method: "POST",
      headers: authed,
      body: { upserts: [event] },
    });
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal((await (await api("/api/events", { headers: authed })).json()).length, 1);
    response = await api("/api/settings", {
      method: "PATCH",
      headers: authed,
      body: { theme: "dark", workEnd: "24:00" },
    });
    assert.deepEqual(await response.json(), { ok: true });
    for (const patch of [
      { unknown: 1 },
      { theme: "blue" },
      { weekStart: 7 },
      { showWeekends: "yes" },
      { workStart: "25:00" },
      { workStart: "10:00", workEnd: "09:00" },
      [1, 2],
      JSON.parse('{"__proto__":{}}'),
      { constructor: "x" },
      { toString: "x" },
    ]) {
      const failed = await api("/api/settings", {
        method: "PATCH",
        headers: authed,
        body: patch,
      });
      assert.equal(failed.status, 400, JSON.stringify(patch));
    }
    response = await api("/api/events/apply", {
      method: "POST",
      headers: authed,
      body: {
        upserts: [{ ...event, id: "ok-2" }, { ...event, id: "bad", end: "bad" }],
      },
    });
    assert.equal(response.status, 400);
    assert.equal((await (await api("/api/events", { headers: authed })).json()).length, 1);
    const backupDir = path.join(dataDir, "users", alice.id, "backups");
    const before = fs.readdirSync(backupDir);
    const imported = await api("/api/import", {
      method: "POST",
      headers: authed,
      body: JSON.stringify([
        event,
        { ...event, title: "内容不同的同编号日程" },
        { ...event, id: "other", title: "另一条" },
      ]),
    });
    assert.deepEqual(await imported.json(), { added: 2, skipped: 1 });
    const snapshots = fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith("before-import-"));
    assert.ok(snapshots.length > before.filter((n) => n.startsWith("before-import-")).length);
    const rows = await (await api("/api/events", { headers: authed })).json();
    assert.equal(rows.length, 3);
    assert.notEqual(
      rows.find((row) => row.title === "内容不同的同编号日程").id,
      event.id,
    );
    const exported = await api("/api/export", { headers: authed });
    assert.match(
      exported.headers.get("content-disposition") || "",
      /attachment/,
    );
    const backup = JSON.parse(await exported.text());
    assert.equal(backup.events.length, 3);
    const bobLogin = await login("bob", "another long passphrase");
    const bobAuth = { cookie: bobLogin.cookie };
    assert.deepEqual(await (await api("/api/events", { headers: bobAuth })).json(), []);
    await api("/api/events/apply", {
      method: "POST",
      headers: bobAuth,
      body: { upserts: [{ ...event, title: "鲍勃的同名编号日程" }] },
    });
    await api("/api/events/apply", {
      method: "POST",
      headers: bobAuth,
      body: { deletes: [event.id] },
    });
    assert.deepEqual(await (await api("/api/events", { headers: bobAuth })).json(), []);
    assert.equal((await (await api("/api/events", { headers: authed })).json()).length, 3);
    const observer = new DatabaseSync(
      path.join(dataDir, "users", alice.id, "calendar.sqlite"),
    );
    try {
      observer.exec(`CREATE TRIGGER reject_http_insert BEFORE INSERT ON events
        WHEN NEW.id = 'reject-http' BEGIN SELECT RAISE(ABORT, 'injected sqlite failure'); END;`);
      const rejectedWrite = await api("/api/events/apply", {
        method: "POST",
        headers: authed,
        body: { upserts: [{ ...event, id: "reject-http", title: "注入失败" }] },
      });
      assert.equal(rejectedWrite.status, 500);
      const failure = await rejectedWrite.json();
      assert.equal(failure.error, "服务器内部错误");
      assert.doesNotMatch(failure.error, /injected|sqlite/i);
      assert.equal((await (await api("/api/events", { headers: authed })).json()).length, 3);
    } finally {
      observer.exec("DROP TRIGGER IF EXISTS reject_http_insert");
      observer.close();
    }
    const base2 = await reopen();
    assert.ok(base2.startsWith("http://127.0.0.1:"));
    const relogin = await login();
    const auth2 = { cookie: relogin.cookie };
    assert.equal((await (await api("/api/events", { headers: auth2 })).json()).length, 3);
    assert.equal((await (await api("/api/settings", { headers: auth2 })).json()).theme, "dark");
  }));

test("sessions revoke, expire, and logins are rate limited by injected time", () =>
  withServer(async ({ api, login, advance }) => {
    const { cookie } = await login();
    const out = await api("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
      body: {},
    });
    assert.deepEqual(await out.json(), { ok: true });
    assert.match(out.headers.getSetCookie()[0] || "", /Max-Age=0/);
    assert.equal((await api("/api/events", { headers: { cookie } })).status, 401);
    const second = await login();
    advance(8 * 24 * 60 * 60 * 1000);
    assert.equal(
      (await api("/api/auth/me", { headers: { cookie: second.cookie } })).status,
      401,
    );
    for (let i = 0; i < 10; i++) {
      const attempt = await login("alice", "wrong password value");
      assert.equal(attempt.response.status, 401, `attempt ${i + 1}`);
    }
    const limited = await login("alice", "wrong password value");
    assert.equal(limited.response.status, 429);
    advance(61 * 1000);
    const again = await login();
    assert.equal(again.response.status, 200);
  }));

test("static serving injects the runtime flag and blocks traversal", () =>
  withServer(async ({ api }) => {
    const home = await api("/");
    const html = await home.text();
    const scriptIndex = html.indexOf('<script src="/api/runtime.js">');
    const moduleIndex = html.indexOf('<script type="module"');
    assert.ok(scriptIndex > -1);
    assert.ok(moduleIndex > scriptIndex);
    assert.match(
      home.headers.get("cache-control") || "",
      /no-store/,
    );
    const runtime = await api("/api/runtime.js");
    assert.equal(await runtime.text(), "globalThis.__CALENDAR_SERVER__ = true;");
    for (const pathname of ["/index.html", "/%69ndex.html"]) {
      const index = await api(pathname);
      assert.equal(index.status, 200, pathname);
      const indexHtml = await index.text();
      const runtimePos = indexHtml.indexOf(
        '<script src="/api/runtime.js">',
      );
      const modulePos = indexHtml.indexOf('<script type="module"');
      assert.ok(runtimePos > -1, pathname);
      assert.ok(modulePos > runtimePos, pathname);
      assert.match(
        index.headers.get("cache-control") || "",
        /no-store/,
        pathname,
      );
    }
    const head = await api("/index.html", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.match(head.headers.get("cache-control") || "", /no-store/);
    const asset = await api("/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") || "", /javascript/);
    assert.match(asset.headers.get("cache-control") || "", /immutable/);
    for (const pathname of [
      "/missing.js",
      "/.env.server",
      "/%2e%2e/secret.txt",
      "/%2e%2e/data/accounts.sqlite",
      "/../secret.txt",
      "/secret.txt",
    ]) {
      const response = await api(pathname);
      assert.notEqual(response.status, 200, pathname);
      assert.notEqual(await response.text(), "outside dist\n");
    }
    const spa = await api("/app/anything");
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /runtime\.js/);
    const write = await api("/", { method: "POST" });
    assert.equal(write.status, 405);
  }));
