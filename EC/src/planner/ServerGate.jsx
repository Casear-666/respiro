import {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { repository } from "./repository";
import { PASSWORD_HINT, PASSWORD_PATTERN, USERNAME_PATTERN, registrationError } from "../../shared/auth.js";
import "./server-gate.css";

export const ServerSessionContext = createContext(null);
export const useServerSession = () => useContext(ServerSessionContext);

function LoginForm({ fixedUser, onSubmit, busy, error, registrationEnabled = false, onModeChange }) {
  const [password, setPassword] = useState("");
  const [name, setName] = useState(fixedUser ?? "");
  const [register, setRegister] = useState(false), [confirmation, setConfirmation] = useState(""), [validation, setValidation] = useState("");
  return (
    <form
      className="server-gate-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const invalid = register ? registrationError(name, password, confirmation) : "";
        setValidation(invalid);
        if (!invalid) onSubmit(fixedUser ?? name, password, register);
      }}
    >
      <h1>{register ? "创建你的日历账号" : "登录你的日历"}</h1>
      <p className="server-gate-hint">{register ? "注册后自动登录，拥有独立的日历空间" : "使用你的账号登录日历"}</p>
      <fieldset disabled={busy} className="auth-fields">
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
            maxLength={register ? 64 : undefined}
            pattern={register ? USERNAME_PATTERN : undefined}
            title={register ? "3–64 位中文、英文字母、数字或 _ . @ -" : undefined}
            autoFocus={!fixedUser}
          />
        )}
      </label>
      <label className="server-gate-field">
        <span>密码</span>
        <input
          name="password"
          type="password"
          autoComplete={register ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus={!!fixedUser}
          minLength={register ? 8 : undefined}
          maxLength={128}
          pattern={register ? PASSWORD_PATTERN : undefined}
          title={register ? PASSWORD_HINT : undefined}
        />
      </label>
      {register && <>
        <p className="server-gate-hint">用户名 3–64 位中文、英文字母、数字或 _ . @ -；密码 {PASSWORD_HINT}</p>
        <label className="server-gate-field"><span>确认密码</span><input name="confirmation" type="password" autoComplete="new-password"
          value={confirmation} onChange={e => { setConfirmation(e.target.value); setValidation(""); }} required maxLength={128} /></label>
      </>}
      </fieldset>
      {(validation || error) && (
        <p className="server-gate-error" role="alert">
          {validation || error}
        </p>
      )}
      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? register ? "正在注册…" : "正在登录…" : register ? "注册并登录" : "登录"}
      </button>
      {!fixedUser && registrationEnabled && <button type="button" className="auth-mode-button" disabled={busy} onClick={() => {
        setRegister(!register); setPassword(""); setConfirmation(""); setValidation(""); onModeChange?.();
      }}>{register ? "已有账号？返回登录" : "没有账号？注册账号"}</button>}
    </form>
  );
}

export default function ServerGate({ children }) {
  const [phase, setPhase] = useState("loading");
  const [user, setUser] = useState(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(false);

  const probe = async () => {
    setPhase("loading");
    setError("");
    repository.authOptions?.().then(options => setRegistrationEnabled(options.registrationEnabled === true)).catch(() => setRegistrationEnabled(false));
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

  const submit = async (username, password, register = false) => {
    setBusy(true);
    setError("");
    try {
      const { user: current } = await (register ? repository.register(username, password) : repository.login(username, password));
      setUser(current);
      setLocked(false);
      setPhase("ready");
    } catch (e) {
      setError(e?.message || (register ? "注册结果尚未确认，可尝试使用刚才的账号登录" : "登录失败，请稍后重试"));
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
        <LoginForm onSubmit={submit} busy={busy} error={error} registrationEnabled={registrationEnabled} onModeChange={() => setError("")} />
      )}
    </div>
  );
}
