import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openCalendarDatabase } from "../../desktop/database.js";
import { syncReplica } from "../../desktop/sync-engine.js";
import { createDesktopAccounts, profileKey, validateServerOrigin } from "../../desktop/accounts.js";
import { createCalendarServer } from "../../server/app.js";
import { openAccountStore } from "../../server/accounts.js";
import { createServerRepository } from "../../src/planner/serverRepository.js";

const event = { id: "same-id", title: "日程", start: "2026-11-11", end: "2026-11-12", allDay: true, tag: "work" };
const op = (event, baseRevision = 0, id = event?.id ?? "same-id") => ({ opId: randomUUID(), id, event, baseRevision });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-sync-"));
  const opened = new Set(), cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); for (const db of opened) { try { db.close(); } catch {} } fs.rmSync(root, { force: true, recursive: true }); });
  const open = (name, replica = false) => { const db = openCalendarDatabase(path.join(root, `${name}.sqlite`), { replica }); opened.add(db); return db; };
  return { root, open, addCleanup: close => cleanup.push(close) };
}
const transport = server => async (url, body) => {
  if (url.startsWith("/api/sync/changes")) { const q = new URL(url, "http://test").searchParams; return server.sync.changes({ since: Number(q.get("since")), epoch: q.get("epoch") }); }
  if (url === "/api/sync/push") return server.sync.push(body);
  if (url === "/api/sync/conflicts") return server.sync.conflicts();
  throw new Error(url);
};

test("schema 1 migration preserves events/settings; versions, tombstones and unchanged writes", t => {
  const { root, open } = fixture(t);
  const sql = new DatabaseSync(path.join(root, "old.sqlite"));
  sql.exec("CREATE TABLE events(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1");
  sql.prepare("INSERT INTO events VALUES (?,?)").run(event.id, JSON.stringify(event));
  sql.exec("INSERT INTO settings VALUES ('theme','\"dark\"')"); sql.close();
  const db = open("old");
  const first = db.sync.snapshot(); assert.equal(first.changes.length, 1); assert.equal(db.getSettings().theme, "dark");
  // First normalization is allowed once for a legacy record with omitted fields.
  db.apply({ upserts: [event] }); const head = db.sync.snapshot().cursor;
  db.apply({ upserts: [event] }); assert.equal(db.sync.snapshot().cursor, head);
  db.apply({ deletes: [event.id] }); const change = db.sync.changes({ since: head, epoch: first.epoch });
  assert.equal(change.changes[0].event, null); assert.ok(change.changes[0].revision > head);
  assert.throws(() => db.sync.changes({ since: change.cursor + 1 }), /游标/);
  assert.throws(() => db.sync.changes({ epoch: "wrong" }), /版本/);
});

test("pagination with concurrent updates does not permanently miss an event", t => {
  const db = fixture(t).open("server");
  db.apply({ upserts: Array.from({ length: 205 }, (_, i) => ({ ...event, id: `event-${i}` })) });
  const first = db.sync.changes(); assert.equal(first.changes.length, 100); assert.equal(first.hasMore, true);
  db.apply({ upserts: [{ ...event, id: "event-0", title: "later" }] });
  const second = db.sync.changes({ since: first.cursor, epoch: first.epoch });
  const third = db.sync.changes({ since: second.cursor, epoch: first.epoch });
  assert.equal(third.hasMore, false);
  assert.equal(third.changes.find(c => c.id === "event-0").event.title, "later");
  assert.equal(new Set([...first.changes, ...second.changes, ...third.changes].map(c => c.id)).size, 205);
});

test("receipts survive restart, reject changed IDs, and invalid batches are atomic", t => {
  const { open } = fixture(t); let db = open("server");
  const epoch = db.sync.snapshot().epoch, operation = op(event);
  const first = db.sync.push({ epoch, operations: [operation] }); db.close(); db = open("server");
  assert.deepEqual(db.sync.push({ epoch, operations: [operation] }), first);
  assert.equal(db.sync.snapshot().cursor, first.results[0].revision);
  assert.throws(() => db.sync.push({ epoch, operations: [{ ...operation, event: { ...event, title: "changed" } }] }), /编号/);
  assert.throws(() => db.sync.push({ epoch, operations: [op({ ...event, id: "new" }), op({ ...event, id: "bad", end: "invalid" })] }));
  assert.equal(db.list().length, 1);
});

