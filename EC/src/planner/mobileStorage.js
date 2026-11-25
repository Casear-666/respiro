import { createBackup, mergeEvents, normalizeEvent, parseBackup, uid } from "../../shared/domain.js";

export const MOBILE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS calendar_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calendar_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calendar_weight_overrides (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calendar_backups (kind TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS replica_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS replica_shadow (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS replica_pending (id TEXT PRIMARY KEY, base_revision INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS replica_inflight (op_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, base_revision INTEGER NOT NULL, payload TEXT NOT NULL);
`;

const settingKeys = new Set([
  "theme", "defaultView", "viewsVersion", "weekStart", "showWeekends",
  "workStart", "workEnd", "confirmBeforeDelete",
]);
const sql = (statement, ...values) => ({ statement, values });
const upsertEvent = (id, payload) => sql(
  "INSERT INTO calendar_events VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE calendar_events.payload <> excluded.payload",
  id, payload,
);
const writeEvent = (id, event) => event === null
  ? sql("DELETE FROM calendar_events WHERE id=?", id)
  : upsertEvent(id, JSON.stringify(event));
const setMeta = (key, value) => sql(
  "INSERT INTO replica_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  key, String(value),
);
const saveBackup = (kind, events) => sql(
  "INSERT INTO calendar_backups VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload",
  kind, createBackup(events),
);
const putShadow = ({ id, revision, event }) => sql(
  `INSERT INTO replica_shadow VALUES (?,?,?) ON CONFLICT(id) DO UPDATE
     SET revision=excluded.revision,payload=excluded.payload WHERE excluded.revision >= replica_shadow.revision`,
  id, revision, JSON.stringify(event),
);
const NO_PENDING = "NOT EXISTS (SELECT 1 FROM replica_pending WHERE id=?)";
const NO_INFLIGHT = "NOT EXISTS (SELECT 1 FROM replica_inflight WHERE id=?)";
const revealShadow = (id) => [
  sql(`DELETE FROM calendar_events WHERE id=? AND (SELECT payload FROM replica_shadow WHERE id=?)='null'
    AND ${NO_PENDING} AND ${NO_INFLIGHT}`, id, id, id, id),
  sql(`INSERT INTO calendar_events SELECT id,payload FROM replica_shadow WHERE id=? AND payload <> 'null'
    AND ${NO_PENDING} AND ${NO_INFLIGHT} ON CONFLICT(id) DO UPDATE SET payload=excluded.payload
    WHERE calendar_events.payload <> excluded.payload`, id, id, id),
];
const queueChange = (id, event, base) => {
  const payload = JSON.stringify(event);
  return sql(
    `INSERT INTO replica_pending
       SELECT ?, CASE
         WHEN ? IS NOT NULL AND ? <> COALESCE((SELECT payload FROM calendar_events WHERE id=?),'null')
              AND ${NO_INFLIGHT} THEN 0
         ELSE COALESCE((SELECT revision FROM replica_shadow WHERE id=?),0)
       END, ?
       WHERE ? <> COALESCE((SELECT payload FROM calendar_events WHERE id=?),'null')
       ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
    id, base, base, id, id, id, payload, payload, id,
  );
};
const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 120 && !/[\u0000-\u001f]/.test(id);
const validRevision = (value) => Number.isSafeInteger(value) && value >= 0;
const syncError = (message) => Object.assign(new Error(message), { status: 409 });
const checkedChange = (change) => {
  if (!validId(change?.id) || !validRevision(change.revision) ||
      (change.event !== null && change.event?.id !== change.id)) {
    throw syncError("同步响应中的日程或版本无效");
  }
  return { ...change, event: change.event === null ? null : normalizeEvent(change.event) };
};

// Each write callback uses a single native transaction. The queue keeps its
// preceding reads and following writes ordered with respect to all other calls.
export function createMobileStorage(driver, { replica = false, createId = uid } = {}) {
  let tail = Promise.resolve();
  const serialize = (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  const query = (statement, ...values) => driver.query(statement, values);
  const write = (statements) => statements.length ? driver.write(statements) : Promise.resolve();
  const readEvents = async () => (await query("SELECT payload FROM calendar_events ORDER BY rowid"))
    .map(({ payload }) => normalizeEvent(JSON.parse(payload)));
  const readMeta = async (key) => (await query("SELECT value FROM replica_meta WHERE key=?", key))[0]?.value;
  const readInflight = () => query("SELECT * FROM replica_inflight ORDER BY rowid");
  const localChange = (id, event, base = null) => [
    ...(replica ? [queueChange(id, event, base)] : []),
    writeEvent(id, event),
  ];
  const importEvents = async (incoming, extra = []) => {
    if (incoming.length === 0) {
      await write(extra);
      return { added: 0, skipped: 0 };
    }
    const current = await readEvents();
    const { added, skipped, addedEvents } = mergeEvents(current, incoming, createId);
    const changes = addedEvents.flatMap((event) => localChange(event.id, event));
    await write([
      ...extra,
      ...(added && extra.length === 0 ? [saveBackup("before-import", current)] : []),
      ...changes,
    ]);
    return { added, skipped };
  };

  return {
    list: () => serialize(readEvents),
    apply({ upserts = [], deletes = [], bases } = {}) {
      return serialize(async () => {
        if (!Array.isArray(upserts) || !Array.isArray(deletes) ||
            upserts.length + deletes.length > 50000 ||
            (bases !== undefined && (!Array.isArray(bases) || bases.length > 50000))) {
          throw new Error("日程变更无效");
        }
        const original = new Map((bases ?? []).map((base) => {
          if (!validId(base?.id) || (base.event !== null && base.event?.id !== base.id)) {
            throw new Error("页面日程依据无效");
          }
          return [base.id, JSON.stringify(base.event === null ? null : normalizeEvent(base.event))];
        }));
        const changes = upserts.map(normalizeEvent).map((event) => [event.id, event]);
        for (const id of deletes) changes.push([String(id), null]);
        await write(changes.flatMap(([id, event]) => {
          if (!validId(id)) throw new Error("日程编号无效");
          return localChange(id, event, original.get(id));
        }));
        return { ok: true };
      });
    },
    getSettings: () => serialize(async () => Object.fromEntries(
      (await query("SELECT key,value FROM calendar_settings")).map(({ key, value }) => [key, JSON.parse(value)]),
    )),
    setSettings: (settings) => serialize(() => write(Object.entries(settings)
      .filter(([key]) => settingKeys.has(key))
      .map(([key, value]) => sql(
        "INSERT INTO calendar_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key, JSON.stringify(value),
      )))),
    getWeightOverrides: () => serialize(async () => Object.fromEntries(
      (await query("SELECT id,payload FROM calendar_weight_overrides")).map(({ id, payload }) => [id, JSON.parse(payload)]),
    )),
    setWeightOverride: (id, value) => serialize(() => {
      if (!validId(id) || (value !== null && (
        value?.id !== id || value.manual !== true ||
        !Number.isInteger(value.score) || value.score < 1 || value.score > 5
      ))) throw new Error("日程认知耗能数值无效");
      return write([value === null
        ? sql("DELETE FROM calendar_weight_overrides WHERE id=?", id)
        : sql("INSERT INTO calendar_weight_overrides VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
          id, JSON.stringify(value))]);
    }),
    export: () => serialize(async () => createBackup(await readEvents())),
    importText: (raw) => serialize(() => importEvents(parseBackup(raw))),
    close: () => serialize(() => driver.close?.()),
    sync: {
      initialized: () => serialize(async () => (await readMeta("initialized")) === "1"),
      initializeProfile: (localEvents) => serialize(async () => {
        if ((await readMeta("initialized")) === "1") return;
        const extra = [setMeta("initialized", 1)];
        if (localEvents) extra.push(saveBackup("before-first-sync", localEvents));
        await importEvents(localEvents ?? [], extra);
      }),
      conflicts: () => serialize(async () => JSON.parse((await readMeta("conflicts")) || "[]")),
      rememberConflicts: (conflicts) => serialize(async () => {
        if (!Array.isArray(conflicts)) throw syncError("服务器返回的冲突列表无效");
        await write([setMeta("conflicts", JSON.stringify(conflicts))]);
      }),
      replicaState: () => serialize(async () => {
        const [state] = await query(`SELECT
          (SELECT value FROM replica_meta WHERE key='remote_epoch') epoch,
          COALESCE((SELECT CAST(value AS INTEGER) FROM replica_meta WHERE key='cursor'),0) cursor,
          (SELECT COUNT(*) FROM replica_pending) pending,
          (SELECT COUNT(*) FROM replica_inflight) inflight`);
        return state;
      }),
      receive: (page) => serialize(async () => {
        const epoch = await readMeta("remote_epoch");
        if (epoch && epoch !== page?.epoch) throw syncError("服务器数据版本已改变，本地修改已保留");
        const cursor = Number(await readMeta("cursor") ?? 0);
        if (!validId(page?.epoch) || !validRevision(page.cursor) || page.cursor < cursor ||
            (page.hasMore && page.cursor === cursor) || !Array.isArray(page.changes) ||
            page.changes.length > 100 || typeof page.hasMore !== "boolean") {
          throw syncError("同步响应游标无效");
        }
        const changes = page.changes.map(checkedChange);
        await write([
          ...changes.flatMap((change) => [putShadow(change), ...revealShadow(change.id)]),
          setMeta("remote_epoch", page.epoch),
          setMeta("cursor", page.cursor),
        ]);
      }),
      stage: () => serialize(async () => {
        let staged = await readInflight();
        if (staged.length === 0) {
          const pending = await query("SELECT * FROM replica_pending ORDER BY rowid LIMIT 100");
          staged = pending.map((row) => ({ ...row, op_id: createId() }));
          await write(staged.flatMap((row) => [
            sql("INSERT INTO replica_inflight VALUES (?,?,?,?)", row.op_id, row.id, row.base_revision, row.payload),
            sql("DELETE FROM replica_pending WHERE id=?", row.id),
          ]));
        }
        return staged.map((row) => ({
          opId: row.op_id, id: row.id, baseRevision: row.base_revision, event: JSON.parse(row.payload),
        }));
      }),
      acknowledge: ({ results } = {}) => serialize(async () => {
        const staged = await readInflight();
        const byOp = new Map(staged.map((row) => [row.op_id, row.id]));
        if (!Array.isArray(results) || results.length !== byOp.size) throw syncError("同步回执不完整");
        const changes = results.map((result) => {
          const change = checkedChange(result);
          if (byOp.get(change.opId) !== change.id || !["accepted", "conflict"].includes(change.status)) {
            throw syncError("同步回执与待处理操作不匹配");
          }
          byOp.delete(change.opId);
          return change;
        });
        await write(changes.flatMap((change) => [
          putShadow(change),
          sql("DELETE FROM replica_inflight WHERE op_id=?", change.opId),
          ...(change.status === "accepted" ? [
            sql("UPDATE replica_pending SET base_revision=? WHERE id=?", change.revision, change.id),
          ] : []),
          ...revealShadow(change.id),
        ]));
      }),
    },
  };
}
