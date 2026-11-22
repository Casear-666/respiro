import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, scryptSync } from "node:crypto";
import { openAccountStore } from "../../server/accounts.js";
import { createCalendarServer } from "../../server/app.js";
import { openCalendarDatabase } from "../../desktop/database.js";
import { createDesktopAccounts } from "../../desktop/accounts.js";
import { passwordError, usernameError, registrationError } from "../../shared/auth.js";

const password = "Abc12345";
const event = { id: "local-only", title: "独立本地日程", start: "2026-11-12", end: "2026-11-13", allDay: true };
const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-register-")), cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, addCleanup: close => cleanup.push(close) };
};
async function httpFixture(t, options = {}) {
  const { root, addCleanup } = fixture(t), dataDir = path.join(root, "data");
  const app = createCalendarServer({ dataDir, distDir: root, ...options });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  addCleanup(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (url, body, cookie, extra = {}) => {
    const response = await fetch(`${origin}${url}`, { method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Calendar-Request": "1" }), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0], headers: response.headers };
  };
  return { root, dataDir, origin, api, addCleanup };
}

test("shared registration policy accepts 8–128 characters with a letter and validates confirmation", () => {
  for (const value of [password, "a".repeat(128), "1234567Z", "密码abcd12"]) assert.equal(passwordError(value), "");
  for (const value of ["Abc1234", "a".repeat(129), "12345678", "密码密码密码密码", null, 12345678]) assert.match(passwordError(value), /8–128.*英文字母/);
  assert.equal(usernameError(" User_01 "), "");
  for (const value of ["ab", "a".repeat(65), "user name", "用 户", "用户@名#", {}]) assert.ok(usernameError(value));
  for (const value of ["xijinping", "Xi.Jinping", "xi-jin-ping", "x1j1nping", "mzd", "winnie", "pooh_bear", "tiananmen", "real_xjp_2026",
    "习近平", "習近平", "习-近-平", "毛泽东", "维尼小熊", "六四事件", "李强书记"])
    assert.match(usernameError(value), /不允许使用的词汇/, `expected ${value} blocked`);
  for (const value of ["alice", "mao-fan", "june.li", "winston", "helper", "用户名", "张三丰", "李四强", "王小明_2026"])
    assert.equal(usernameError(value), "", `expected ${value} allowed`);
  assert.match(registrationError("alice", password, "different"), /不一致/);
  assert.equal(registrationError("alice", password, password), "");
  assert.match(registrationError("hujintao", password, password), /不允许使用的词汇/);
});

test("admin creation and registration share password policy; existing passwords keep working", async t => {
  const { root, addCleanup } = fixture(t), filename = path.join(root, "accounts.sqlite");
  const accounts = openAccountStore(filename); addCleanup(() => accounts.close());
  await assert.rejects(() => accounts.createUser("bad", "12345678"), /英文字母/);
  await accounts.createUser("admin-created", password);
  assert.ok(await accounts.authenticate("ADMIN-CREATED", password));
  await accounts.register("long-password", "A".repeat(128));
  await assert.rejects(() => accounts.register("too-long", "A".repeat(129)), /8–128/);
  const salt = Buffer.alloc(16, 1), legacyPassword = "123456789012", hash = scryptSync(legacyPassword, salt, 64);
  const sql = new DatabaseSync(filename);
  sql.prepare("INSERT INTO users VALUES (?,?,?,?)").run(randomUUID(), "legacy", `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`, Date.now());
  sql.close(); assert.ok(await accounts.authenticate("legacy", legacyPassword));
});

test("account and session commit atomically, rollback on session failure, and concurrent names stay unique", async t => {
  const { root, addCleanup } = fixture(t), filename = path.join(root, "accounts.sqlite");
  const accounts = openAccountStore(filename); addCleanup(() => accounts.close());
  const sql = new DatabaseSync(filename); addCleanup(() => sql.close());
  sql.exec("CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'injected session failure'); END");
  await assert.rejects(() => accounts.register("alice", password), /injected session/);
  assert.equal(sql.prepare("SELECT count(*) n FROM users").get().n, 0);
  assert.equal(sql.prepare("SELECT count(*) n FROM sessions").get().n, 0);
  sql.exec("DROP TRIGGER reject_session");
  const results = await Promise.allSettled([accounts.register("Alice", password), accounts.register("alice", password)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
  const result = results.find(r => r.status === "fulfilled").value;
  assert.deepEqual(accounts.session(result.token), result.user);
  assert.equal(sql.prepare("SELECT count(*) n FROM users").get().n, 1);
  const stored = sql.prepare("SELECT password_hash FROM users").get().password_hash;
  assert.match(stored, /^scrypt\$/); assert.equal(stored.includes(password), false);
  assert.notEqual(sql.prepare("SELECT token_hash FROM sessions").get().token_hash, result.token);
});

test("registration rate limits survive reopening and expire; raw addresses are not stored", t => {
  const { root, addCleanup } = fixture(t), filename = path.join(root, "accounts.sqlite");
  let time = Date.now(), accounts = openAccountStore(filename, { now: () => time });
  addCleanup(() => accounts.close());
  for (let i = 0; i < 5; i++) assert.equal(accounts.consumeRegistrationAttempt("198.51.100.9"), true);
  assert.equal(accounts.consumeRegistrationAttempt("198.51.100.9"), false);
  accounts.close(); accounts = openAccountStore(filename, { now: () => time });
  assert.equal(accounts.consumeRegistrationAttempt("198.51.100.9"), false);
  const sql = new DatabaseSync(filename, { readOnly: true });
  assert.equal(sql.prepare("SELECT address_hash FROM registration_attempts").get().address_hash.includes("198.51"), false); sql.close();
  time += 900001; assert.equal(accounts.consumeRegistrationAttempt("198.51.100.9"), true);
});

test("HTTP registration automatically logs in, rejects authenticated switches and isolates schedules", async t => {
  const { api } = await httpFixture(t);
  assert.deepEqual((await api("/api/auth/options")).body, { registrationEnabled: true });
  const first = await api("/api/auth/register", { username: "Alice", password });
  assert.equal(first.status, 201); assert.deepEqual(Object.keys(first.body.user).sort(), ["id", "username"]);
  assert.match(first.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await api("/api/auth/me", undefined, first.cookie)).body.user.id, first.body.user.id);
  const snapshot = (await api("/api/sync/snapshot", undefined, first.cookie)).body;
  assert.deepEqual(snapshot.changes, []);
  await api("/api/sync/push", { epoch: snapshot.epoch, operations: [{ opId: randomUUID(), id: event.id, baseRevision: 0, event }] }, first.cookie);
  assert.equal((await api("/api/auth/register", { username: "other", password }, first.cookie)).status, 409);
  assert.equal((await api("/api/auth/me", undefined, first.cookie)).body.user.id, first.body.user.id);
  const second = await api("/api/auth/register", { username: "Bob", password }); assert.equal(second.status, 201);
  assert.deepEqual((await api("/api/events", undefined, second.cookie)).body, []);
  assert.equal((await api("/api/events", undefined, first.cookie)).body.length, 1);
  await api("/api/auth/logout", {}, first.cookie);
  assert.equal((await api("/api/auth/me", undefined, first.cookie)).status, 401);
  const relogin = await api("/api/auth/login", { username: "alice", password }); assert.equal(relogin.status, 200);
});

test("HTTP malformed requests, invalid passwords, body limits and request origins are rejected", async t => {
  const { api, origin } = await httpFixture(t);
  const missingHeader = await fetch(`${origin}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(missingHeader.status, 403);
  assert.equal((await api("/api/auth/register", { username: "alice", password }, undefined, { Origin: "https://other.example" })).status, 403);
  assert.equal((await api("/api/auth/register", { username: "alice", password: "a".repeat(9000) })).status, 413);
  for (const body of [null, { username: "alice", password: "12345678" }, { username: "alice", password: "Abc1234" }, { username: "alice", password: "a".repeat(129) }])
    assert.equal((await api("/api/auth/register", body)).status, 400);
  assert.equal((await api("/api/auth/register", { username: "alice", password: "A".repeat(128) })).status, 201);
});

test("HTTP registration rejects blocked usernames across separator and leetspeak variants", async t => {
  const { api } = await httpFixture(t);
  for (const username of ["xijinping", "习近平", "tankman"])
    assert.equal((await api("/api/auth/register", { username, password })).status, 400, `expected ${username} rejected`);
  const rejected = await api("/api/auth/register", { username: "xi-jin-ping", password });
  assert.equal(rejected.status, 400); assert.match(rejected.body.error, /不允许使用的词汇/);
  const accepted = await api("/api/auth/register", { username: "张三丰", password });
  assert.equal(accepted.status, 201); assert.equal(accepted.body.user.username, "张三丰");
});

test("concurrent HTTP registrations and lost response retries create exactly one account", async t => {
  const { api, dataDir } = await httpFixture(t);
  const results = await Promise.all([api("/api/auth/register", { username: "same", password }), api("/api/auth/register", { username: "SAME", password })]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal((await api("/api/auth/register", { username: "same", password })).status, 409);
  assert.equal((await api("/api/auth/login", { username: "same", password })).status, 200);
  const sql = new DatabaseSync(path.join(dataDir, "accounts.sqlite"), { readOnly: true });
  assert.equal(sql.prepare("SELECT count(*) n FROM users").get().n, 1); sql.close();
});

test("registration can be disabled while existing accounts and administrator creation still work", async t => {
  const { api, dataDir } = await httpFixture(t, { allowRegistration: false });
  assert.deepEqual((await api("/api/auth/options")).body, { registrationEnabled: false });
  assert.equal((await api("/api/auth/register", { username: "new", password })).status, 403);
  const accounts = openAccountStore(path.join(dataDir, "accounts.sqlite"));
  await accounts.createUser("admin-made", password); accounts.close();
  assert.equal((await api("/api/auth/login", { username: "admin-made", password })).status, 200);
});

test("trusted loopback proxy uses its appended address; forged earlier forwarding headers cannot evade limits", async t => {
  const { api } = await httpFixture(t, { trustProxy: true });
  for (let i = 0; i < 5; i++) assert.equal((await api("/api/auth/register", { username: "bad", password: "12345678" }, undefined,
    { "X-Forwarded-For": `192.0.2.${i + 1}, 198.51.100.9` })).status, 400);
  const limited = await api("/api/auth/register", { username: "alice", password }, undefined, { "X-Forwarded-For": "192.0.2.99, 198.51.100.9" });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "900");
  assert.equal((await api("/api/auth/register", { username: "alice", password }, undefined, { "X-Forwarded-For": "198.51.100.10" })).status, 201);
});

test("desktop registration creates isolated profiles, optionally merges with backup, and recovers by login", async t => {
  const { root, origin, api, addCleanup } = await httpFixture(t);
  const local = openCalendarDatabase(path.join(root, "desktop", "calendar.sqlite")); addCleanup(() => local.close()); local.apply({ upserts: [event] });
  const manager = createDesktopAccounts({ dataPath: path.join(root, "desktop"), localDatabase: local }); addCleanup(() => manager.close());
  assert.equal((await manager.authOptions({ origin })).registrationEnabled, true);
  await manager.register({ origin, username: "cloud-only", password }); await manager.run();
  assert.deepEqual(manager.database().list(), []); assert.equal(local.list().length, 1);
  await assert.rejects(() => manager.register({ origin, username: "switch", password }), /先退出/);
  await manager.logout(); await manager.register({ origin, username: "merged", password, mergeLocal: true }); await manager.run();
  assert.equal(manager.database().list().length, 1); assert.equal(local.list().length, 1);
  assert.equal(fs.readdirSync(path.join(root, "desktop", "backups", "before-first-sync")).length, 1);
  const login = await api("/api/auth/login", { username: "merged", password });
  assert.equal((await api("/api/events", undefined, login.cookie)).body.length, 1);
  await manager.logout(); await assert.rejects(() => manager.register({ origin, username: "cloud-only", password }), /已被使用/);
  assert.equal(manager.database(), local);
  await manager.login({ origin, username: "cloud-only", password }); await manager.run(); assert.deepEqual(manager.database().list(), []);
});

test("desktop invalid and offline registration leave the local calendar and login state untouched", async t => {
  const { root, addCleanup } = fixture(t), local = openCalendarDatabase(path.join(root, "calendar.sqlite")); addCleanup(() => local.close());
  local.apply({ upserts: [event] }); let calls = 0;
  const manager = createDesktopAccounts({ dataPath: root, localDatabase: local, fetchImpl: async () => { calls++; throw new TypeError("offline"); } }); addCleanup(() => manager.close());
  await assert.rejects(() => manager.register({ origin: "http://127.0.0.1:3001", username: "alice", password: "12345678" }), /英文字母/);
  assert.equal(calls, 0);
  await assert.rejects(() => manager.register({ origin: "http://127.0.0.1:3001", username: "alice", password }), /offline/);
  assert.equal(manager.info().phase, "local"); assert.equal(local.list().length, 1);
  assert.equal(fs.existsSync(path.join(root, "sync-session.json")), false); assert.equal(fs.existsSync(path.join(root, "profiles")), false);
});
