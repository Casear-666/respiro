import { uid } from "../../shared/domain.js";

const REQUEST_TIMEOUT = 20000;

export function createServerRepository({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  onUnauthorized = () => {},
  timeoutMs = REQUEST_TIMEOUT,
} = {}) {
  let epoch = null, versions = new Map(), inflight = null, resolution = null;
  const request = async (
    path,
    {
      method = "GET",
      body,
      notify401 = true,
      json = true,
      timeout = timeoutMs,
      signal,
    } = {},
  ) => {
    if (signal?.aborted) {
      throw Object.assign(new Error("已取消请求"), {
        name: "AbortError",
        canceled: true,
      });
    }
    const controller = new AbortController();
    let userAborted = false;
    const onExternalAbort = () => {
      userAborted = true;
      controller.abort();
    };
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(path, {
        method,
        credentials: "same-origin",
        signal: controller.signal,
        headers:
          body !== undefined
            ? {
                "Content-Type": "application/json",
                "X-Calendar-Request": "1",
              }
            : undefined,
        body,
      });
      if (response.status === 401 && notify401) onUnauthorized();
      if (!response.ok) {
        let message = "服务器请求失败";
        try {
          const data = await response.json();
          if (data && typeof data.error === "string") message = data.error;
        } catch {
          /* keep the generic message */
        }
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      if (!json) return await response.blob();
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("服务器返回了无法识别的数据");
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        if (userAborted) {
          throw Object.assign(new Error("已取消请求"), {
            name: "AbortError",
            canceled: true,
          });
        }
        throw new Error("连接服务器超时，请检查网络后重试");
      }
      if (error instanceof TypeError)
        throw new Error("无法连接服务器，请检查网络后重试");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  };
  const post = (path, body) =>
    request(path, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const readSnapshot = async () => {
    const snapshot = await request("/api/sync/snapshot");
    return { events: snapshot.changes.filter(c => c.event !== null).map(c => c.event), accept() {
      epoch = snapshot.epoch; versions = new Map(snapshot.changes.map(c => [c.id, c.revision]));
    } };
  };
  return {
    readSnapshot,
    async list() {
      const snapshot = await readSnapshot(); snapshot.accept(); return snapshot.events;
    },
    async apply(changes) {
      if (!epoch) throw new Error("请先重新读取日历");
      const send = async () => {
        const result = await post("/api/sync/push", inflight);
        for (const r of result.results) if (r.status === "accepted") versions.set(r.id, r.revision);
        inflight = null;
        return result;
      };
      // The previous response may have been lost. Recover its receipt before creating new operation IDs.
      if (inflight) await send();
      const operations = [...(changes?.upserts ?? []).map(event => ({ id: event.id, event })),
        ...(changes?.deletes ?? []).map(id => ({ id, event: null }))]
        .map(op => ({ ...op, opId: uid(), baseRevision: versions.get(op.id) ?? 0 }));
      for (let i = 0; i < operations.length; i += 100) {
        inflight = { epoch, operations: operations.slice(i, i + 100) };
        await send();
      }
    },
    syncInfo: () => request("/api/sync/conflicts").then(result => ({ ...result, phase: "synced" })),
    async resolveConflict(input) {
      const key = JSON.stringify(input);
      if (!resolution || resolution.key !== key) resolution = { key, body: { ...input, epoch } };
      const result = await post("/api/sync/resolve", resolution.body);
      resolution = null;
      return result;
    },
    getSettings: () => request("/api/settings"),
    setSettings: (settings) =>
      request("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(settings),
      }),
    info: () => request("/api/info"),
    importText: (raw) => post("/api/import", raw),
    async exportBackup() {
      const blob = await request("/api/export", { json: false });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `energy-calendar-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { ok: true };
    },
    login: (username, password) =>
      request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
        notify401: false,
      }),
    register: (username, password) => request("/api/auth/register", {
      method: "POST", body: JSON.stringify({ username, password }), notify401: false,
    }),
    authOptions: () => request("/api/auth/options", { notify401: false }),
    session: () => request("/api/auth/me", { notify401: false }),
    logout: () =>
      request("/api/auth/logout", {
        method: "POST",
        body: "{}",
        notify401: false,
      }),
    aiStatus: () => request("/api/ai/status", { notify401: false }),
    aiGetConfig: () => request("/api/ai/config", { notify401: false }),
    aiSetConfig: (payload) =>
      request("/api/ai/config", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    aiWeights: (ids) => {
      const query =
        Array.isArray(ids) && ids.length
          ? `?ids=${encodeURIComponent(ids.join(","))}`
          : "";
      return request(`/api/ai/weights${query}`);
    },
    aiQuickCapture: (payload, { signal } = {}) =>
      request("/api/ai/quick-capture", {
        method: "POST",
        body: JSON.stringify(payload),
        timeout: 65000,
        signal,
      }),
    aiCognitiveWeight: (payload) =>
      request("/api/ai/cognitive-weight", {
        method: "POST",
        body: JSON.stringify(payload),
        timeout: 35000,
      }),
  };
}
