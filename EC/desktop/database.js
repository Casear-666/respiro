import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeEvent,
  parseBackup,
  mergeEvents,
  createBackup,
} from "../shared/domain.js";

export function openCalendarDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  if (db.prepare("PRAGMA user_version").get().user_version > 1) {
    db.close();
    throw new Error("数据库来自更新的版本，请先升级软件");
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const selectEvents = db.prepare("SELECT payload FROM events");
  const selectSettings = db.prepare("SELECT key,value FROM settings");
  const list = () =>
    selectEvents.all().map((r) => normalizeEvent(JSON.parse(r.payload)));
  const upsert = db.prepare(
    "INSERT INTO events (id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE events.payload <> excluded.payload",
  );
  const remove = db.prepare("DELETE FROM events WHERE id=?");
  const set = db.prepare(
    "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value <> excluded.value",
  );
  const transaction = (operation) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const prepareImport = (raw) => {
    const incoming = parseBackup(raw);
    return {
      count: incoming.length,
      commit() {
        if (incoming.length === 0) return { added: 0, skipped: 0 };
        const merged = mergeEvents(list(), incoming);
        if (merged.addedEvents.length > 0) {
          transaction(() =>
            merged.addedEvents.forEach((e) =>
              upsert.run(e.id, JSON.stringify(e)),
            ),
          );
        }
        return { added: merged.added, skipped: merged.skipped };
      },
    };
  };
  return {
    list,
    apply({ upserts = [], deletes = [] }) {
      if (
        !Array.isArray(upserts) ||
        !Array.isArray(deletes) ||
        upserts.length + deletes.length > 50000
      )
        throw new Error("日程变更无效");
      if (upserts.length === 0 && deletes.length === 0) return { ok: true };
      const safe = upserts.map(normalizeEvent);
      transaction(() => {
        safe.forEach((e) => upsert.run(e.id, JSON.stringify(e)));
        deletes.forEach((id) => remove.run(String(id)));
      });
      return { ok: true };
    },
    prepareImport,
    import(raw) {
      return prepareImport(raw).commit();
    },
    export: () => createBackup(list()),
    backup(directory) {
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(
        directory,
        `calendar-${new Date().toISOString().slice(0, 10)}.json`,
      );
      if (!fs.existsSync(file)) {
        const temporary = `${file}.tmp`;
        fs.writeFileSync(temporary, createBackup(list()), "utf8");
        fs.renameSync(temporary, file);
      }
      const old = fs
        .readdirSync(directory)
        .filter((f) => /^calendar-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse()
        .slice(14);
      old.forEach((f) => fs.unlinkSync(path.join(directory, f)));
      return file;
    },
    getSettings() {
      return Object.fromEntries(
        selectSettings.all().map((r) => [r.key, JSON.parse(r.value)]),
      );
    },
    setSettings(settings) {
      const allowed = [
        "theme",
        "defaultView",
        "weekStart",
        "showWeekends",
        "workStart",
        "workEnd",
      ];
      const entries = Object.entries(settings).filter(([k]) =>
        allowed.includes(k),
      );
      if (entries.length === 0) return;
      transaction(() =>
        entries.forEach(([k, v]) => set.run(k, JSON.stringify(v))),
      );
    },
    close() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