test("modify/modify and delete/modify preserve both versions; resolution checks and retries", t => {
  const db = fixture(t).open("server"); const epoch = db.sync.snapshot().epoch;
  const a = db.sync.push({ epoch, operations: [op(event)] }).results[0];
  db.sync.push({ epoch, operations: [op({ ...event, title: "cloud" }, a.revision)] });
  const conflict = db.sync.push({ epoch, operations: [op({ ...event, title: "offline" }, a.revision)] }).results[0];
  const deletion = db.sync.push({ epoch, operations: [op(null, a.revision)] }).results[0];
  let conflicts = db.sync.conflicts().conflicts; assert.equal(conflicts.length, 2);
  assert.equal(conflicts.find(c => c.id === conflict.conflictId).localEvent.title, "offline");
  assert.equal(conflicts.find(c => c.id === deletion.conflictId).localEvent, null);
  const request = { epoch, opId: randomUUID(), conflictId: conflict.conflictId, choice: "both", expectedRevision: conflict.revision };
  const result = db.sync.resolve(request); assert.deepEqual(db.sync.resolve(request), result); assert.equal(db.list().length, 2);
  db.apply({ deletes: [event.id] });
  assert.throws(() => db.sync.resolve({ ...request, opId: randomUUID(), conflictId: deletion.conflictId, choice: "remote" }), /再次/);
  conflicts = db.sync.conflicts().conflicts;
  assert.equal(conflicts[0].originalRemoteEvent.title, "cloud"); assert.equal(conflicts[0].remoteEvent, null);
  db.sync.resolve({ ...request, opId: randomUUID(), conflictId: deletion.conflictId, choice: "local", expectedRevision: conflicts[0].remoteRevision });
  assert.equal(db.sync.conflicts().conflicts.length, 0);
});

test("SQL failure or reused receipt rolls back the entire batch and its receipts", t => {
  const { root, open } = fixture(t), db = open("server"), sql = new DatabaseSync(path.join(root, "server.sqlite"));
  try {
    const epoch = db.sync.snapshot().epoch, first = op({ ...event, id: "first" }), second = op({ ...event, id: "reject" });
    sql.exec("CREATE TRIGGER reject_sync BEFORE INSERT ON events WHEN NEW.id='reject' BEGIN SELECT RAISE(ABORT,'test failure'); END");
    assert.throws(() => db.sync.push({ epoch, operations: [first, second] }), /test failure/);
    assert.deepEqual(db.list(), []); assert.equal(db.sync.snapshot().cursor, 0);
    assert.equal(sql.prepare("SELECT count(*) n FROM sync_receipts").get().n, 0);
    sql.exec("DROP TRIGGER reject_sync");
    db.sync.push({ epoch, operations: [first] });
    assert.throws(() => db.sync.push({ epoch, operations: [op({ ...event, id: "rolled-back" }), { ...first, event: { ...first.event, title: "different" } }] }), /编号/);
    assert.equal(db.list().length, 1);
  } finally { sql.close(); }
});

test("a remote deletion versus an offline edit is retained as a conflict", async t => {
  const { open } = fixture(t), server = open("server"), replica = open("replica", true), request = transport(server);
  server.apply({ upserts: [event] }); await syncReplica(replica, request);
  server.apply({ deletes: [event.id] }); replica.apply({ upserts: [{ ...event, title: "kept offline" }] });
  await syncReplica(replica, request);
  const conflict = server.sync.conflicts().conflicts[0];
  assert.equal(conflict.localEvent.title, "kept offline"); assert.equal(conflict.remoteEvent, null);
  assert.deepEqual(replica.list(), []);
});

test("a stale desktop draft conflicts after background pull; own acknowledged edits do not", async t => {
  const { open } = fixture(t), server = open("server"), desktop = open("desktop", true), request = transport(server);
  server.apply({ upserts: [event] }); await syncReplica(desktop, request);
  const visible = desktop.list()[0];
  server.apply({ upserts: [{ ...event, title: "remote after editor opened" }] }); await syncReplica(desktop, request);
  desktop.apply({ upserts: [{ ...visible, title: "stale draft" }], bases: [{ id: event.id, event: visible }] });
  await syncReplica(desktop, request);
  assert.equal(server.list()[0].title, "remote after editor opened"); assert.equal(server.sync.conflicts().conflicts[0].localEvent.title, "stale draft");
  const beforeOwn = desktop.list()[0], own = { ...beforeOwn, title: "own edit" };
  desktop.apply({ upserts: [own], bases: [{ id: event.id, event: beforeOwn }] }); await syncReplica(desktop, request);
  desktop.apply({ upserts: [{ ...own, title: "own next edit" }], bases: [{ id: event.id, event: own }] }); await syncReplica(desktop, request);
  assert.equal(server.list()[0].title, "own next edit"); assert.equal(server.sync.conflicts().conflicts.length, 1);
  const old = desktop.list()[0];
  server.apply({ upserts: [{ ...event, title: "new before delete" }] }); await syncReplica(desktop, request);
  desktop.apply({ deletes: [event.id], bases: [{ id: event.id, event: old }] }); await syncReplica(desktop, request);
  assert.equal(server.list()[0].title, "new before delete"); assert.equal(server.sync.conflicts().conflicts.length, 2);
});

