import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { localDate } from "../shared/domain.js";

const GET_CHUNK_SIZE = 200;

/**
 * Computes event duration in positive integer minutes, or null for all-day/invalid spans.
 */
export function eventDurationMinutes(event) {
  if (event?.allDay === true) return null;
  if (!event?.start || !event?.end) return null;
  const startMs = +localDate(event.start);
  const endMs = +localDate(event.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  return Math.round((endMs - startMs) / 60000);
}

/**
 * Generates a content-and-duration fingerprint so rescheduling without edits hits cache.
 */
export function weightFingerprint(event) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        String(event?.title || "").trim(),
        String(event?.tag || "other"),
        String(event?.description || "").trim(),
        event?.allDay === true,
        eventDurationMinutes(event),
      ]),
    )
    .digest("hex");
}

function rowToRecord(row) {
  let probabilities = [];
  try {
    const parsed = JSON.parse(row.probabilities);
    if (Array.isArray(parsed)) probabilities = parsed;
  } catch {
    probabilities = [];
  }
  return {
    id: row.event_id,
    fingerprint: row.fingerprint,
    score: row.score,
    expectedScore: row.expected_score,
    label: row.label,
    confidence: row.confidence,
    probabilities,
    model: row.model,
    updatedAt: row.updated_at,
  };
}

/**
 * Masks an API key so only prefix/suffix hints are exposed to clients.
 */
export function maskApiKey(key) {
  const clean = String(key || "").trim();
  if (!clean) return "";
  if (clean.length <= 8) return "••••";
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

/**
 * Opens a per-user SQLite cache for AI-derived cognitive energy weights and user API settings.
 */
export function openAiCache(filename, { now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (userVersion > 1) {
    db.close();
    throw new Error("AI 缓存数据库来自更新的版本，请先升级服务端");
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA user_version=1;
    CREATE TABLE IF NOT EXISTS cognitive_weights (
      event_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      score INTEGER NOT NULL,
      expected_score REAL NOT NULL,
      label TEXT NOT NULL,
      confidence REAL NOT NULL,
      probabilities TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const selectAll = db.prepare(
    `SELECT event_id, fingerprint, score, expected_score, label, confidence, probabilities, model, updated_at
     FROM cognitive_weights`,
  );
  const upsert = db.prepare(
    `INSERT INTO cognitive_weights
       (event_id, fingerprint, score, expected_score, label, confidence, probabilities, model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       score = excluded.score,
       expected_score = excluded.expected_score,
       label = excluded.label,
       confidence = excluded.confidence,
       probabilities = excluded.probabilities,
       model = excluded.model,
       updated_at = excluded.updated_at`,
  );
  const selectConfig = db.prepare("SELECT key, value FROM ai_settings");
  const upsertConfig = db.prepare(
    `INSERT INTO ai_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const deleteConfig = db.prepare("DELETE FROM ai_settings WHERE key = ?");

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

  const getConfig = () => {
    const map = Object.fromEntries(
      selectConfig.all().map((row) => [row.key, row.value]),
    );
    return {
      mode: map.mode === "custom" ? "custom" : "shared",
      apiKey: String(map.apiKey || ""),
      baseUrl: String(map.baseUrl || ""),
    };
  };

  return {
    getConfig,
    setConfig({ mode, apiKey, baseUrl } = {}) {
      const current = getConfig();
      const nextMode =
        mode === undefined
          ? current.mode
          : mode === "custom"
            ? "custom"
            : "shared";
      const nextKey =
        apiKey === undefined
          ? current.apiKey
          : apiKey === null
            ? ""
            : String(apiKey).trim();
      const nextBaseUrl =
        baseUrl === undefined
          ? current.baseUrl
          : baseUrl === null
            ? ""
            : String(baseUrl).trim().replace(/\/+$/, "");
      transaction(() => {
        upsertConfig.run("mode", nextMode);
        if (nextKey) upsertConfig.run("apiKey", nextKey);
        else deleteConfig.run("apiKey");
        if (nextBaseUrl) upsertConfig.run("baseUrl", nextBaseUrl);
        else deleteConfig.run("baseUrl");
      });
      return {
        mode: nextMode,
        apiKey: nextKey,
        baseUrl: nextBaseUrl,
      };
    },
    getMany(ids) {
      const uniqueIds = [
        ...new Set(
          (Array.isArray(ids) ? ids : [])
            .map((id) => String(id || "").trim())
            .filter(Boolean),
        ),
      ];
      const map = new Map();
      for (let i = 0; i < uniqueIds.length; i += GET_CHUNK_SIZE) {
        const chunk = uniqueIds.slice(i, i + GET_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const stmt = db.prepare(
          `SELECT event_id, fingerprint, score, expected_score, label, confidence, probabilities, model, updated_at
           FROM cognitive_weights
           WHERE event_id IN (${placeholders})`,
        );
        for (const row of stmt.all(...chunk)) {
          const record = rowToRecord(row);
          map.set(record.id, record);
        }
      }
      return map;
    },
    listAll() {
      return selectAll.all().map(rowToRecord);
    },
    putMany(records) {
      if (!Array.isArray(records) || records.length === 0) return;
      transaction(() => {
        for (const record of records) {
          upsert.run(
            String(record.id),
            String(record.fingerprint),
            Number(record.score),
            Number(record.expectedScore),
            String(record.label),
            Number(record.confidence),
            JSON.stringify(
              Array.isArray(record.probabilities) ? record.probabilities : [],
            ),
            String(record.model),
            Number(record.updatedAt ?? now()),
          );
        }
      });
    },
    close() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
