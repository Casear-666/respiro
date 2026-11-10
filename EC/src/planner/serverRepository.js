const REQUEST_TIMEOUT = 20000;

export function createServerRepository({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  onUnauthorized = () => {},
  timeoutMs = REQUEST_TIMEOUT,
} = {}) {
  const request = async (
    path,
    { method = "GET", body, notify401 = true, json = true } = {},
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      if (error?.name === "AbortError")
        throw new Error("连接服务器超时，请检查网络后重试");
      if (error instanceof TypeError)
        throw new Error("无法连接服务器，请检查网络后重试");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const post = (path, body) =>
    request(path, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return {
    list: () => request("/api/events"),
    apply: (changes) =>
      post("/api/events/apply", {
        upserts: changes?.upserts ?? [],
        deletes: changes?.deletes ?? [],
      }),
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
    session: () => request("/api/auth/me", { notify401: false }),
    logout: () =>
      request("/api/auth/logout", {
        method: "POST",
        body: "{}",
        notify401: false,
      }),
  };
}