test("offline queue, uncertain upload, edits in flight and process restart converge", async t => {
  const { open } = fixture(t), server = open("server"); let desktop = open("desktop", true);
  await syncReplica(desktop, transport(server));
  desktop.apply({ upserts: [event] });
  const operations = desktop.sync.stage(); const epoch = desktop.sync.replicaState().epoch;
  server.sync.push({ epoch, operations }); // The server commits, but the response is lost.
  desktop.apply({ upserts: [{ ...event, title: "edited during upload" }] });
  desktop.close(); desktop = open("desktop", true);
  assert.deepEqual(desktop.sync.stage(), operations); assert.equal(desktop.sync.replicaState().pending, 1);
  await syncReplica(desktop, transport(server));
  assert.equal(server.list()[0].title, "edited during upload"); assert.deepEqual(desktop.list(), server.list());
  assert.equal(desktop.sync.replicaState().pending + desktop.sync.replicaState().inflight, 0);
  desktop.apply({ deletes: [event.id] }); desktop.close(); desktop = open("desktop", true);
  await syncReplica(desktop, transport(server)); assert.deepEqual(server.list(), []);
});

async function httpFixture(t) {
  const { root, open, addCleanup } = fixture(t), dataDir = path.join(root, "data");
  const accounts = openAccountStore(path.join(dataDir, "accounts.sqlite"));
  await accounts.createUser("alice", "correct horse battery"); await accounts.createUser("bob", "another long passphrase"); accounts.close();
  const server = createCalendarServer({ dataDir, distDir: root, publicOrigin: "http://server.example" });
  await new Promise(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.server.address().port}`;
  addCleanup(() => server.close());
  const login = async (username = "alice", password = "correct horse battery") => {
    const res = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Calendar-Request": "1" }, body: JSON.stringify({ username, password }) });
    return res.headers.getSetCookie()[0].split(";")[0];
  };
  const request = cookie => async (url, body) => {
    const res = await fetch(`${origin}${url}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Calendar-Request": "1" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await res.json(); if (!res.ok) throw Object.assign(new Error(value.error), { status: res.status }); return value;
  };
  return { root, open, origin, login, request, addCleanup };
}

test("real HTTP: two SQLite replicas and web version checks, conflicts and account isolation", async t => {
  const { open, origin, login, request } = await httpFixture(t);
  const cookie = await login(), req = request(cookie), bob = request(await login("bob", "another long passphrase"));
  const a = open("a", true), b = open("b", true);
  await syncReplica(a, req); await syncReplica(b, req);
  a.apply({ upserts: [event] }); await syncReplica(a, req); await syncReplica(b, req); assert.deepEqual(b.list(), a.list());
  const fetchImpl = (url, init) => fetch(`${origin}${url}`, { ...init, headers: { ...init?.headers, Cookie: cookie } });
  const web = createServerRepository({ fetchImpl }); await web.list();
  a.apply({ upserts: [{ ...event, title: "new desktop" }] }); await syncReplica(a, req);
  await web.apply({ upserts: [{ ...event, title: "stale web" }] });
  assert.equal((await req("/api/sync/conflicts")).conflicts.length, 1);
  assert.equal((await req("/api/events"))[0].title, "new desktop");
  const bobSnapshot = await bob("/api/sync/snapshot");
  await bob("/api/sync/push", { epoch: bobSnapshot.epoch, operations: [op({ ...event, title: "bob" })] });
  assert.equal((await bob("/api/events"))[0].title, "bob"); assert.equal((await req("/api/events"))[0].title, "new desktop");
  await assert.rejects(() => req("/api/events/apply", { upserts: [event] }), e => e.status === 428);
  await assert.rejects(() => req("/api/sync/push", { epoch: a.sync.replicaState().epoch, operations: [op({ ...event, id: "x" }), op({ ...event, id: "bad", end: "bad" })] }), e => e.status === 400);
  assert.equal((await req("/api/events")).length, 1);
  b.apply({ deletes: [event.id] }); await syncReplica(b, req);
  assert.equal((await req("/api/sync/conflicts")).conflicts.length, 2);
  const conflicts = (await req("/api/sync/conflicts")).conflicts;
  const conflict = conflicts.find(c => c.localEvent === null);
  await req("/api/sync/resolve", { epoch: a.sync.replicaState().epoch, opId: randomUUID(), conflictId: conflict.id, choice: "local", expectedRevision: conflict.remoteRevision });
  await syncReplica(a, req); await syncReplica(b, req); assert.deepEqual(a.list(), []); assert.deepEqual(b.list(), []);
});

