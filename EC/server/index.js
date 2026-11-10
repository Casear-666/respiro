import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCalendarServer } from "./app.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fail = (message) => {
  console.error(`配置无效：${message}`);
  process.exit(1);
};

const host = process.env.CALENDAR_HOST || "127.0.0.1";
const port = Number(process.env.CALENDAR_PORT || "3001");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  fail("CALENDAR_PORT 需要 1–65535 的整数");
const dataDir = path.resolve(process.env.CALENDAR_DATA_DIR || path.join(root, "data"));
const distDir = path.resolve(process.env.CALENDAR_DIST_DIR || path.join(root, "dist"));
const secureCookies = process.env.CALENDAR_SECURE_COOKIE === "true";
let publicOrigin;
if (process.env.CALENDAR_PUBLIC_ORIGIN) {
  try {
    const origin = new URL(process.env.CALENDAR_PUBLIC_ORIGIN);
    if (!/^https?:$/.test(origin.protocol) || origin.origin !== process.env.CALENDAR_PUBLIC_ORIGIN)
      throw new Error("not an origin");
    publicOrigin = origin.origin;
  } catch {
    fail("CALENDAR_PUBLIC_ORIGIN 需要 https://域名 这样的来源地址");
  }
}

const { server, close } = createCalendarServer({
  dataDir,
  distDir,
  secureCookies,
  publicOrigin,
});
server.listen(port, host, () => {
  console.log(`精力日历服务器已启动：http://${host}:${server.address().port}`);
  if (!fs.existsSync(path.join(distDir, "index.html")))
    console.warn(`警告：${distDir} 缺少构建产物，请先运行 npm run build`);
});
const shutdown = () => {
  close()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("关闭服务器失败：", error);
      process.exit(1);
    });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
