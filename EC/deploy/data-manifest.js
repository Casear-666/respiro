import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function dataManifest(directory) {
  const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const accounts = new DatabaseSync(path.join(directory, "accounts.sqlite"), { readOnly: true });
  let users;
  try { users = accounts.prepare("SELECT id,username,password_hash,created_at FROM users ORDER BY id").all(); }
  finally { accounts.close(); }
  return { accounts: hash(users), calendars: users.map(user => {
    const filename = path.join(directory, "users", user.id, "calendar.sqlite");
    if (!fs.existsSync(filename)) return { id: user.id, events: 0, hash: hash({ events: [], settings: [] }) };
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const events = db.prepare("SELECT id,payload FROM events ORDER BY id").all();
      const settings = db.prepare("SELECT key,value FROM settings ORDER BY key").all();
      return { id: user.id, events: events.length, hash: hash({ events, settings }) };
    } finally { db.close(); }
  }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(dataManifest(process.argv[2])) + "\n");
