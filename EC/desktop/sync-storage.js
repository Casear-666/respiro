import { randomUUID, createHash } from "node:crypto";
import { normalizeEvent } from "../shared/domain.js";

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const idValid = (id) => typeof id === "string" && id.length > 0 && id.length <= 120 && !/[\u0000-\u001f]/.test(id);
const revisionValid = (n) => Number.isSafeInteger(n) && n >= 0;
const encode = (e) => e === null ? null : JSON.stringify(e);
const decode = (s) => s === null ? null : JSON.parse(s);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function attachSyncStorage({ db, transaction, upsert, remove, replica }) {
  transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO sync_meta VALUES ('head','0'),('replica','0'),('remote_write','0'),('cursor','0');
      CREATE TABLE IF NOT EXISTS sync_events (id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, payload TEXT);
      CREATE TABLE IF NOT EXISTS sync_receipts (op_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, local_payload TEXT,
        remote_payload TEXT, base_revision INTEGER NOT NULL, created_at TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sync_shadow (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT);
      CREATE TABLE IF NOT EXISTS sync_pending (id TEXT PRIMARY KEY, base_revision INTEGER NOT NULL, payload TEXT);
      CREATE TABLE IF NOT EXISTS sync_inflight (op_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, base_revision INTEGER NOT NULL, payload TEXT);
    `);
    db.prepare("INSERT OR IGNORE INTO sync_meta VALUES ('epoch',?)").run(randomUUID());
    // Seed schema 1 records before installing triggers. Every existing event receives a version.
    for (const row of db.prepare("SELECT id,payload FROM events WHERE id NOT IN (SELECT id FROM sync_events)").all()) {
      db.exec("UPDATE sync_meta SET value=CAST(value AS INTEGER)+1 WHERE key='head'");
      db.prepare("INSERT INTO sync_events VALUES (?,(SELECT value FROM sync_meta WHERE key='head'),?)").run(row.id, row.payload);
    }
    for (const [operation, ref, payload] of [["INSERT", "NEW", "NEW.payload"], ["UPDATE", "NEW", "NEW.payload"], ["DELETE", "OLD", "NULL"]]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS sync_event_${operation.toLowerCase()} AFTER ${operation} ON events
        ${operation === "UPDATE" ? "WHEN OLD.payload <> NEW.payload" : ""} BEGIN
          UPDATE sync_meta SET value=CAST(value AS INTEGER)+1 WHERE key='head';
          INSERT INTO sync_events VALUES (${ref}.id,(SELECT value FROM sync_meta WHERE key='head'),${payload})
            ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload;
          INSERT INTO sync_pending SELECT ${ref}.id,COALESCE((SELECT revision FROM sync_shadow WHERE id=${ref}.id),0),${payload}
            WHERE (SELECT value FROM sync_meta WHERE key='replica')='1' AND (SELECT value FROM sync_meta WHERE key='remote_write')='0'
            ON CONFLICT(id) DO UPDATE SET payload=excluded.payload;
        END;`);
    }
    if (replica) db.exec("UPDATE sync_meta SET value='1' WHERE key='replica'");
    db.exec("PRAGMA user_version=2");
  });
  const meta = (key) => db.prepare("SELECT value FROM sync_meta WHERE key=?").get(key)?.value;
  const setMeta = (key, value) => db.prepare("INSERT INTO sync_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
  const current = (id) => {
    const r = db.prepare("SELECT revision,payload FROM sync_events WHERE id=?").get(id);
    return { id, revision: r?.revision ?? 0, event: r ? decode(r.payload) : null };
  };
  const write = (id, event) => event === null ? remove.run(id) : upsert.run(id, encode(event));
  const checkEpoch = (epoch) => { if (epoch !== meta("epoch")) fail("服务器数据版本已改变，请保留本地副本并重新连接", 409); };
  const receipt = (opId, hash, action) => {
    const old = db.prepare("SELECT digest,result FROM sync_receipts WHERE op_id=?").get(opId);
    if (old) {
      if (old.digest !== hash) fail("操作编号已用于其他内容", 409);
      return JSON.parse(old.result);
    }
    const result = action();
    db.prepare("INSERT INTO sync_receipts VALUES (?,?,?)").run(opId, hash, JSON.stringify(result));
    return result;
  };
  const remoteWrite = (action) => {
    setMeta("remote_write", 1);
    try { return action(); } finally { setMeta("remote_write", 0); }
  };
  const putShadow = (change) => db.prepare(`INSERT INTO sync_shadow VALUES (?,?,?) ON CONFLICT(id) DO UPDATE
    SET revision=excluded.revision,payload=excluded.payload WHERE excluded.revision >= sync_shadow.revision`).run(change.id, change.revision, encode(change.event));
  return {
    initialized: () => meta("initialized") === "1",
    markInitialized: () => setMeta("initialized", 1),
    staleViewIds(bases) {
      if (meta("replica") !== "1" || bases === undefined) return [];
      if (!Array.isArray(bases) || bases.length > 50000) fail("页面日程依据无效");
      return bases.filter(base => {
        if (!base || !idValid(base.id) || (base.event !== null && base.event?.id !== base.id)) fail("页面日程依据无效");
        if (db.prepare("SELECT 1 FROM sync_pending WHERE id=? UNION ALL SELECT 1 FROM sync_inflight WHERE id=?").get(base.id, base.id)) return false;
        const actual = db.prepare("SELECT payload FROM events WHERE id=?").get(base.id);
        return encode(actual ? normalizeEvent(decode(actual.payload)) : null) !== encode(base.event === null ? null : normalizeEvent(base.event));
      }).map(base => base.id);
    },
    protectStaleWrites(ids) {
      // A stale visible draft must conflict with any existing cloud revision, even though
      // background sync has already advanced the local shadow. Equal outcomes remain no-ops.
      for (const id of ids) db.prepare("UPDATE sync_pending SET base_revision=0 WHERE id=?").run(id);
    },
    snapshot: () => transaction(() => ({ epoch: meta("epoch"), cursor: Number(meta("head")), changes: db.prepare("SELECT id FROM sync_events ORDER BY revision").all().map(r => current(r.id)) })),
    changes({ since = 0, epoch } = {}) {
      return transaction(() => {
        if (epoch !== undefined && epoch !== null && epoch !== "") checkEpoch(epoch);
        const head = Number(meta("head"));
        if (!revisionValid(since) || since > head) fail("同步游标无效，请保留本地副本", 409);
        const rows = db.prepare("SELECT id,revision,payload FROM sync_events WHERE revision>? ORDER BY revision LIMIT 101").all(since);
        const hasMore = rows.length > 100;
        const changes = rows.slice(0, 100).map(r => ({ id: r.id, revision: r.revision, event: decode(r.payload) }));
        return { epoch: meta("epoch"), cursor: hasMore ? changes.at(-1).revision : head, hasMore, changes };
      });
    },
    push({ epoch, operations } = {}) {
      if (!Array.isArray(operations) || operations.length > 100) fail("每批最多上传 100 项日程");
      const ids = new Set(), opIds = new Set();
      const safe = operations.map(op => {
        if (!op || !idValid(op.opId) || !idValid(op.id) || !revisionValid(op.baseRevision) || ids.has(op.id) || opIds.has(op.opId)) fail("同步操作无效或重复");
        ids.add(op.id); opIds.add(op.opId);
        if (op.event !== null && (!op.event || op.event.id !== op.id)) fail("日程编号不匹配");
        let event;
        try { event = op.event === null ? null : normalizeEvent(op.event); } catch (error) { fail(error.message); }
        return { opId: op.opId, id: op.id, baseRevision: op.baseRevision, event };
      });
      return transaction(() => {
        checkEpoch(epoch);
        return { results: safe.map(op => receipt(op.opId, digest({ kind: "push", epoch, ...op }), () => {
          const remote = current(op.id);
          if (remote.revision === op.baseRevision || encode(remote.event) === encode(op.event)) {
            write(op.id, op.event);
            return { opId: op.opId, ...current(op.id), status: "accepted" };
          }
          const conflictId = randomUUID();
          db.prepare("INSERT INTO sync_conflicts (id,event_id,local_payload,remote_payload,base_revision,created_at) VALUES (?,?,?,?,?,?)")
            .run(conflictId, op.id, encode(op.event), encode(remote.event), op.baseRevision, new Date().toISOString());
          return { opId: op.opId, ...remote, status: "conflict", conflictId };
        })) };
      });
    },
    conflicts: () => transaction(() => ({ conflicts: db.prepare("SELECT * FROM sync_conflicts WHERE resolved=0 ORDER BY created_at,id").all().map(r => ({
      id: r.id, eventId: r.event_id, localEvent: decode(r.local_payload), originalRemoteEvent: decode(r.remote_payload),
      remoteEvent: current(r.event_id).event, remoteRevision: current(r.event_id).revision, createdAt: r.created_at,
    })) })),
    resolve({ epoch, opId, conflictId, choice, expectedRevision } = {}) {
      if (!idValid(opId) || !idValid(conflictId) || !["local", "remote", "both"].includes(choice) || !revisionValid(expectedRevision)) fail("冲突处理请求无效");
      return transaction(() => {
        checkEpoch(epoch);
        return receipt(opId, digest({ kind: "resolve", epoch, opId, conflictId, choice, expectedRevision }), () => {
          const row = db.prepare("SELECT * FROM sync_conflicts WHERE id=? AND resolved=0").get(conflictId);
          if (!row) fail("冲突已处理，请刷新", 409);
          const remote = current(row.event_id), local = decode(row.local_payload);
          if (remote.revision !== expectedRevision) fail("云端日程再次发生变化，请重新比较", 409);
          let copy;
          if (choice === "both") {
            if (!local || !remote.event) fail("删除冲突请选择保留的版本");
            copy = { ...local, id: randomUUID() }; write(copy.id, copy);
          } else if (choice === "local") write(row.event_id, local);
          db.prepare("UPDATE sync_conflicts SET resolved=1 WHERE id=?").run(conflictId);
          return { ok: true, changes: [current(row.event_id), ...(copy ? [current(copy.id)] : [])] };
        });
      });
    },
    replicaState: () => ({ epoch: meta("remote_epoch") ?? null, cursor: Number(meta("cursor")),
      pending: db.prepare("SELECT count(*) n FROM sync_pending").get().n,
      inflight: db.prepare("SELECT count(*) n FROM sync_inflight").get().n }),
    receive(page) {
      transaction(() => remoteWrite(() => {
        const epoch = meta("remote_epoch");
        if (epoch && epoch !== page.epoch) fail("服务器数据版本已改变，本地修改已保留", 409);
        if (!revisionValid(page.cursor) || page.cursor < Number(meta("cursor"))) fail("同步响应游标无效", 409);
        for (const change of page.changes) {
          putShadow(change);
          const dirty = db.prepare("SELECT 1 FROM sync_pending WHERE id=? UNION ALL SELECT 1 FROM sync_inflight WHERE id=?").get(change.id, change.id);
          if (!dirty) write(change.id, change.event);
        }
        setMeta("remote_epoch", page.epoch); setMeta("cursor", page.cursor);
      }));
    },
    stage() {
      return transaction(() => {
        // Uncertain requests must always be retried with their original immutable operation IDs.
        if (!db.prepare("SELECT 1 FROM sync_inflight LIMIT 1").get()) {
          for (const r of db.prepare("SELECT * FROM sync_pending LIMIT 100").all()) {
            db.prepare("INSERT INTO sync_inflight VALUES (?,?,?,?)").run(randomUUID(), r.id, r.base_revision, r.payload);
            db.prepare("DELETE FROM sync_pending WHERE id=?").run(r.id);
          }
        }
        return db.prepare("SELECT * FROM sync_inflight").all().map(r => ({ opId: r.op_id, id: r.id, baseRevision: r.base_revision, event: decode(r.payload) }));
      });
    },
    acknowledge({ results }) {
      transaction(() => remoteWrite(() => {
        for (const result of results) {
          const sent = db.prepare("SELECT * FROM sync_inflight WHERE op_id=? AND id=?").get(result.opId, result.id);
          if (!sent) continue;
          putShadow(result);
          db.prepare("DELETE FROM sync_inflight WHERE op_id=?").run(result.opId);
          const dirty = db.prepare("SELECT 1 FROM sync_pending WHERE id=?").get(result.id);
          if (dirty && result.status === "accepted") db.prepare("UPDATE sync_pending SET base_revision=? WHERE id=?").run(result.revision, result.id);
          if (!dirty) {
            const shadow = db.prepare("SELECT payload FROM sync_shadow WHERE id=?").get(result.id);
            write(result.id, decode(shadow.payload));
          }
        }
      }));
    },
  };
}
