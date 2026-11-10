import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openAccountStore } from "./accounts.js";
import { openCalendarDatabase } from "../desktop/database.js";
import pkg from "../package.json" with { type: "json" };

const COOKIE_NAME = "calendar_session";
const COOKIE_BASE = `HttpOnly; SameSite=Strict; Path=/`;
const LOGIN_BODY_LIMIT = 8 * 1024;
const CALENDAR_BODY_LIMIT = 20 * 1024 * 1024;
const LOGIN_ATTEMPTS = 10,
  LOGIN_WINDOW = 60000;
const MAX_CALENDARS = 32;
const REQUEST_TIMEOUT = 15000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

const WRITE_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/events/apply",
  "PATCH /api/settings",
  "POST /api/import",
]);
const READ_ROUTES = new Set([
  "GET /api/health",
  "GET /api/runtime.js",
  "GET /api/auth/me",
  "GET /api/events",
  "GET /api/settings",
  "GET /api/info",
  "GET /api/export",
]);
const KNOWN_PATHS = new Set(
  [...WRITE_ROUTES, ...READ_ROUTES].map((r) => r.split(" ")[1]),
);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMinutes = (value) =>
  value === "24:00"
    ? 1440
    : Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const SETTING_RULES = {
  theme: (v) => ["light", "dark", "system"].includes(v),
  defaultView: (v) =>
    ["dayGridMonth", "timeGridWeek", "timeGridDay"].includes(v),
  weekStart: (v) => v === 0 || v === 1,
  showWeekends: (v) => typeof v === "boolean",
  workStart: (v) => typeof v === "string" && HHMM.test(v),
  workEnd: (v) => typeof v === "string" && (HHMM.test(v) || v === "24:00"),
};

const parseCookies = (req) => {
  const jar = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return jar;
};

