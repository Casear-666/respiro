import {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { repository } from "./repository";
import "./server-gate.css";

export const ServerSessionContext = createContext(null);
export const useServerSession = () => useContext(ServerSessionContext);

function LoginForm({ fixedUser, onSubmit, busy, error }) {
  const [password, setPassword] = useState("");
  const [name, setName] = useState(fixedUser ?? "");
  return (
    <form
      className="server-gate-card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(fixedUser ?? name, password);
      }}
    >
      <h1>登录你的日历</h1>
      <p className="server-gate-hint">使用管理员创建的账号登录</p>
      <label className="server-gate-field">
        <span>用户名</span>
        {fixedUser ? (
          <input
            name="username"
            autoComplete="username"
            value={fixedUser}
            readOnly
            aria-readonly="true"
          />
        ) : (
          <input
            name="username"
            autoComplete="username"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus={!fixedUser}
          />
        )}
      </label>
      <label className="server-gate-field">
        <span>密码</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus={!!fixedUser}
        />
      </label>
      {error && (
        <p className="server-gate-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? "正在登录…" : "登录"}
      </button>
    </form>
  );
}

export default function ServerGate({ children }) {
  const [phase, setPhase] = useState("loading");
  const [user, setUser] = useState(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const probe = async () => {
    setPhase("loading");
    setError("");
    try {
      const { user: current } = await repository.session();
      setUser(current);
      setLocked(false);
      setPhase("ready");
    } catch (e) {
      setPhase(e?.status === 401 ? "login" : "offline");
    }
  };
  useEffect(() => {
    probe();
  }, []);
  useEffect(() => {
    const onUnauthorized = () => setLocked(true);
    window.addEventListener("calendar:unauthorized", onUnauthorized);
    return () =>
      window.removeEventListener("calendar:unauthorized", onUnauthorized);
  }, []);

  const submit = async (username, password) => {
    setBusy(true);
    setError("");
    try {
      const { user: current } = await repository.login(username, password);
      setUser(current);
      setLocked(false);
      setPhase("ready");
    } catch (e) {
      setError(e?.message || "登录失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    await repository.logout();
    setUser(null);
    setLocked(false);
    setPhase("login");
  };

  if (phase === "ready") {
    return (
      <ServerSessionContext.Provider value={{ user, logout }}>
        <div
          className="server-gate-app"
          inert={locked ? true : undefined}
          aria-hidden={locked || undefined}
        >
          {children}
        </div>
        {locked && (
          <div
            className="server-gate-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="登录已过期"
          >
            <div className="server-gate-panel">
              <LoginForm
                fixedUser={user?.username}
                onSubmit={submit}
                busy={busy}
                error={error}
              />
            </div>
          </div>
        )}
      </ServerSessionContext.Provider>
    );
  }
  return (
    <div className="server-gate-screen">
      {phase === "loading" && (
        <p className="server-gate-hint" role="status">
          正在连接服务器…
        </p>
      )}
      {phase === "offline" && (
        <div className="server-gate-card">
          <h1>登录你的日历</h1>
          <p className="server-gate-error" role="alert">
            暂时无法连接服务器
          </p>
          <button type="button" className="primary-button" onClick={probe}>
            重试
          </button>
        </div>
      )}
      {phase === "login" && (
        <LoginForm onSubmit={submit} busy={busy} error={error} />
      )}
    </div>
  );
}
