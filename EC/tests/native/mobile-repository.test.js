import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openCalendarDatabase } from "../../desktop/database.js";
import { syncReplica } from "../../desktop/sync-engine.js";
import { createBackup, normalizeEvent, uid } from "../../shared/domain.js";
import { createMobileRepository, validateMobileOrigin } from "../../src/planner/mobileRepository.js";
import { createMobileStorage, MOBILE_SCHEMA } from "../../src/planner/mobileStorage.js";

const event = normalizeEvent({
  id: "shared", title: "初始日程", start: "2026-11-25", end: "2026-11-26", allDay: true,
});
const origin = "https://example.test";

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "energy-mobile-test-"));
  const databases = new Set();
  t.after(() => {
    for (const db of databases) db.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return {
    mobile(name, replica = false) {
      const db = new DatabaseSync(join(folder, `${name}.sqlite`));
      databases.add(db);
      db.exec(MOBILE_SCHEMA);
      return createMobileStorage({
        query: async (statement, values) => db.prepare(statement).all(...values),
        async write(statements) {
          db.exec("BEGIN");
          try {
            for (const { statement, values } of statements) db.prepare(statement).run(...values);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
        close: () => { db.close(); databases.delete(db); },
      }, { replica });
    },
    server(name) {
      const db = openCalendarDatabase(join(folder, `${name}.sqlite`));
      databases.add(db);
      return db;
    },
  };
}

function routeFor(cloud, route, body) {
  const url = new URL(route, origin);
  switch (url.pathname) {
    case "/api/sync/changes": return cloud.sync.changes({
      since: Number(url.searchParams.get("since")), epoch: url.searchParams.get("epoch"),
    });
    case "/api/sync/push": return cloud.sync.push(body);
    case "/api/sync/conflicts": return cloud.sync.conflicts();
    case "/api/sync/resolve": return cloud.sync.resolve(body);
    default: throw new Error(`Unexpected route ${route}`);
  }
}

test("mobile local storage commits calendar, settings and manual energy overrides before reopen", async (t) => {
  const { mobile } = fixture(t);
  let local = mobile("local");
  await local.apply({ upserts: [event] });
  await local.setSettings({ theme: "dark" });
  const override = { id: event.id, score: 2, manual: true };
  await local.setWeightOverride(event.id, override);
  await assert.rejects(() => local.apply({
    upserts: [{ ...event, id: "invalid", end: "invalid" }], deletes: [event.id],
  }), /结束时间|全天日程/);
  await local.close();
  local = mobile("local");
  assert.deepEqual(await local.list(), [event]);
  assert.deepEqual(await local.getSettings(), { theme: "dark" });
  assert.deepEqual(await local.getWeightOverrides(), { [event.id]: override });
  assert.deepEqual(await local.importText(createBackup([event])), { added: 0, skipped: 1 });
  assert.equal((await local.sync.replicaState()).pending, 0);
  await local.setWeightOverride(event.id, null);
  assert.deepEqual(await local.getWeightOverrides(), {});
});

test("mobile SQLite reconnect replays the immutable operation then syncs a newer offline edit", async (t) => {
  const { mobile, server } = fixture(t);
  const cloud = server("cloud");
  let phone = mobile("phone", true);
  await phone.apply({ upserts: [event] });
  let lost;
  await assert.rejects(syncReplica(phone, async (route, body) => {
    const response = routeFor(cloud, route, body);
    if (route === "/api/sync/push") {
      lost = body.operations[0];
      throw new Error("connection lost after commit");
    }
    return response;
  }), /connection lost/);
  await phone.close();
  phone = mobile("phone", true);
  const edited = { ...event, title: "离线改动" };
  await phone.apply({ upserts: [edited], bases: [{ id: event.id, event }] });
  const uploads = [];
  const send = async (route, body) => {
    if (route === "/api/sync/push") uploads.push(...body.operations);
    return routeFor(cloud, route, body);
  };
  assert.equal((await syncReplica(phone, send)).pending, 0);
  assert.deepEqual(uploads[0], lost);
  assert.equal(uploads[1].baseRevision, 1);
  assert.deepEqual(cloud.list(), [edited]);
  await phone.apply({ deletes: [event.id], bases: [{ id: event.id, event: edited }] });
  await syncReplica(phone, send);
  assert.deepEqual(cloud.list(), []);
  assert.equal(cloud.sync.snapshot().changes[0].event, null);
});

test("mobile replica protects drafts seen before a newer cloud edit and handles deletion conflicts", async (t) => {
  const { mobile, server } = fixture(t);
  const cloud = server("cloud");
  const phone = mobile("phone", true);
  const send = async (route, body) => routeFor(cloud, route, body);
  cloud.apply({ upserts: [event] });
  await syncReplica(phone, send);
  const remote = { ...event, title: "其他设备改动" };
  cloud.apply({ upserts: [remote] });
  await syncReplica(phone, send);
  await phone.apply({ deletes: [event.id], bases: [{ id: event.id, event }] });
  const { conflicts, epoch } = await syncReplica(phone, send);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].localEvent, null);
  assert.deepEqual(conflicts[0].remoteEvent, remote);
  await phone.sync.rememberConflicts(conflicts);
  assert.deepEqual(await phone.sync.conflicts(), conflicts);
  cloud.sync.resolve({
    epoch, opId: uid(), conflictId: conflicts[0].id, choice: "local", expectedRevision: conflicts[0].remoteRevision,
  });
  await syncReplica(phone, send);
  assert.deepEqual(await phone.list(), []);
});

test("mobile replica pulls paginated changes and preserves local work if the server epoch changes", async (t) => {
  const { mobile, server } = fixture(t);
  const cloud = server("cloud");
  const phone = mobile("phone", true);
  const cloudEvents = Array.from({ length: 101 }, (_, i) => ({ ...event, id: `item-${i}` }));
  cloud.apply({ upserts: cloudEvents });
  const synced = await syncReplica(phone, async (route, body) => routeFor(cloud, route, body));
  assert.equal(synced.cursor, 101);
  assert.deepEqual(await phone.list(), cloudEvents);
  await phone.apply({ upserts: [event] });
  const replacement = server("replacement");
  await assert.rejects(
    syncReplica(phone, async (route, body) => routeFor(replacement, route, body)),
    (error) => error.status === 409,
  );
  assert.equal((await phone.sync.replicaState()).inflight, 1);
  assert.deepEqual(await phone.list(), [...cloudEvents, event]);
  assert.deepEqual(replacement.list(), []);
});

test("mobile repository keeps local data and profiles isolated, including offline session expiry", async (t) => {
  const { mobile, server } = fixture(t);
  const clouds = { alice: server("alice-cloud"), bob: server("bob-cloud") };
  let durable = null, candidate = null, expired = false, picked = { canceled: true }, shared;
  const native = {
    getSession: async () => ({ session: durable }),
    commitSession: async ({ session }) => {
      assert.equal(session.user.id, candidate);
      durable = session;
      candidate = null;
    },
    clearCandidate: async () => { candidate = null; },
    setSession: async ({ session }) => { durable = session; },
    pickBackup: async () => picked,
    shareBackup: async (backup) => { shared = backup; return { ok: true }; },
    async request({ route, body, session }) {
      if (route === "/api/auth/login") {
        candidate = body.username;
        return { user: { id: candidate, username: candidate } };
      }
      const id = session === "candidate" ? candidate : durable?.user.id;
      if (!id || expired) throw Object.assign(new Error("expired"), { code: "401" });
      if (route === "/api/auth/me") return { user: { id } };
      return routeFor(clouds[id], route, body);
    },
  };
  const makeRepository = () => createMobileRepository({
    native, openLocal: async () => mobile("local"), version: "test",
    openProfile: async (_, id) => mobile(`profile-${id}`, true), isForeground: () => false,
  });
  const repo = makeRepository();
  const credentials = { origin, username: "alice", password: "Password1" };
  assert.deepEqual(await repo.importBackup(), { canceled: true });
  picked = { text: createBackup([event]) };
  assert.deepEqual(await repo.importBackup(), { added: 1, skipped: 0 });
  assert.deepEqual(await repo.exportBackup(), { ok: true });
  assert.equal(JSON.parse(shared.text).events[0].id, event.id);
  await repo.login({ ...credentials, mergeLocal: true });
  await repo.syncNow();
  assert.deepEqual(clouds.alice.list(), [event]);
  expired = true;
  const edit = { ...event, title: "离线修改" };
  await repo.apply({ upserts: [edit] });
  const restarted = makeRepository();
  assert.deepEqual(await restarted.list(), [edit]);
  assert.equal((await restarted.syncNow()).phase, "auth");
  expired = false;
  await assert.rejects(restarted.login({ ...credentials, username: "bob" }), /先退出/);
  assert.deepEqual(await restarted.list(), [edit]);
  await restarted.login(credentials);
  await restarted.syncNow();
  assert.deepEqual(clouds.alice.list(), [edit]);
  await restarted.logout();
  assert.deepEqual(await restarted.list(), [event]);
  await restarted.login({ ...credentials, username: "bob" });
  assert.deepEqual(await restarted.list(), []);
  await restarted.logout();
  assert.equal(durable, null);
  assert.equal(validateMobileOrigin("http://127.0.0.1:3001/"), "http://127.0.0.1:3001");
  assert.throws(() => validateMobileOrigin("http://other.test"), /HTTPS/);
});
