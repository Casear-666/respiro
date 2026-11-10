import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCalendarDatabase } from "../../desktop/database.js";
const event = {
  id: "42",
  title: "数据库持久化测试",
  start: "2026-10-20T09:00:00+08:00",
  end: "2026-10-20T10:00:00+08:00",
  tag: "work",
};
const withDatabase = (callback) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-test-"));
  let db = openCalendarDatabase(path.join(directory, "calendar.sqlite"));
  try {
    callback(db, directory);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
const withWriteLog = (directory, callback) => {
  const observer = new DatabaseSync(path.join(directory, "calendar.sqlite"));
  try {
    observer.exec("CREATE TABLE write_log (operation TEXT NOT NULL)");
    for (const table of ["events", "settings"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        observer.exec(`CREATE TRIGGER log_${table}_${operation}
          AFTER ${operation} ON ${table}
          BEGIN INSERT INTO write_log VALUES ('${table}:${operation}'); END;`);
      }
    }
    callback({
      sql: observer,
      writes: () => observer.prepare("SELECT operation FROM write_log ORDER BY rowid").all().map((row) => row.operation),
      clear: () => observer.exec("DELETE FROM write_log"),
    });
  } finally {
    observer.close();
  }
};
test("SQLite commits CRUD, remains readable after reopening, and retains preferences", () =>
  withDatabase((db, directory) => {
    db.apply({ upserts: [event] });
    db.setSettings({ theme: "dark", weekStart: 0, untrusted: "ignored" });
    const second = openCalendarDatabase(
      path.join(directory, "calendar.sqlite"),
    );
    assert.equal(second.list()[0].title, event.title);
    assert.deepEqual(second.getSettings(), { theme: "dark", weekStart: 0 });
    second.close();
    db.apply({ upserts: [{ ...event, title: "已改期" }] });
    assert.equal(db.list()[0].title, "已改期");
    db.apply({ deletes: ["42"] });
    assert.equal(db.list().length, 0);
  }));
test("one invalid event aborts an entire change, including deletions", () =>
  withDatabase((db) => {
    db.apply({ upserts: [event] });
    assert.throws(() =>
      db.apply({
        deletes: ["42"],
        upserts: [
          { ...event, id: "43" },
          { ...event, id: "44", end: "bad" },
        ],
      }),
    );
    assert.equal(db.list().length, 1);
    assert.equal(db.list()[0].id, "42");
  }));
test("imports merge rather than overwrite; repeated imports are idempotent", () =>
  withDatabase((db) => {
    db.apply({ upserts: [event] });
    const raw = JSON.stringify([
      { ...event, id: 42 },
      { ...event, id: 42, title: "旧文件中另一个日程" },
    ]);
    assert.deepEqual(db.import(raw), { added: 1, skipped: 1 });
    assert.equal(db.list().length, 2);
    assert.equal(db.import(raw).added, 0);
    assert.throws(() => db.import('[{"title":"坏记录"}]'));
    assert.equal(db.list().length, 2);
  }));
test("daily backups are valid JSON and rotation retains 14 snapshots", () =>
  withDatabase((db, directory) => {
    db.apply({ upserts: [event] });
    const backupDir = path.join(directory, "backups");
    fs.mkdirSync(backupDir);
    for (let day = 1; day <= 20; day++)
      fs.writeFileSync(
        path.join(
          backupDir,
          `calendar-2025-01-${String(day).padStart(2, "0")}.json`,
        ),
        "[]",
      );
    const filename = db.backup(backupDir);
    assert.equal(
      JSON.parse(fs.readFileSync(filename, "utf8")).events[0].title,
      event.title,
    );
    assert.equal(fs.readdirSync(backupDir).length, 14);
  }));
test("imports only write new records and duplicate imports do not write", () =>
  withDatabase((db, directory) => {
    db.apply({ upserts: [event, { ...event, id: "stable", title: "Keep me" }] });
    const before = db.list();
    withWriteLog(directory, ({ writes, clear }) => {
      const raw = JSON.stringify([
        event,
        { ...event, title: "Imported collision" },
        { ...event, id: "new", title: "New event" },
        { ...event, id: "duplicate-copy", title: "New event" },
      ]);
      assert.deepEqual(db.import(raw), { added: 2, skipped: 2 });
      assert.deepEqual(writes(), ["events:INSERT", "events:INSERT"]);
      const rows = db.list();
      for (const original of before)
        assert.deepEqual(rows.find((row) => row.id === original.id), original);
      assert.notEqual(rows.find((row) => row.title === "Imported collision").id, event.id);
      assert.equal(rows.length, 4);
      clear();
      assert.deepEqual(db.import(raw), { added: 0, skipped: 4 });
      assert.deepEqual(writes(), []);
      assert.deepEqual(db.list(), rows);
    });
  }));

test("preparing an import validates without writes and commits against current records", () =>
  withDatabase((db) => {
    const prepared = db.prepareImport(JSON.stringify([{ ...event, title: "From backup" }]));
    assert.equal(prepared.count, 1);
    assert.deepEqual(db.list(), []);
    db.apply({ upserts: [{ ...event, title: "Created while confirming" }] });
    assert.deepEqual(prepared.commit(), { added: 1, skipped: 0 });
    const rows = db.list();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === event.id).title, "Created while confirming");
    assert.notEqual(rows.find((row) => row.title === "From backup").id, event.id);
    assert.deepEqual(prepared.commit(), { added: 0, skipped: 1 });
    assert.throws(() => db.prepareImport(JSON.stringify([event, { ...event, id: "bad", end: "invalid" }])));
    assert.deepEqual(db.list(), rows);
    assert.deepEqual(db.prepareImport("[]").commit(), { added: 0, skipped: 0 });
  }));

