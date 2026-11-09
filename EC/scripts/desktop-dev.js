import { createServer } from "vite";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const server = await createServer({
  server: { host: "127.0.0.1", port: 5180, strictPort: false },
});
await server.listen();
const url = server.resolvedUrls.local[0];
const environment = { ...process.env, CALENDAR_DEV_URL: url };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), ["."], {
  env: environment,
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code || 0);
});
process.on("SIGINT", () => {
  child.kill();
});
