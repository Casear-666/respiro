import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// A disposable account exercises the real reverse proxy. No calendar is opened or modified.
const [dataDir, origin] = process.argv.slice(2);
const username = `verify-${randomUUID()}`, password = `A${randomBytes(4).toString("hex").slice(0, 7)}`;
const db = new DatabaseSync(path.join(dataDir, "accounts.sqlite"));
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
assert.equal(db.prepare("SELECT id FROM users WHERE username=?").get(username), undefined);
const request = async (route, body, cookie) => {
  const response = await fetch(`${origin}${route}`, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(10000),
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Calendar-Request": "1" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
};
try {
  assert.equal((await request("/api/auth/options")).body.registrationEnabled, true);
  const registered = await request("/api/auth/register", { username, password });
  assert.equal(registered.status, 201, registered.body.error);
  assert.equal(Boolean(registered.cookie), true);
  assert.equal((await request("/api/auth/me", undefined, registered.cookie)).body.user.id, registered.body.user.id);
  assert.equal((await request("/api/auth/logout", {}, registered.cookie)).status, 200);
  const login = await request("/api/auth/login", { username, password }); assert.equal(login.status, 200);
  assert.equal((await request("/api/auth/me", undefined, login.cookie)).body.user.id, registered.body.user.id);
  assert.equal((await request("/api/auth/logout", {}, login.cookie)).status, 200);
  console.log(JSON.stringify({ registrationVerified: true, eightCharacterPassword: true, automaticLogin: true, loginAndLogout: true, reverseProxy: true }));
} finally {
  // Delete only the unique account created by this verifier; foreign keys remove its sessions.
  db.prepare("DELETE FROM users WHERE username=?").run(username);
  db.close();
}
