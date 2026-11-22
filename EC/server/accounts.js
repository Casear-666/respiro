import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { usernameError, passwordError } from "../shared/auth.js";
import { promisify } from "node:util";
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const DUMMY_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;

const hashToken = (token) =>
  createHash("sha256").update(token).digest("hex");

export function openAccountStore(filename, { now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS registration_attempts (
      address_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL
    );`);
  const insertUser = db.prepare(
    "INSERT INTO users (id,username,password_hash,created_at) VALUES (?,?,?,?)",
  );
  const findUser = db.prepare(
    "SELECT id,username,password_hash FROM users WHERE username=?",
  );
  const insertSession = db.prepare(
    "INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
  );
  const findSession = db.prepare(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=? AND s.expires_at>?`,
  );
  const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash=?");
  const deleteExpired = db.prepare("DELETE FROM sessions WHERE expires_at<=?");
  const transaction = action => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const prepareUser = async (username, password) => {
    const invalid = usernameError(username) || passwordError(password);
    if (invalid) throw Object.assign(new Error(invalid), { status: 400 });
    const name = username.trim();
    if (findUser.get(name)) throw Object.assign(new Error("用户名已被使用"), { status: 409 });
    const salt = randomBytes(16), key = await scryptAsync(password, salt, 64, SCRYPT);
    return { id: randomUUID(), username: name, hash: `scrypt$${salt.toString("hex")}$${key.toString("hex")}` };
  };
  const commitUser = record => {
    try { insertUser.run(record.id, record.username, record.hash, now()); }
    catch (error) {
      if (error.errcode === 2067 || /UNIQUE constraint failed: users\.username/.test(error.message))
        throw Object.assign(new Error("用户名已被使用"), { status: 409 });
      throw error;
    }
    return { id: record.id, username: record.username };
  };
  const createSession = userId => {
    deleteExpired.run(now());
    const token = randomBytes(32).toString("base64url"), expiresAt = now() + SESSION_TTL;
    insertSession.run(hashToken(token), userId, expiresAt);
    return { token, expiresAt };
  };
  return {
    async createUser(username, password) {
      return commitUser(await prepareUser(username, password));
    },
    async register(username, password) {
      // scrypt runs before the transaction; only the short, synchronous commit holds the SQLite lock.
      const record = await prepareUser(username, password);
      return transaction(() => { const user = commitUser(record); return { user, ...createSession(user.id) }; });
    },
    consumeRegistrationAttempt(address, { limit = 5, windowMs = 15 * 60 * 1000 } = {}) {
      return transaction(() => {
        const time = now(), key = hashToken(String(address));
        db.prepare("DELETE FROM registration_attempts WHERE reset_at<=?").run(time);
        const row = db.prepare("SELECT attempts FROM registration_attempts WHERE address_hash=?").get(key);
        if ((row?.attempts ?? 0) >= limit || (!row && db.prepare("SELECT count(*) n FROM registration_attempts").get().n >= 4096)) return false;
        db.prepare(`INSERT INTO registration_attempts VALUES (?,1,?) ON CONFLICT(address_hash)
          DO UPDATE SET attempts=registration_attempts.attempts+1`).run(key, time + windowMs);
        return true;
      });
    },
    async authenticate(username, password) {
      const row =
        typeof username === "string" ? findUser.get(username.trim()) : null;
      const [, saltHex, keyHex] = (row?.password_hash ?? DUMMY_HASH).split("$");
      let matched = false;
      try {
        const key = await scryptAsync(
          String(password ?? ""),
          Buffer.from(saltHex, "hex"),
          64,
          SCRYPT,
        );
        matched = timingSafeEqual(key, Buffer.from(keyHex, "hex"));
      } catch {
        matched = false;
      }
      if (!row || !matched) return null;
      return { id: row.id, username: row.username };
    },
    createSession,
    session(token) {
      if (typeof token !== "string" || !token) return null;
      const row = findSession.get(hashToken(token), now());
      return row ? { id: row.id, username: row.username } : null;
    },
    revokeSession(token) {
      if (typeof token === "string" && token)
        deleteSession.run(hashToken(token));
    },
    close() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
