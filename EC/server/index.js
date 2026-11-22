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
const allowRegistration = process.env.CALENDAR_ALLOW_REGISTRATION !== "false";
const trustProxy = process.env.CALENDAR_TRUST_PROXY === "true";
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

const ai = {};
if (process.env.GEMINI_API_KEY?.trim()) {
  ai.apiKey = process.env.GEMINI_API_KEY.trim();
}
if (process.env.GEMINI_API_BASE_URL?.trim()) {
  const rawBaseUrl = process.env.GEMINI_API_BASE_URL.trim();
  try {
    const parsed = new URL(rawBaseUrl);
    const isLoopbackHttp =
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !isLoopbackHttp) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid base url");
    }
    ai.baseUrl = rawBaseUrl.replace(/\/+$/, "");
  } catch {
    fail("GEMINI_API_BASE_URL 需要有效的 HTTPS 地址或本机 HTTP 地址，且不能包含账号信息或查询参数");
  }
}
if (process.env.GEMINI_CAPTURE_MODEL?.trim()) {
  ai.captureModel = process.env.GEMINI_CAPTURE_MODEL.trim();
}
if (process.env.GEMINI_TRANSCRIBE_MODEL?.trim()) {
  ai.transcribeModel = process.env.GEMINI_TRANSCRIBE_MODEL.trim();
}
if (process.env.GEMINI_DECISION_MODEL?.trim()) {
  ai.decisionModel = process.env.GEMINI_DECISION_MODEL.trim();
}
if (process.env.GEMINI_TIMEOUT_MS?.trim()) {
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS.trim());
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 300000) {
    fail("GEMINI_TIMEOUT_MS 需要 5000–300000 的整数（毫秒）");
  }
  ai.timeoutMs = timeoutMs;
}

let aiRateLimit = 15;
if (process.env.GEMINI_AI_RATE_LIMIT?.trim()) {
  const limit = Number(process.env.GEMINI_AI_RATE_LIMIT.trim());
  if (!Number.isInteger(limit) || limit < 1 || limit > 600) {
    fail("GEMINI_AI_RATE_LIMIT 需要 1–600 的整数");
  }
  aiRateLimit = limit;
}

const { server, close } = createCalendarServer({
  dataDir,
  distDir,
  secureCookies,
  publicOrigin,
  allowRegistration,
  trustProxy,
  ai,
  aiRateLimit,
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
