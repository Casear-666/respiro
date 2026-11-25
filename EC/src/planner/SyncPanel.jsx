import { useEffect, useRef, useState } from "react";
import { isLocalApp, isMobile, repository } from "./repository";
import { CATEGORIES, uid } from "../../shared/domain.js";
import { PASSWORD_HINT, PASSWORD_PATTERN, USERNAME_PATTERN, registrationError } from "../../shared/auth.js";
import "./sync.css";

export const syncLabel = (state) => state?.phase === "synced" && state.pending + state.inflight > 0 ? `${state.pending + state.inflight} 项待同步` : ({ local: "本地空间", syncing: "正在同步…", synced: "已与云端同步", offline: "离线 · 修改已保存在本机", auth: "登录已过期 · 可继续离线编辑", attention: "需要处理同步状态" }[state?.phase] || "正在读取同步状态…");
export function StorageLabel({ server }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    repository.syncInfo?.().then(setState).catch(() => {});
    return repository.onChanged?.(setState);
  }, []);
  return <span><strong>{server ? "我的云端日历" : state?.user ? `${state.user.username} 的日历` : "我的本地空间"}</strong>
    <small>{server ? "已连接服务器" : state?.user ? syncLabel(state) : isLocalApp ? "离线可用 · 只属于你" : "网页预览 · 本机保存"}</small></span>;
}
export function SyncStatus({ alertsOnly = false, onOpen }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    const read = () => repository.syncInfo?.().then(setState).catch(() => {});
    read(); const off = repository.onChanged?.(setState); const timer = setInterval(read, 15000);
    return () => { off?.(); clearInterval(timer); };
  }, []);
  if (alertsOnly) {
    const n = state?.conflicts?.length || 0;
    if (!(state && (n || state.phase === "auth" || state.phase === "attention"))) return null;
    return <button type="button" className="mobile-status-sync" onClick={onOpen}>{n ? `${n} 项同步冲突 · 去处理` : syncLabel(state)}</button>;
  }
  return state && state.phase !== "local" ? <span> · {syncLabel(state)}{state.conflicts?.length ? ` · ${state.conflicts.length} 项冲突（设置中处理）` : ""}</span> : null;
}
function Version({ title, event }) {
  return <div className="sync-version"><strong>{title}</strong>{event ? <dl>
    <dt>名称</dt><dd>{event.title}</dd><dt>时间</dt><dd>{event.start} → {event.end}{event.allDay ? "（全天，结束日期不含当天）" : ""}</dd>
    <dt>分类</dt><dd>{CATEGORIES.find(c => c.id === event.tag)?.label || "其他"}</dd>
    <dt>状态</dt><dd>{event.completed ? "已完成" : "未完成"}</dd><dt>备注</dt><dd>{event.description || "无"}</dd>
  </dl> : <p>此版本已删除日程</p>}</div>;
}
export default function SyncPanel({ model }) {
  const [state, setState] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState(isMobile ? "" : "http://127.0.0.1:3001"), [username, setUsername] = useState(""), [password, setPassword] = useState(""), [mergeLocal, setMerge] = useState(false);
  const [register, setRegister] = useState(false), [confirmation, setConfirmation] = useState("");
  const resolution = useRef(null);
  const read = () => repository.syncInfo().then(setState).catch(e => setError(e.message));
  useEffect(() => {
    read(); const off = repository.onChanged?.(setState); const timer = setInterval(read, 5000);
    return () => { off?.(); clearInterval(timer); };
  }, []);
  const act = async (operation, reload = false) => {
    setBusy(true); setError("");
    try {
      if (reload) await model.switchSpace(operation);
      else { await model.flush(); await operation(); }
      await read();
    } catch (e) { setError(e.message); await read(); }
    finally { setBusy(false); }
  };
  return <div className="settings-section sync-panel"><h3>账号与同步</h3>
    <p role="status">{syncLabel(state)}{state?.user ? ` · ${state.user.username}` : ""}</p>
    {state?.origin && <p className="data-help">{state.origin}</p>}
    {state?.message && <p className="data-help">{state.message}</p>}
    {isLocalApp && state?.user && <p className="data-help">待同步 {state.pending + state.inflight} 项 · 账号日程保存在独立本地副本中</p>}
    {isLocalApp && (!state?.user || state.phase === "auth") && <form className="sync-login" onSubmit={e => {
      e.preventDefault();
      if (busy) return;
      const invalid = register ? registrationError(username, password, confirmation) : "";
      if (invalid) { setError(invalid); return; }
      act(async () => {
        await (register ? repository.register : repository.login)({ origin: state?.origin || origin, username: state?.user?.username || username, password, mergeLocal });
        setPassword(""); setConfirmation(""); setRegister(false);
      }, true);
    }}>
      <fieldset className="auth-fields" disabled={busy}>
      {!state?.user && <><label>服务器地址<input name="serverOrigin" aria-label="服务器地址" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder={isMobile ? "https://…" : undefined} value={origin} onChange={e => setOrigin(e.target.value)} required /></label>
      <label>用户名<input name="username" autoComplete="username" autoCapitalize="none" value={username} onChange={e => setUsername(e.target.value)} required
        maxLength={register ? 64 : undefined} pattern={register ? USERNAME_PATTERN : undefined} title={register ? "3–64 位中文、英文字母、数字或 _ . @ -" : undefined} /></label></>}
      <label>密码<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} required
        minLength={register ? 8 : undefined} maxLength={128} pattern={register ? PASSWORD_PATTERN : undefined} title={register ? PASSWORD_HINT : undefined} /></label>
      {register && <><p className="data-help">密码 {PASSWORD_HINT}</p><label>确认密码<input name="confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} required maxLength={128} /></label></>}
      {!state?.user && <label className="sync-merge"><input type="checkbox" checked={mergeLocal} onChange={e => setMerge(e.target.checked)} />首次连接时合并本地日程（先备份，保留原本地空间）；不勾选则仅使用云端日历</label>}
      </fieldset>
      <button className="primary-button" disabled={busy || model.demo || model.status !== "saved"}>{busy ? register ? "正在注册…" : "正在登录…" : register ? "注册并同步" : "登录并同步"}</button>
      {!state?.user && <button type="button" className="secondary-button" disabled={busy || model.demo} onClick={() => {
        if (register) { setRegister(false); setConfirmation(""); setPassword(""); setError(""); return; }
        act(async () => {
          const options = await repository.authOptions({ origin });
          if (!options.registrationEnabled) throw new Error("当前服务器暂未开放注册");
          setRegister(true); setPassword("");
        });
      }}>{register ? "已有账号？返回登录" : "没有账号？注册账号"}</button>}
    </form>}
    <div className="data-actions">
      {isLocalApp && state?.user && <><button className="secondary-button" disabled={busy || model.demo} onClick={() => act(() => repository.syncNow())}>立即同步</button>
      <button className="secondary-button" disabled={busy || model.demo} onClick={() => act(() => repository.logout(), true)}>退出账号，返回本地空间</button></>}
    </div>
    {!!state?.conflicts?.length && <p>有 {state.conflicts.length} 项冲突。双方版本已保留，请逐项选择。</p>}
    {state?.conflicts?.map(conflict => <article className="sync-conflict" key={conflict.id}>
      <div className="sync-versions"><Version title="提交的版本" event={conflict.localEvent} /><Version title="云端当前版本" event={conflict.remoteEvent} /></div>
      {JSON.stringify(conflict.originalRemoteEvent) !== JSON.stringify(conflict.remoteEvent) && <details><summary>云端在冲突后又有修改：查看冲突发生时的版本</summary><Version title="云端原版本" event={conflict.originalRemoteEvent} /></details>}
      <div className="data-actions">{[["local", "使用提交的版本"], ["remote", "使用云端版本"], ...(conflict.localEvent && conflict.remoteEvent ? [["both", "保留两份"]] : [])].map(([choice, label]) =>
        <button className="secondary-button" key={choice} disabled={busy || model.demo} onClick={() => act(async () => {
          const key = `${conflict.id}:${choice}:${conflict.remoteRevision}`;
          if (resolution.current?.key !== key) resolution.current = { key, opId: uid() };
          await repository.resolveConflict({ opId: resolution.current.opId, conflictId: conflict.id, choice, expectedRevision: conflict.remoteRevision });
          resolution.current = null;
        }, true)}>{label}</button>)}</div>
    </article>)}
    {error && <p className="data-help sync-error" role="alert">{error}</p>}
  </div>;
}
