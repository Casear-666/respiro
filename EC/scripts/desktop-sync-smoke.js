import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCalendarServer } from "../server/app.js";
import { openAccountStore } from "../server/accounts.js";

const root = process.cwd(), tempRoot = path.join(root, "artifacts", "tmp");
fs.mkdirSync(tempRoot, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(tempRoot, "desktop-http-"));
const password = `A${randomUUID()}`;
const accounts = openAccountStore(path.join(dataDir, "accounts.sqlite"));
await accounts.createUser("smoke-user", password); accounts.close();
const server = createCalendarServer({ dataDir, distDir: path.join(root, "dist") });
await new Promise(resolve => server.server.listen(0, "127.0.0.1", resolve));
const executable = process.argv[2] || createRequire(import.meta.url)("electron");
try {
  const args = process.argv[2] ? ["--smoke-test"] : [".", "--smoke-test"];
  const code = await new Promise((resolve, reject) => {
    const env = {
      ...process.env, CALENDAR_SMOKE_SERVER_ORIGIN: `http://127.0.0.1:${server.server.address().port}`,
      CALENDAR_SMOKE_PASSWORD: password, CALENDAR_SMOKE_SCREENSHOT: path.join(root, "artifacts", "sync-settings.png"),
      CALENDAR_SMOKE_REGISTRATION_SCREENSHOT: path.join(root, "artifacts", "registration-settings.png"),
      CALENDAR_SMOKE_LIGHT_SCREENSHOT: path.join(root, "artifacts", "light-calendar.png"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: "inherit", env });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Desktop sync smoke timed out")); }, 60000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); resolve(code); });
  });
  if (code !== 0) throw new Error(`Desktop smoke failed (${code})`);
} finally {
  await server.close();
  if (path.dirname(dataDir) !== tempRoot) throw new Error("Unexpected smoke directory");
  fs.rmSync(dataDir, { recursive: true, force: true });
}