test("an import failure rolls back earlier inserted records", () =>
  withDatabase((db, directory) => {
    db.apply({ upserts: [event] });
    const before = db.list();
    withWriteLog(directory, ({ sql, writes }) => {
      sql.exec(`CREATE TRIGGER reject_import BEFORE INSERT ON events
        WHEN NEW.id = 'reject-me'
        BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;`);
      assert.throws(() => db.import(JSON.stringify([
        { ...event, id: "first-new", title: "First addition" },
        { ...event, id: "reject-me", title: "Rejected addition" },
      ])), /injected import failure/);
      assert.deepEqual(db.list(), before);
      assert.deepEqual(writes(), []);
    });
  }));

test("unchanged writes are skipped while edits and deletions still persist", () =>
  withDatabase((db, directory) => {
    db.apply({ upserts: [event] });
    db.setSettings({ theme: "dark" });
    withWriteLog(directory, ({ writes, clear, sql }) => {
      sql.exec("BEGIN IMMEDIATE");
      try {
        assert.deepEqual(db.apply({}), { ok: true });
        db.setSettings({ unknown: "ignored" });
      } finally {
        sql.exec("ROLLBACK");
      }
      db.apply({ upserts: [event] });
      db.setSettings({ theme: "dark" });
      assert.deepEqual(writes(), []);
      db.apply({ upserts: [{ ...event, title: "Updated" }] });
      db.setSettings({ theme: "light" });
      assert.deepEqual(writes(), ["events:UPDATE", "settings:UPDATE"]);
      assert.equal(db.list()[0].title, "Updated");
      assert.equal(db.getSettings().theme, "light");
      clear();
      db.apply({ deletes: [event.id] });
      assert.deepEqual(writes(), ["events:DELETE"]);
      assert.deepEqual(db.list(), []);
    });
  }));
test("confirmBeforeDelete preference round-trips through settings storage", () =>
  withDatabase((db) => {
    db.setSettings({ confirmBeforeDelete: false });
    assert.equal(db.getSettings().confirmBeforeDelete, false);
    db.setSettings({ confirmBeforeDelete: true });
    assert.equal(db.getSettings().confirmBeforeDelete, true);
  }));