const tooLarge = () => Object.assign(new Error("请求体过大"), { status: 413 });
const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0,
      over = false;
    req.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(tooLarge());
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export function createCalendarServer({
  dataDir,
  distDir,
  secureCookies = false,
  publicOrigin,
  now = Date.now,
}) {
  const accounts = openAccountStore(path.join(dataDir, "accounts.sqlite"), {
    now,
  });
  const calendars = new Map();
  const userDir = (id) => path.join(dataDir, "users", id);
  const calendarFor = (user) => {
    let entry = calendars.get(user.id);
    if (entry) {
      calendars.delete(user.id);
      calendars.set(user.id, entry);
      entry.used = now();
      return entry.db;
    }
    const dir = userDir(user.id);
    const db = openCalendarDatabase(path.join(dir, "calendar.sqlite"));
    try {
      db.backup(path.join(dir, "backups", "daily"));
    } catch (error) {
      console.warn(`日历每日备份失败（账号 ${user.id}）：${error.message}`);
    }
    calendars.set(user.id, { db, used: now() });
    if (calendars.size > MAX_CALENDARS) {
      const [oldest, oldestEntry] = calendars.entries().next().value;
      if (oldest !== user.id) {
        calendars.delete(oldest);
        try {
          oldestEntry.db.close();
        } catch {}
      }
    }
    return db;
  };

  const attempts = new Map();
  const loginAllowed = (address) => {
    const t = now();
    if (attempts.size >= 1024)
      for (const [key, value] of attempts)
        if (value.resetAt <= t) attempts.delete(key);
    if (!attempts.has(address) && attempts.size >= 1024) return false;
    let entry = attempts.get(address);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + LOGIN_WINDOW };
      attempts.set(address, entry);
    }
    entry.count++;
    return entry.count <= LOGIN_ATTEMPTS;
  };

  const cookieHeader = (value, maxAge) =>
    `${COOKIE_NAME}=${value}; ${COOKIE_BASE}; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;

  const jsonHeaders = (extra = {}) => ({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  const sendJson = (res, status, body, headers) => {
    res.writeHead(status, jsonHeaders(headers));
    res.end(JSON.stringify(body));
  };
  const sendError = (res, status, message, headers) =>
    sendJson(res, status, { error: message }, headers);

  let indexHtml;
  const serveIndex = () => {
    if (indexHtml === undefined) {
      const raw = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
      indexHtml = raw.replace(
        /<head[^>]*>/i,
        (tag) => `${tag}\n    <script src="/api/runtime.js"></script>`,
      );
    }
    return indexHtml;
  };

  const serveStatic = (req, res, pathname) => {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendError(res, 400, "请求路径无效");
    }
    if (decoded.includes("\\") || decoded.includes("\0"))
      return sendError(res, 404, "资源不存在");
    const segments = decoded.split("/").filter(Boolean);
    if (segments.some((s) => s === ".." || s.startsWith(".")))
      return sendError(res, 404, "资源不存在");
    const normalized = path.posix.normalize(decoded);
    const extension = path.posix.extname(normalized);
    if (!extension || normalized === "/index.html") {
      let html;
      try {
        html = serveIndex();
      } catch {
        return sendError(res, 404, "资源不存在");
      }
      res.writeHead(200, {
        "Content-Type": MIME[".html"],
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(req.method === "HEAD" ? undefined : html);
    }
    const root = path.resolve(distDir);
    const file = path.resolve(root, `.${normalized}`);
    if (file !== root && !file.startsWith(`${root}${path.sep}`))
      return sendError(res, 404, "资源不存在");
    let stat, real;
    try {
      stat = fs.statSync(file);
      real = fs.realpathSync(file);
    } catch {
      return sendError(res, 404, "资源不存在");
    }
    if (!stat.isFile()) return sendError(res, 404, "资源不存在");
    if (real !== root && !real.startsWith(`${root}${path.sep}`))
      return sendError(res, 404, "资源不存在");
    res.writeHead(200, {
      "Content-Type": MIME[extension.toLowerCase()] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": normalized.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, "http://internal.invalid");
    const pathname = url.pathname;
    const method = req.method;
    if (!pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD")
        return sendError(res, 405, "方法不允许");
      return serveStatic(req, res, pathname);
    }

    const expectedOrigin =
      publicOrigin ||
      `${secureCookies ? "https" : "http"}://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== expectedOrigin)
      return sendError(res, 403, "请求来源不被允许");

    if (!KNOWN_PATHS.has(pathname))
      return sendError(res, 404, "资源不存在");
    const route = `${method} ${pathname}`;
    if (!WRITE_ROUTES.has(route) && !READ_ROUTES.has(route))
      return sendError(res, 405, "方法不允许");

    if (pathname === "/api/health") return sendJson(res, 200, { ok: true });
    if (pathname === "/api/runtime.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end("globalThis.__CALENDAR_SERVER__ = true;");
    }

    const isWrite = WRITE_ROUTES.has(route);
    let body = null;
    if (isWrite) {
      if (req.headers["x-calendar-request"] !== "1")
        return sendError(res, 403, "请求来源不被允许");
      const type = String(req.headers["content-type"] || "")
        .split(";")[0]
        .trim();
      if (type !== "application/json")
        return sendError(res, 400, "请求需要 application/json");
      const limit =
        pathname === "/api/auth/login" || pathname === "/api/auth/logout"
          ? LOGIN_BODY_LIMIT
          : CALENDAR_BODY_LIMIT;
      let raw;
      try {
        raw = await readBody(req, limit);
      } catch (error) {
        if (error.status === 413) {
          // Keep draining (readBody discards chunks) and answer once the
          // upload finishes so the socket closes cleanly instead of RST.
          req.resume();
          const refuse = () => {
            if (!res.writableEnded && !res.destroyed)
              sendError(res, 413, "请求体过大", { Connection: "close" });
          };
          if (req.complete || req.readableEnded) refuse();
          else {
            req.once("end", refuse);
            req.once("aborted", refuse);
          }
          return;
        }
        throw error;
      }
      if (pathname === "/api/import") {
        body = raw.toString("utf8");
      } else {
        try {
          body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
        } catch {
          return sendError(res, 400, "请求 JSON 无法解析");
        }
      }
    }

    if (route === "POST /api/auth/login") {
      if (!loginAllowed(req.socket.remoteAddress))
        return sendError(res, 429, "尝试过于频繁，请稍后再试");
      if (
        !body ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      )
        return sendError(res, 400, "请求格式不正确");
      const user = await accounts.authenticate(body.username, body.password);
      if (!user) return sendError(res, 401, "用户名或密码不正确");
      accounts.revokeSession(parseCookies(req)[COOKIE_NAME]);
      const { token } = accounts.createSession(user.id);
      return sendJson(res, 200, { user }, {
        "Set-Cookie": cookieHeader(token, 604800),
      });
    }

    const user = accounts.session(parseCookies(req)[COOKIE_NAME]);
    if (route === "POST /api/auth/logout") {
      accounts.revokeSession(parseCookies(req)[COOKIE_NAME]);
      return sendJson(res, 200, { ok: true }, {
        "Set-Cookie": cookieHeader("", 0),
      });
    }
    if (!user) return sendError(res, 401, "需要登录");

    const calendar = () => calendarFor(user);

    if (route === "GET /api/auth/me") return sendJson(res, 200, { user });
    if (route === "GET /api/events") return sendJson(res, 200, calendar().list());
    if (route === "POST /api/events/apply") {
      if (!body || typeof body !== "object" || Array.isArray(body))
        return sendError(res, 400, "日程变更无效");
      const { upserts = [], deletes = [] } = body;
      if (!Array.isArray(upserts) || !Array.isArray(deletes))
        return sendError(res, 400, "日程变更无效");
      if (upserts.some((e) => !e || typeof e !== "object" || Array.isArray(e)))
        return sendError(res, 400, "日程格式不正确");
      if (
        deletes.some(
          (id) => typeof id !== "string" || !id || id.length > 120,
        )
      )
        return sendError(res, 400, "日程变更无效");
      try {
        calendar().apply({ upserts, deletes });
      } catch (error) {
        if (error.code) throw error;
        return sendError(res, 400, error.message || "日程变更无效");
      }
      return sendJson(res, 200, { ok: true });
    }
    if (route === "GET /api/settings")
      return sendJson(res, 200, calendar().getSettings());
    if (route === "PATCH /api/settings") {
      if (!body || typeof body !== "object" || Array.isArray(body))
        return sendError(res, 400, "偏好设置无效");
      const keys = Object.keys(body);
      if (keys.some((key) => !Object.hasOwn(SETTING_RULES, key)))
        return sendError(res, 400, "包含未知的偏好设置项");
      if (keys.some((key) => !SETTING_RULES[key](body[key])))
        return sendError(res, 400, "偏好设置的取值无效");
      const merged = {
        workStart: "08:00",
        workEnd: "22:00",
        ...calendar().getSettings(),
        ...body,
      };
      if (!(toMinutes(merged.workEnd) > toMinutes(merged.workStart)))
        return sendError(res, 400, "工作结束时间需要晚于开始时间");
      calendar().setSettings(body);
      return sendJson(res, 200, { ok: true });
    }
    if (route === "GET /api/info")
      return sendJson(res, 200, {
        version: pkg.version,
        desktop: false,
        server: true,
      });
    if (route === "GET /api/export") {
      const payload = calendar().export();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="energy-calendar-backup.json"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(payload);
    }
    if (route === "POST /api/import") {
      const db = calendar();
      let prepared;
      try {
        prepared = db.prepareImport(body);
      } catch (error) {
        return sendError(res, 400, error.message || "备份文件无效");
      }
      const backups = path.join(userDir(user.id), "backups");
      const snapshot = path.join(
        backups,
        `before-import-${now()}-${randomBytes(4).toString("hex")}.json`,
      );
      try {
        fs.mkdirSync(backups, { recursive: true });
        fs.writeFileSync(snapshot, db.export(), "utf8");
      } catch (error) {
        console.error(`导入前备份失败（账号 ${user.id}）：${error.message}`);
        return sendError(res, 500, "导入前备份失败，未导入任何数据");
      }
      return sendJson(res, 200, prepared.commit());
    }
    return sendError(res, 404, "资源不存在");
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error("服务器内部错误：", error);
      if (!res.headersSent)
        sendError(res, 500, "服务器内部错误");
      else res.end();
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT;
  server.headersTimeout = REQUEST_TIMEOUT + 1000;

  let closed = false;
  return {
    server,
    async close() {
      if (closed) return;
      closed = true;
      if (server.listening) {
        const drained = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeIdleConnections?.();
        await drained;
      }
      for (const entry of calendars.values()) {
        try {
          entry.db.close();
        } catch {}
      }
      calendars.clear();
      accounts.close();
    },
  };
}
