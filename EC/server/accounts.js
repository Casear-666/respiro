import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
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
const USERNAME = /^[A-Za-z0-9_.@-]{3,64}$/;
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
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);`);
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
  return {
    async createUser(username, password) {
      const name = String(username ?? "").trim();
      if (!USERNAME.test(name))
        throw new Error("用户名需要 3–64 个字符：字母、数字或 _ . @ -");
      if (
        typeof password !== "string" ||
        password.length < 12 ||
        password.length > 128
      )
        throw new Error("密码需要 12–128 个字符");
      const salt = randomBytes(16);
      const key = await scryptAsync(password, salt, 64, SCRYPT);
      const id = randomUUID();
      try {
        insertUser.run(
          id,
          name,
          `scrypt$${salt.toString("hex")}$${key.toString("hex")}`,
          now(),
        );
      } catch (error) {
        if (String(error.message).includes("UNIQUE"))
          throw new Error("用户名已被使用");
        throw error;
      }
      return { id, username: name };
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
    createSession(userId) {
      deleteExpired.run(now());
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + SESSION_TTL;
      insertSession.run(hashToken(token), userId, expiresAt);
      return { token, expiresAt };
    },
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
