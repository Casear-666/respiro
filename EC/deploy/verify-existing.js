import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openAccountStore } from "../server/accounts.js";
import { dataManifest } from "./data-manifest.js";
import pkg from "../package.json" with { type: "json" };

const [dataDir, origin, manifestFile] = process.argv.slice(2);
const db = new DatabaseSync(path.join(dataDir, "accounts.sqlite"), { readOnly: true });
const user = db.prepare("SELECT id,username FROM users ORDER BY CASE WHEN username='owner' THEN 0 ELSE 1 END,created_at LIMIT 1").get(); db.close();
if (!user) {
  assert.deepEqual(dataManifest(dataDir), JSON.parse(fs.readFileSync(manifestFile, "utf8")));
  const options = await fetch(`${origin}/api/auth/options`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
  assert.equal(typeof options.registrationEnabled, "boolean");
  console.log(JSON.stringify({ verified: true, existingAccounts: 0, schedulesAndAccountsUnchanged: true, registrationEnabled: options.registrationEnabled }));
  process.exit(0);
}
const accounts = openAccountStore(path.join(dataDir, "accounts.sqlite"));
const { token } = accounts.createSession(user.id);
const request = async (url, body) => {
  const response = await fetch(`${origin}${url}`, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(10000),
    headers: { Cookie: `calendar_session=${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Calendar-Request": "1" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
try {
  assert.equal((await request("/api/auth/me")).body.user.id, user.id);
  const events = await request("/api/events"); assert.equal(events.status, 200);
  const snapshot = await request("/api/sync/snapshot"); assert.equal(snapshot.status, 200);
  const changes = await request(`/api/sync/changes?since=0&epoch=${snapshot.body.epoch}`); assert.equal(changes.status, 200);
  assert.equal((await request("/api/sync/conflicts")).status, 200);
  assert.deepEqual((await request("/api/sync/push", { epoch: snapshot.body.epoch, operations: [] })).body, { results: [] });
  assert.equal((await request("/api/events/apply", {})).status, 428);
  const info = (await request("/api/info")).body; assert.equal(info.version, pkg.version);
  const options = await request("/api/auth/options"); assert.equal(options.status, 200);
  assert.equal(typeof options.body.registrationEnabled, "boolean");
  assert.deepEqual(dataManifest(dataDir), JSON.parse(fs.readFileSync(manifestFile, "utf8")));
  assert.equal((await request("/api/auth/logout", {})).status, 200);
  assert.equal((await request("/api/auth/me")).status, 401);
  console.log(JSON.stringify({ verified: true, version: info.version, existingEvents: events.body.length, schedulesAndAccountsUnchanged: true,
    registrationEnabled: options.body.registrationEnabled, syncEndpoints: true, logout: true }));
} finally { accounts.revokeSession(token); accounts.close(); }
