import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openCalendarDatabase } from "./database.js";
import { syncReplica } from "./sync-engine.js";
import { usernameError, passwordError } from "../shared/auth.js";

export function validateServerOrigin(raw) {
  const url = new URL(String(raw));
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("服务器需要 HTTPS 地址或本机 HTTP 地址，且不能含路径和账号信息");
  return url.origin;
}
export const profileKey = (origin, userId) => createHash("sha256").update(JSON.stringify([origin, userId])).digest("hex");

export function createDesktopAccounts({ dataPath, localDatabase, safeStorage, fetchImpl = globalThis.fetch, onChange = () => {} }) {
  const sessionFile = path.join(dataPath, "sync-session.json");
  let active = null, task = null, timer = null, stopped = false, retry = 1000, switching = false;
  let phase = "local", message = "", conflicts = [];
  const requests = new Map();
  const abortRequests = () => { for (const controller of requests.keys()) controller.abort(); };
  const profileDirectory = (origin, user) => path.join(dataPath, "profiles", profileKey(origin, user.id));
  const info = () => ({ phase, message, origin: active?.origin, user: active?.user, conflicts,
    dataPath: active ? profileDirectory(active.origin, active.user) : dataPath,
    ...(active ? active.db.sync.replicaState() : { pending: 0, inflight: 0 }) });
  const notify = () => onChange(info());
  const persist = () => {
    if (!active) { fs.rmSync(sessionFile, { force: true }); return; }
    const record = { origin: active.origin, user: active.user };
    if (active.cookie && safeStorage?.isEncryptionAvailable()) record.encryptedCookie = safeStorage.encryptString(active.cookie).toString("base64");
    fs.writeFileSync(`${sessionFile}.tmp`, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(`${sessionFile}.tmp`, sessionFile);
  };
  const requestFor = (account) => async (route, body) => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    requests.set(controller, account);
    try {
      const response = await fetchImpl(`${account.origin}${route}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
        headers: { ...(account.cookie ? { Cookie: account.cookie } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Calendar-Request": "1" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || "服务器请求失败"), { status: response.status });
      if (route === "/api/auth/login" || route === "/api/auth/register") {
        const cookie = response.headers.get("set-cookie")?.match(/(?:^|,\s*)calendar_session=([A-Za-z0-9_-]+)/)?.[1];
        if (!cookie) throw new Error("服务器未返回登录会话");
        account.cookie = `calendar_session=${cookie}`;
      }
      return result;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  };
  const schedule = (delay = 500) => {
    clearTimeout(timer);
    if (active && !stopped) { timer = setTimeout(() => run().catch(() => {}), delay); timer.unref?.(); }
  };
  const run = () => {
    if (task) return task;
    if (!active || stopped || switching) return Promise.resolve(info());
    const account = active;
    task = Promise.resolve().then(async () => {
      phase = "syncing"; message = ""; notify();
      try {
        if (!account.cookie) throw Object.assign(new Error("请重新登录；离线日程仍保存在本机"), { status: 401 });
        const request = requestFor(account);
        const { user } = await request("/api/auth/me");
        if (user.id !== account.user.id) throw Object.assign(new Error("会话账号不匹配，请重新登录"), { status: 401 });
        const result = await syncReplica(account.db, request, { cancelled: () => stopped || active !== account || switching });
        if (active !== account || switching) return info();
        conflicts = result.conflicts; phase = "synced"; retry = 1000;
      } catch (error) {
        if (active !== account || switching || stopped) return info();
        phase = error.status === 401 ? "auth" : error.status === 409 ? "attention" : "offline";
        message = error.status ? error.message : "暂时无法连接服务器，离线修改已保存，恢复连接后自动重试";
        retry = Math.min(retry * 2, 60000);
      } finally {
        task = null; notify();
        if (active === account && !switching && !stopped) schedule(phase === "synced" ? 15000 : retry);
      }
      return info();
    });
    return task;
  };
  const settle = async () => { clearTimeout(timer); await task; clearTimeout(timer); };
  const openProfile = (origin, user) => openCalendarDatabase(path.join(profileDirectory(origin, user), "calendar.sqlite"), { replica: true });
  return {
    database: () => active?.db ?? localDatabase,
    info,
    async restore() {
      if (!fs.existsSync(sessionFile)) return;
      try {
        const record = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        const origin = validateServerOrigin(record.origin);
        if (!record.user || typeof record.user.id !== "string" || typeof record.user.username !== "string") throw new Error("登录记录无效");
        let cookie = "";
        try { if (record.encryptedCookie && safeStorage?.isEncryptionAvailable()) cookie = safeStorage.decryptString(Buffer.from(record.encryptedCookie, "base64")); } catch {}
        active = { origin, user: record.user, cookie, db: openProfile(origin, record.user) };
        phase = "offline"; schedule(100);
      } catch (error) { phase = "local"; message = error.message; }
    },
    async login({ origin: raw, username, password, mergeLocal = false, createAccount = false }) {
      if (switching) throw new Error("正在切换账号，请稍候");
      if (createAccount && active) throw new Error("请先退出当前账号后再注册");
      if (createAccount && (usernameError(username) || passwordError(password))) throw new Error(usernameError(username) || passwordError(password));
      switching = true;
      let candidate;
      try {
        const origin = validateServerOrigin(raw);
        candidate = { origin, cookie: "" };
        const { user } = await requestFor(candidate)(createAccount ? "/api/auth/register" : "/api/auth/login", { username, password });
        candidate.user = user;
        // A reauthentication must never switch an open draft into another user's profile.
        if (active && (active.origin !== origin || active.user.id !== user.id)) throw new Error("请先退出当前账号，再登录其他账号");
        abortRequests(); await settle();
        candidate.db = active?.db ?? openProfile(origin, user);
        if (mergeLocal && !candidate.db.sync.initialized()) {
          // Read the cloud before merging so equal records are skipped and colliding IDs get a new ID.
          await syncReplica(candidate.db, requestFor(candidate));
          const backupDir = path.join(dataPath, "backups", "before-first-sync");
          fs.mkdirSync(backupDir, { recursive: true });
          fs.writeFileSync(path.join(backupDir, `${Date.now()}-${randomUUID()}.json`), localDatabase.export(), "utf8");
          candidate.db.import(localDatabase.export());
        }
        candidate.db.sync.markInitialized();
        const previous = active; active = candidate;
        try { persist(); } catch (error) { active = previous; if (candidate.db !== previous?.db) candidate.db.close(); throw error; }
        conflicts = []; phase = "offline"; message = "";
      } catch (error) {
        if (candidate?.db && candidate.db !== active?.db) { try { candidate.db.close(); } catch {} }
        if (candidate?.cookie && candidate.cookie !== active?.cookie) requestFor(candidate)("/api/auth/logout", {}).catch(() => {});
        throw error;
      } finally { switching = false; schedule(100); notify(); }
      return info();
    },
    register(input) { return this.login({ ...input, createAccount: true }); },
    authOptions({ origin }) { return requestFor({ origin: validateServerOrigin(origin), cookie: "" })("/api/auth/options"); },
    async logout() {
      if (switching) throw new Error("正在切换账号，请稍候");
      switching = true;
      try {
        abortRequests(); await settle();
        const old = active;
        // Clear durable login first, so a failed disk write cannot unexpectedly return to the account on restart.
        fs.rmSync(sessionFile, { force: true });
        active = null; phase = "local"; message = ""; conflicts = [];
        if (old) { old.db.close(); requestFor(old)("/api/auth/logout", {}).catch(() => {}); }
      } finally { switching = false; notify(); }
      return info();
    },
    changed() { notify(); schedule(); },
    run,
    async resolve(input) {
      if (!active || switching) throw new Error("请先登录");
      switching = true;
      let result;
      try {
        await settle();
        const account = active;
        result = await requestFor(account)("/api/sync/resolve", { ...input, epoch: account.db.sync.replicaState().epoch });
      } finally { switching = false; schedule(); }
      await run(); return result;
    },
    async close() { stopped = true; abortRequests(); await settle(); active?.db.close(); active = null; },
  };
}
