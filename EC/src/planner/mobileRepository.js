import { passwordError, usernameError } from "../../shared/auth.js";
import { syncReplica } from "../../desktop/sync-engine.js";

const emptyStats = { epoch: null, cursor: 0, pending: 0, inflight: 0 };
const disabledAi = { enabled: false, capabilities: {}, models: {} };
const permissionError = () => Object.assign(new Error("请先登录账号"), { status: 401 });

export function validateMobileOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error("请输入有效的 HTTPS 服务器地址");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !localHttp)) {
    throw new Error("服务器地址需要 HTTPS 或本机 HTTP，且不能包含路径或账号信息");
  }
  return url.origin;
}

function checkedUser(user) {
  if (typeof user?.id !== "string" || !user.id || typeof user.username !== "string" || !user.username) {
    throw new Error("服务器返回的账号信息无效");
  }
  return { id: user.id, username: user.username };
}

// The bridge keeps session credentials entirely on the native side.
export function createMobileRepository({
  native, openLocal, openProfile, version, isForeground = () => true,
}) {
  const listeners = new Set();
  let local, active, initialization, syncTask, timer;
  let phase = "local", message = "", conflicts = [], stats = emptyStats, retry = 1000, switching = false;

  const state = () => ({
    phase, message, conflicts, origin: active?.origin, user: active?.user, ...stats,
  });
  const publish = () => {
    const current = state();
    for (const listener of listeners) listener(current);
  };
  const request = (origin, session = "none") => (route, body) => native.request({
    origin, route, session, ...(body === undefined ? {} : { body }),
  });
  const stopTimer = () => clearTimeout(timer);
  const schedule = (delay = 500) => {
    stopTimer();
    if (!active || switching || !isForeground()) return;
    timer = setTimeout(() => {
      if (isForeground()) run().catch(() => {});
    }, delay);
    timer.unref?.();
  };
  const ready = () => {
    if (!initialization) {
      initialization = (async () => {
        local ??= await openLocal();
        let session;
        try {
          ({ session } = await native.getSession());
        } catch {
          message = "无法读取登录状态，本地日程仍可使用";
        }
        if (!session) return;
        const origin = validateMobileOrigin(session.origin);
        const user = checkedUser(session.user);
        const db = await openProfile(origin, user.id);
        try {
          stats = await db.sync.replicaState();
          conflicts = await db.sync.conflicts();
        } catch (error) {
          await db.close().catch(() => {});
          throw error;
        }
        active = { origin, user, db };
        phase = "offline";
        schedule(100);
      })().catch((error) => {
        initialization = undefined;
        throw error;
      });
    }
    return initialization;
  };
  const updateStats = async (profile) => {
    if (!profile) return;
    const current = await profile.db.sync.replicaState();
    if (active === profile) stats = current;
  };
  const changed = async (profile) => {
    await updateStats(profile).catch(() => {});
    if (active === profile) {
      publish();
      schedule();
    }
  };
  const waitForSync = async () => {
    stopTimer();
    await syncTask;
    stopTimer();
  };
  const space = async ({ write = false } = {}) => {
    await ready();
    if (write && switching) throw new Error("正在切换账号，请稍候");
    return { profile: active, db: active?.db ?? local };
  };
  const run = async () => {
    await ready();
    if (syncTask) return syncTask;
    if (!active || switching) return state();
    stopTimer();
    const profile = active;
    const canceled = () => active !== profile || switching;
    syncTask = Promise.resolve().then(async () => {
      if (canceled()) return state();
      phase = "syncing";
      message = "";
      try {
        publish();
        const send = request(profile.origin, "active");
        const { user } = await send("/api/auth/me");
        if (user?.id !== profile.user.id) throw permissionError();
        const result = await syncReplica(profile.db, send, { cancelled: canceled });
        if (canceled()) return state();
        await profile.db.sync.rememberConflicts(result.conflicts);
        await updateStats(profile);
        if (canceled()) return state();
        conflicts = result.conflicts;
        phase = "synced";
        retry = 1000;
      } catch (error) {
        if (canceled()) return state();
        const status = Number(error?.status ?? error?.code);
        phase = status === 401 ? "auth" : status === 409 ? "attention" : "offline";
        message = status === 401
          ? "请重新登录，离线修改仍保存在本机"
          : status >= 400 && error.message
            ? error.message
            : "暂时无法连接服务器，离线修改已保存";
        retry = Math.min(retry * 2, 60000);
        await updateStats(profile).catch(() => {});
      }
      return state();
    }).finally(() => {
      syncTask = undefined;
      if (!canceled()) {
        publish();
        if (phase === "synced") schedule(stats.pending || stats.inflight ? 500 : 15000);
        if (phase === "offline") schedule(retry);
      }
    });
    return syncTask;
  };
  const login = async ({ origin: raw, username, password, mergeLocal = false }, createAccount = false) => {
    await ready();
    if (switching) throw new Error("正在切换账号，请稍候");
    if (createAccount && active) throw new Error("请先退出当前账号后再注册");
    const invalid = createAccount && (usernameError(username) || passwordError(password));
    if (invalid) throw new Error(invalid);
    const origin = validateMobileOrigin(raw);
    if (active && active.origin !== origin) throw new Error("请先退出当前账号，再连接其他服务器");
    switching = true;
    let db, committed = false;
    try {
      await waitForSync();
      const send = request(origin, "candidate");
      const { user: candidate } = await send(createAccount ? "/api/auth/register" : "/api/auth/login", { username, password });
      const user = checkedUser(candidate);
      if (active && active.user.id !== user.id) throw new Error("请先退出当前账号，再登录其他账号");
      db = active?.db ?? await openProfile(origin, user.id);
      if (!await db.sync.initialized()) {
        if (mergeLocal) {
          const result = await syncReplica(db, send);
          await db.sync.rememberConflicts(result.conflicts);
        }
        await db.sync.initializeProfile(mergeLocal ? await local.list() : undefined);
      }
      const nextStats = await db.sync.replicaState();
      const nextConflicts = await db.sync.conflicts();
      await native.commitSession({ session: { origin, user } });
      committed = true;
      active = { origin, user, db };
      stats = nextStats;
      conflicts = nextConflicts;
      phase = "offline";
      message = "";
      retry = 1000;
    } finally {
      if (!committed) {
        await native.clearCandidate().catch(() => {});
        if (db && db !== active?.db) await db.close().catch(() => {});
      }
      switching = false;
      schedule(100);
      publish();
    }
    return state();
  };
  const logout = async () => {
    await ready();
    if (switching) throw new Error("正在切换账号，请稍候");
    switching = true;
    try {
      await waitForSync();
      await native.setSession({ session: null });
      const previous = active;
      active = undefined;
      phase = "local";
      message = "";
      conflicts = [];
      stats = emptyStats;
      await previous?.db.close().catch(() => {});
    } finally {
      switching = false;
      if (active) schedule();
      publish();
    }
    return state();
  };
  const resolveConflict = async (input) => {
    await ready();
    if (!active || switching) throw new Error("请先登录账号");
    switching = true;
    let result;
    try {
      await waitForSync();
      const { epoch } = await active.db.sync.replicaState();
      result = await request(active.origin, "active")("/api/sync/resolve", { ...input, epoch });
    } finally {
      switching = false;
      schedule();
    }
    await run();
    return result;
  };
  const importText = async (raw, selectedSpace) => {
    const { profile, db } = await space({ write: true });
    if (selectedSpace && db !== selectedSpace.db) throw new Error("日历空间已切换，请重新选择备份");
    const result = await db.importText(raw);
    await changed(profile);
    return result;
  };
  const callAi = async (route, body, signal) => {
    await ready();
    if (!active || switching) throw permissionError();
    const profile = active;
    const cancellation = () => Object.assign(new Error("已取消请求"), { name: "AbortError", canceled: true });
    if (signal?.aborted) throw cancellation();
    const response = request(profile.origin, "active")(route, body);
    let onAbort;
    try {
      const data = signal ? await Promise.race([
        response,
        new Promise((_, reject) => {
          onAbort = () => reject(cancellation());
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]) : await response;
      if (active !== profile || switching) throw cancellation();
      return data;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };

  return {
    async list() { return (await space()).db.list(); },
    async getSettings() { return (await space()).db.getSettings(); },
    async setSettings(settings) { return (await space({ write: true })).db.setSettings(settings); },
    async getWeightOverrides() { return (await space()).db.getWeightOverrides(); },
    async setWeightOverride(id, value) { return (await space({ write: true })).db.setWeightOverride(id, value); },
    async apply(changes) {
      const { profile, db } = await space({ write: true });
      const result = await db.apply(changes);
      await changed(profile);
      return result;
    },
    info: async () => {
      await ready();
      return { version, desktop: false, mobile: true, user: active?.user, origin: active?.origin };
    },
    syncInfo: async () => { await ready(); return state(); },
    syncNow: run,
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    authOptions: ({ origin }) => request(validateMobileOrigin(origin))("/api/auth/options"),
    login: (input) => login(input),
    register: (input) => login(input, true),
    logout,
    resolveConflict,
    importText,
    async importBackup() {
      const selectedSpace = await space({ write: true });
      const { text, canceled } = await native.pickBackup();
      return canceled ? { canceled: true } : importText(text, selectedSpace);
    },
    async exportBackup() {
      const { profile, db } = await space();
      const text = await db.export();
      if (active !== profile || switching) throw new Error("日历空间已切换，请重新导出备份");
      return native.shareBackup({ name: `精力日历-${new Date().toISOString().slice(0, 10)}.json`, text });
    },
    async aiStatus() {
      await ready();
      return active ? callAi("/api/ai/status") : disabledAi;
    },
    aiGetConfig: () => callAi("/api/ai/config"),
    aiSetConfig: (body) => callAi("/api/ai/config", body),
    aiWeights: (ids) => callAi(`/api/ai/weights${ids?.length ? `?ids=${encodeURIComponent(ids.join(","))}` : ""}`),
    aiQuickCapture: (body, { signal } = {}) => callAi("/api/ai/quick-capture", body, signal),
    aiCognitiveWeight: (body) => callAi("/api/ai/cognitive-weight", body),
  };
}