test("desktop accounts: restart offline, encrypted session, logout, isolated profiles and one-time merge", async t => {
  const { root, origin, addCleanup } = await httpFixture(t);
  const local = openCalendarDatabase(path.join(root, "local", "calendar.sqlite")); addCleanup(() => local.close());
  local.apply({ upserts: [event] });
  let online = true;
  const fetchImpl = (...args) => { if (!online) throw new TypeError("offline"); return fetch(...args); };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(`encrypted:${text}`), decryptString: buffer => buffer.toString().slice(10) };
  const options = { dataPath: path.join(root, "local"), localDatabase: local, safeStorage, fetchImpl };
  let manager = createDesktopAccounts(options);
  addCleanup(() => manager.close());
  await manager.login({ origin, username: "alice", password: "correct horse battery", mergeLocal: true }); await manager.run();
  assert.equal(manager.database().list().length, 1);
  online = false; manager.database().apply({ upserts: [{ ...event, title: "offline account" }] });
  await manager.close(); manager = createDesktopAccounts(options); await manager.restore();
  assert.equal(manager.database().list()[0].title, "offline account"); assert.equal(manager.info().pending, 1);
  await manager.run(); assert.equal(manager.info().phase, "offline");
  await manager.logout(); assert.equal(manager.database(), local); assert.equal(local.list()[0].title, event.title);
  online = true;
  await manager.login({ origin, username: "bob", password: "another long passphrase" }); await manager.run(); assert.deepEqual(manager.database().list(), []);
  await manager.logout();
  await manager.login({ origin, username: "alice", password: "correct horse battery", mergeLocal: true }); await manager.run();
  assert.equal(manager.database().list().length, 1); assert.equal(manager.database().list()[0].title, "offline account");
  assert.notEqual(profileKey(origin, "alice"), profileKey(origin, "bob"));
  for (const url of ["http://example.com", "https://u:p@example.com", "https://example.com/path", "https://example.com/?x=1"]) assert.throws(() => validateServerOrigin(url));
  assert.equal(validateServerOrigin(origin), origin);
});

test("switching accounts aborts an uncertain upload and the original profile replays its receipt", async t => {
  const { root, origin, addCleanup } = await httpFixture(t);
  const local = openCalendarDatabase(path.join(root, "local.sqlite")); addCleanup(() => local.close());
  let hold = false, arrived;
  const reached = new Promise(resolve => { arrived = resolve; });
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    if (hold && url.endsWith("/api/sync/push")) {
      arrived();
      await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    }
    return response;
  };
  const manager = createDesktopAccounts({ dataPath: root, localDatabase: local, fetchImpl }); addCleanup(() => manager.close());
  await manager.login({ origin, username: "alice", password: "correct horse battery" }); await manager.run();
  manager.database().apply({ upserts: [event] }); hold = true;
  const upload = manager.run(); await reached;
  await manager.logout(); await upload; hold = false;
  await manager.login({ origin, username: "bob", password: "another long passphrase" }); await manager.run();
  assert.deepEqual(manager.database().list(), []);
  await manager.logout(); await manager.login({ origin, username: "alice", password: "correct horse battery" }); await manager.run();
  assert.equal(manager.database().list().length, 1); assert.equal(manager.info().inflight, 0);
});

test("401 and unavailable safe storage preserve offline edits and never persist plaintext sessions", async t => {
  const { root, origin, addCleanup } = await httpFixture(t);
  const local = openCalendarDatabase(path.join(root, "local.sqlite")); addCleanup(() => local.close());
  let cookie;
  const fetchImpl = (url, init) => { if (init.headers.Cookie) cookie = init.headers.Cookie; return fetch(url, init); };
  const options = { dataPath: root, localDatabase: local, fetchImpl, safeStorage: { isEncryptionAvailable: () => false } };
  let manager = createDesktopAccounts(options); addCleanup(() => manager.close());
  await manager.login({ origin, username: "alice", password: "correct horse battery" }); await manager.run();
  await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Calendar-Request": "1" }, body: "{}" });
  await manager.run(); assert.equal(manager.info().phase, "auth");
  manager.database().apply({ upserts: [event] });
  const saved = fs.readFileSync(path.join(root, "sync-session.json"), "utf8");
  assert.doesNotMatch(saved, /calendar_session|correct horse|encryptedCookie/);
  await manager.close(); manager = createDesktopAccounts(options); await manager.restore(); await manager.run();
  assert.equal(manager.info().phase, "auth"); assert.equal(manager.database().list().length, 1);
  await manager.login({ origin, username: "alice", password: "correct horse battery" }); await manager.run();
  assert.equal(manager.info().phase, "synced"); assert.equal(manager.info().pending, 0);
});
