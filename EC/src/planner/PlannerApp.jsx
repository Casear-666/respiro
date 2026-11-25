import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Toaster, toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  ClipboardCopy,
  ClipboardPaste,
  Clock3,
  Copy,
  FolderOpen,
  Cloud,
  HardDrive,
  Keyboard,
  Laptop,
  Moon,
  MoreHorizontal,
  PanelRight,
  Plus,
  Redo2,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Sun,
  SunMoon,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  addDays,
  categoryOf,
  CATEGORIES,
  dateKey,
  dayLoad,
  DEFAULT_SETTINGS,
  eventCognitiveInfo,
  eventOnDay,
  eventsByDay,
  formatTime,
  localDate,
  overlapLevels,
  rangeLoads,
} from "../../shared/domain";
import { energyForCount } from "../../shared/energy";
import { DayPreview, useDwell, useKeyboardModality } from "./DayPreview";
import { usePlanner } from "./usePlanner";
import SyncPanel, { SyncStatus, StorageLabel } from "./SyncPanel";
import { isDesktop, isLocalApp, isMobile, isServer, repository } from "./repository";
import { useServerSession } from "./ServerGate";
const CalendarCanvas = lazy(() => import("./CalendarCanvas"));
import EventEditor from "./EventEditor";
import Dialog from "./Dialog";
import SearchDialog from "./SearchPalette";
import "./planner.css";

const weekNames = ["日", "一", "二", "三", "四", "五", "六"];
const viewNames = [
  { id: "energyDial", label: "日", scope: "当日" },
  { id: "timeGridWeek", label: "周", scope: "本周" },
  { id: "dayGridMonth", label: "月", scope: "本月" },
];
const UI_KEY = "energy-calendar-ui";
const EASE_OUT = [0.16, 1, 0.3, 1];
const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || "");
const MOD = isMac ? "⌘" : "Ctrl";

const readUi = () => {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || "{}") || {};
  } catch {
    return {};
  }
};
const writeUi = (patch) => {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...readUi(), ...patch }));
  } catch {
    /* UI preferences are optional. */
  }
};

function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

let activeViewTransitionId = 0;
let activeViewTransitionClass = "";

function resolveThemeValue(setting) {
  if (setting === "system") {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return setting === "dark" ? "dark" : "light";
}

function syncColorSchemeMeta(setting, resolved) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (!meta) return;
  meta.setAttribute("content", setting === "system" ? "light dark" : resolved);
}

function positionPopoverFallback(triggerEl, popoverEl, align = "start") {
  if (
    !triggerEl ||
    !popoverEl ||
    (typeof CSS !== "undefined" && CSS.supports?.("position-area", "block-end"))
  ) {
    return;
  }
  const rect = triggerEl.getBoundingClientRect();
  const popRect = popoverEl.getBoundingClientRect();
  const width = popRect.width || popoverEl.offsetWidth || 240;
  const height = popRect.height || popoverEl.offsetHeight || 280;
  const edge = 12;
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - edge && rect.top - 8 - height >= edge) {
    top = rect.top - 8 - height;
  }
  top = Math.max(edge, Math.min(top, window.innerHeight - height - edge));
  const rawLeft = align === "end" ? rect.right - width : rect.left;
  const left = Math.max(edge, Math.min(rawLeft, window.innerWidth - width - edge));
  popoverEl.style.margin = "0";
  popoverEl.style.inset = "auto";
  popoverEl.style.top = `${top}px`;
  popoverEl.style.left = `${left}px`;
}

/**
 * Run a DOM update inside a typed View Transition when the platform supports it.
 * Falls back to an immediate update (older engines, reduced motion, hidden windows).
 */
function runViewTransition(type, update, { className, settle } = {}) {
  const root = document.documentElement;
  if (
    !document.startViewTransition ||
    document.visibilityState === "hidden" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return null;
  }
  const transitionId = ++activeViewTransitionId;
  for (const cls of [...root.classList]) {
    if (cls.startsWith("vt-type-")) root.classList.remove(cls);
  }
  if (activeViewTransitionClass) {
    root.classList.remove(activeViewTransitionClass);
    activeViewTransitionClass = "";
  }
  const typeClass = `vt-type-${type}`;
  root.classList.add(typeClass);
  if (className) {
    root.classList.add(className);
    activeViewTransitionClass = className;
  }
  const callback = async () => {
    const wait = settle?.();
    update();
    if (wait) await wait;
  };
  const cleanup = () => {
    if (transitionId !== activeViewTransitionId) return;
    root.classList.remove(typeClass);
    if (className) root.classList.remove(className);
    if (activeViewTransitionClass === className) activeViewTransitionClass = "";
  };
  try {
    let transition;
    try {
      transition = document.startViewTransition({
        update: callback,
        types: [type],
      });
    } catch {
      transition = document.startViewTransition(callback);
    }
    // A rapid second navigation can skip the first snapshot while its update still completes.
    transition?.ready?.catch(error => {
      if (error.name !== "AbortError") console.warn("视图过渡未能启动", error);
    });
    Promise.resolve(transition?.finished).finally(cleanup);
    return transition;
  } catch {
    cleanup();
    update();
    return null;
  }
}

function BrandMark({ size = 30 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        {Array.from({ length: 10 }, (_, i) => (
          <path key={i} d="M20 4V12" transform={`rotate(${i * 36} 20 20)`} />
        ))}
      </g>
      <circle cx="20" cy="20" r="4.4" fill="currentColor" />
    </svg>
  );
}
function IconButton({ label, children, className = "", shortcut, ref, ...props }) {
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={shortcut ? `${label}（${shortcut}）` : label}
      {...props}
    >
      {children}
    </button>
  );
}
function Keys({ value }) {
  return (
    <span className="kbd-group">
      {value.split(" ").map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}
function Segmented({ label, options, value, onChange, layoutId }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          key={String(option.value)}
          aria-checked={value === option.value}
          onClick={(e) => onChange(option.value, e)}
        >
          {value === option.value && (
            <motion.span
              className="segment-highlight"
              layoutId={layoutId}
              transition={{ type: "spring", stiffness: 520, damping: 40 }}
            />
          )}
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function MiniCalendar({
  anchor,
  selected,
  onDate,
  onEdit,
  onDelete,
  firstDay,
  events,
  aiWeights,
  energyMode,
  preview = true,
  onToday,
  resetSignal,
}) {
  const [browseMonth, setBrowseMonth] = useState(
    () => new Date(anchor.getFullYear(), anchor.getMonth(), 1),
  );
  const anchorYear = anchor.getFullYear(),
    anchorMonth = anchor.getMonth();
  useEffect(() => {
    setBrowseMonth(new Date(anchorYear, anchorMonth, 1));
  }, [anchorYear, anchorMonth, resetSignal]);

  const first = new Date(browseMonth.getFullYear(), browseMonth.getMonth(), 1);
  const offset = (first.getDay() - firstDay + 7) % 7;
  const start = addDays(first, -offset),
    today = dateKey(new Date());
  const monthKey = `${browseMonth.getFullYear()}-${browseMonth.getMonth()}`;
  const days = useMemo(
    () => Array.from({ length: 42 }, (_, i) => addDays(start, i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [monthKey, firstDay],
  );
  const loadOptions = useMemo(
    () =>
      energyMode === "cognitive"
        ? { weightsMap: aiWeights, energyMode }
        : undefined,
    [aiWeights, energyMode],
  );
  const loads = useMemo(
    () => rangeLoads(events, days[0], days.length, loadOptions),
    [days, events, loadOptions],
  );
  const counts = useMemo(
    () => new Map([...loads].map(([key, load]) => [key, load.count])),
    [loads],
  );
  const dayLists = useMemo(
    () => eventsByDay(events, days[0], days.length),
    [days, events],
  );
  const levels = useMemo(() => overlapLevels(events), [events]);
  const keyboardModality = useKeyboardModality();
  const [liftKey, setLiftKey] = useState(null);
  const dwell = useDwell({ onLift: setLiftKey });
  useEffect(() => {
    if (preview) dwell.close();
  }, [monthKey, preview]);
  const resolve = useCallback(
    (key) => ({
      date: localDate(key),
      events: dayLists.get(key) ?? [],
      load: loads.get(key) ?? dayLoad(events, key, loadOptions),
      levels,
      today: key === today,
      weightsMap: aiWeights,
      energyMode,
    }),
    [dayLists, loads, levels, today, events, loadOptions, aiWeights, energyMode],
  );
  return (
    <div className="mini-calendar">
      <div className="mini-month">
        <span>
          {browseMonth.getFullYear()} 年 {browseMonth.getMonth() + 1} 月
        </span>
        <div>
          <IconButton
            className="sm"
            label="上一月（小日历）"
            onClick={() =>
              setBrowseMonth(
                (m) => new Date(m.getFullYear(), m.getMonth() - 1, 1),
              )
            }
          >
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton
            className="sm"
            label="下一月（小日历）"
            onClick={() =>
              setBrowseMonth(
                (m) => new Date(m.getFullYear(), m.getMonth() + 1, 1),
              )
            }
          >
            <ChevronRight size={15} />
          </IconButton>
        </div>
      </div>
      <motion.div
        className="mini-grid"
        key={monthKey}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: EASE_OUT }}
      >
        {Array.from({ length: 7 }, (_, i) => (
          <span className="mini-weekday" key={`w${i}`}>
            {weekNames[(firstDay + i) % 7]}
          </span>
        ))}
        {days.map((day) => {
          const key = dateKey(day),
            dayItem = loads.get(key),
            count = counts.get(key) || 0,
            heatVal =
              energyMode === "cognitive"
                ? dayItem?.effectiveCount ?? count
                : count;
          return (
            <button
              type="button"
              key={key}
              onClick={() => {
                onDate(day);
                if (preview) dwell.close();
              }}
              onPointerEnter={
                preview
                  ? (e) => {
                      if (e.pointerType === "touch" || e.buttons) return;
                      dwell.enter(key, e.currentTarget);
                    }
                  : undefined
              }
              onPointerLeave={preview ? () => dwell.leave() : undefined}
              onFocus={
                preview
                  ? (e) => {
                      if (keyboardModality.current)
                        dwell.enter(key, e.currentTarget, "keyboard");
                    }
                  : undefined
              }
              onBlur={preview ? () => dwell.leave() : undefined}
              onKeyDown={
                preview
                  ? (e) => {
                      if (e.key === "ArrowDown" && dwell.open?.key === key) {
                        e.preventDefault();
                        dwell.cardRef.current
                          ?.querySelector(".day-preview-item")
                          ?.focus();
                      }
                    }
                  : undefined
              }
              title={count ? `${key} · ${count} 项安排` : key}
              aria-label={`跳转到 ${key}${count ? `，${count} 项安排` : ""}`}
              aria-current={key === today ? "date" : undefined}
              style={
                count ? { "--dot": energyForCount(heatVal || 1).ink } : undefined
              }
              className={`${day.getMonth() !== browseMonth.getMonth() ? "outside" : ""} ${key === dateKey(selected) ? "selected" : ""} ${key === today ? "today" : ""} ${preview && liftKey === key ? "is-dwell" : ""}`}
            >
              {day.getDate()}
              {count > 0 && <i className="mini-dot" />}
            </button>
          );
        })}
      </motion.div>
      {onToday && (
        <div className="mini-calendar-footer">
          <button
            type="button"
            className="mini-today-button"
            onClick={onToday}
          >
            <span>回到今天</span>
            <kbd>T</kbd>
          </button>
        </div>
      )}
      {preview && (
        <DayPreview
          open={dwell.open}
          cardRef={dwell.cardRef}
          onHold={dwell.hold}
          onRelease={dwell.release}
          onClose={dwell.close}
          placement="right"
          resolve={resolve}
          onEdit={(event, rect) => {
            onDate(localDate(dwell.open?.key ?? event.start));
            onEdit(event.id, rect);
            dwell.close();
          }}
          onDelete={onDelete}
          emptyHint="点击查看这一天"
        />
      )}
    </div>
  );
}

function TodayPanel({
  selected,
  events,
  allEvents,
  aiWeights,
  energyMode,
  onEnergyModeChange,
  onClose,
  onEdit,
  onDelete,
  onComplete,
  onCreate,
  onActions,
  onPaste,
  onDayView,
}) {
  const daily = useMemo(
    () =>
      events
        .filter((e) => eventOnDay(e, selected))
        .sort(
          (a, b) =>
            Number(b.allDay) - Number(a.allDay) ||
            +localDate(a.start) - +localDate(b.start),
        ),
    [events, selected],
  );
  const load = useMemo(
    () =>
      dayLoad(
        allEvents || events,
        selected,
        energyMode === "cognitive"
          ? { weightsMap: aiWeights, energyMode }
          : undefined,
      ),
    [allEvents, events, selected, aiWeights, energyMode],
  );
  const isCognitive = energyMode === "cognitive";
  const heatVal = isCognitive ? load.effectiveCount : load.count;
  const heat = energyForCount(heatVal || 1);
  const today = dateKey(selected) === dateKey(new Date());
  const filled = isCognitive
    ? Math.round(
        Math.min(Math.max(load.cognitiveUnits / 7, load.minutes / 480), 1) * 16,
      )
    : Math.round(
        Math.min(Math.max(load.count / 8, load.minutes / 480), 1) * 16,
      );
  return (
    <aside className="day-panel" aria-label="当日安排">
      <div className="panel-top">
        <span className="eyebrow">{today ? "今天" : "所选日期"}</span>
        <IconButton label="收起日程面板" shortcut="]" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="panel-date">
        <span className="panel-date-number">{selected.getDate()}</span>
        <div>
          <strong>
            {selected.getMonth() + 1} 月 · 星期{weekNames[selected.getDay()]}
          </strong>
          <span>{selected.getFullYear()}</span>
        </div>
      </div>
      <div
        className={`energy-card energy-card-${load.level}`}
        style={{ "--workload-ink": heat.ink }}
      >
        <div className="energy-card-bar">
          <div
            className="energy-mode-switch"
            role="group"
            aria-label="负荷计算视角"
          >
            <button
              type="button"
              aria-pressed={isCognitive}
              onClick={() => onEnergyModeChange("cognitive")}
            >
              认知精力
            </button>
            <button
              type="button"
              aria-pressed={!isCognitive}
              onClick={() => onEnergyModeChange("density")}
            >
              事项密度
            </button>
          </div>
        </div>
        <div className="energy-card-heading">
          <span>{load.count ? heat.label : "留白时光"}</span>
          <span className="energy-hours">
            {isCognitive && load.count > 0 ? load.cognitiveUnits : load.count}
            <small>{isCognitive && load.count > 0 ? "负荷" : "项"}</small>
          </span>
        </div>
        <div className="energy-meter" aria-hidden="true">
          <i style={{ width: `${(filled / 16) * 100}%` }} />
        </div>
        <p>
          {load.peak > 1
            ? `有 ${load.peak} 项日程时间重叠，可以试着挪一挪。`
            : load.count > 0
              ? isCognitive && load.cognitiveSummary
                ? `${load.cognitiveSummary}（共 ${load.count} 项）`
                : `共 ${load.count} 项安排${load.minutes ? ` · 定时占用 ${Number((load.minutes / 60).toFixed(1))} 小时` : " · 全天日程也计入繁忙程度"}`
              : "还没有安排，把时间留给自己。"}
        </p>
      </div>
      <div className="agenda-heading">
        <h3>
          当日安排 <span>{daily.length}</span>
        </h3>
        <div className="agenda-actions">
          {onPaste && (
            <IconButton label="粘贴到这一天" onClick={onPaste}>
              <ClipboardPaste size={16} />
            </IconButton>
          )}
          <IconButton
            className="sm"
            label="为这一天添加日程"
            onClick={() => onCreate(selected)}
          >
            <Plus size={16} />
          </IconButton>
        </div>
      </div>
      <div className="agenda-list">
        <AnimatePresence initial={false} mode="popLayout">
          {daily.length ? (
            daily.map((event) => {
              const category = categoryOf(event);
              const cog = eventCognitiveInfo(event, aiWeights);
              return (
                <motion.div
                  layout="position"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                  className={`agenda-item ${event.completed ? "completed" : ""}`}
                  key={event.id}
                  style={{ "--event-ink": category.color }}
                  onContextMenu={(e) => {
                    if (!onDelete) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (!onActions) onDelete(event.id);
                  }}
                >
                  <button
                    type="button"
                    className="complete-button"
                    aria-label={`${event.completed ? "取消完成" : "完成"} ${event.title}`}
                    aria-pressed={!!event.completed}
                    onClick={() => onComplete(event.id)}
                  >
                    {event.completed ? (
                      <CircleCheck size={18} />
                    ) : (
                      <Circle size={18} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="agenda-details"
                    onClick={(e) =>
                      onEdit(event.id, e.currentTarget.getBoundingClientRect())
                    }
                  >
                    <strong>{event.title}</strong>
                    <span className="agenda-meta">
                      <span className="agenda-time">
                        {event.allDay
                          ? "全天"
                          : `${formatTime(event.start)} – ${formatTime(event.end)}`}
                      </span>
                      <span className="agenda-tag">
                        <i />
                        {category.label}
                      </span>
                      <span
                        className="cog-badge"
                        data-score={cog.score}
                        title={`认知耗能：${cog.label}（${cog.score}/5 · ${cog.source === "manual" ? "手动设定" : cog.source === "ai" ? "AI 评估" : "自动预估"}）`}
                      >
                        {cog.level.short}
                      </span>
                    </span>
                  </button>
                  {onActions && (
                    <IconButton
                      className="mobile-event-actions"
                      label={`${event.title}的更多操作`}
                      aria-haspopup="menu"
                      onClick={() => onActions(event.id)}
                    >
                      <MoreHorizontal size={18} aria-hidden="true" />
                    </IconButton>
                  )}
                </motion.div>
              );
            })
          ) : (
            <motion.div
              key="empty"
              className="agenda-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <p>留白，也是一种安排。</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => onCreate(selected)}
              >
                <Plus size={14} /> 写下第一项日程
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <button type="button" className="day-view-link" onClick={onDayView}>
        在日视图中展开
        <ArrowUpRight size={15} />
      </button>
    </aside>
  );
}

function SettingsDialog({ model, onClose, onImport, onHelp, onThemeChange }) {
  const [info, setInfo] = useState(null),
    [logoutError, setLogoutError] = useState("");
  const aiConfig = model.aiConfig || {
    mode: "shared",
    hasCustomKey: false,
    customKeyMask: "",
    customBaseUrl: "",
    sharedAvailable: false,
    enabled: false,
  };
  const [aiMode, setAiMode] = useState(aiConfig.mode || "shared");
  const [aiKeyInput, setAiKeyInput] = useState("");
  const [aiBaseUrlInput, setAiBaseUrlInput] = useState(
    aiConfig.customBaseUrl || "",
  );
  const [aiSaving, setAiSaving] = useState(false);
  const [aiError, setAiError] = useState("");
  const serverSession = useServerSession();
  const canConfigureAi = isServer || (isMobile && Boolean(info?.user));
  useEffect(() => {
    setAiMode(aiConfig.mode || "shared");
    setAiBaseUrlInput(aiConfig.customBaseUrl || "");
  }, [aiConfig.mode, aiConfig.customBaseUrl]);
  useEffect(() => {
    const read = () => repository.info().then(setInfo).catch(() => {});
    read(); return repository.onChanged?.(read);
  }, []);
  const handleAiModeChange = async (nextMode) => {
    setAiError("");
    setAiMode(nextMode);
    if (nextMode === "shared" || aiConfig.hasCustomKey || !canConfigureAi) {
      setAiSaving(true);
      try {
        await model.updateAiConfig?.({ mode: nextMode });
      } catch (error) {
        setAiError(error.message || "保存 AI API 设置失败");
      } finally {
        setAiSaving(false);
      }
    }
  };
  const handleSaveCustomAi = async (e) => {
    e.preventDefault();
    setAiError("");
    const trimmedKey = aiKeyInput.trim();
    const trimmedUrl = aiBaseUrlInput.trim();
    if (!trimmedKey && !aiConfig.hasCustomKey && canConfigureAi) {
      setAiError("请输入你的 Gemini API Key");
      return;
    }
    setAiSaving(true);
    try {
      await model.updateAiConfig?.({
        mode: "custom",
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
        baseUrl: trimmedUrl,
      });
      setAiKeyInput("");
    } catch (error) {
      setAiError(error.message || "保存 AI API 设置失败");
    } finally {
      setAiSaving(false);
    }
  };
  const handleClearCustomKey = async () => {
    setAiError("");
    setAiSaving(true);
    try {
      await model.updateAiConfig?.({ apiKey: "" });
      setAiKeyInput("");
    } catch (error) {
      setAiError(error.message || "清除密钥失败");
    } finally {
      setAiSaving(false);
    }
  };
  return (
    <Dialog label="偏好与数据" onClose={onClose} className="settings-dialog">
      <div className="dialog-top">
        <div>
          <span className="eyebrow">偏好设置</span>
          <h2>按你的节奏来</h2>
        </div>
        <IconButton label="关闭设置" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="settings-section">
        <h3>外观与日历</h3>
        <div className="setting-row">
          <span>外观主题</span>
          <Segmented
            label="外观主题"
            layoutId="seg-theme"
            value={model.settings.theme}
            onChange={(theme, e) =>
              onThemeChange
                ? onThemeChange(theme, e?.currentTarget)
                : model.updateSettings({ theme })
            }
            options={[
              { value: "light", label: "浅色", icon: <Sun size={14} /> },
              { value: "dark", label: "深色", icon: <Moon size={14} /> },
              { value: "system", label: "跟随系统", icon: <Laptop size={14} /> },
            ]}
          />
        </div>
        <div className="setting-row">
          <span>启动时的视图</span>
          <Segmented
            label="启动时的视图"
            layoutId="seg-view"
            value={model.settings.defaultView}
            onChange={(defaultView) => model.updateSettings({ defaultView })}
            options={viewNames.map((v) => ({ value: v.id, label: v.label }))}
          />
        </div>
        <div className="setting-row">
          <span>每周开始于</span>
          <Segmented
            label="每周开始于"
            layoutId="seg-week"
            value={model.settings.weekStart}
            onChange={(weekStart) => model.updateSettings({ weekStart })}
            options={[
              { value: 1, label: "周一" },
              { value: 0, label: "周日" },
            ]}
          />
        </div>
        <label className="setting-row">
          <span>
            显示周末
            <small>关闭后，月视图与周视图只显示工作日</small>
          </span>
          <input
            className="switch"
            role="switch"
            aria-label="显示周末"
            type="checkbox"
            checked={model.settings.showWeekends}
            onChange={(e) =>
              model.updateSettings({ showWeekends: e.target.checked })
            }
          />
        </label>
        <label className="setting-row">
          <span>
            删除前确认
            <small>关闭后，删除日程不再弹出确认</small>
          </span>
          <input
            className="switch"
            role="switch"
            aria-label="删除前确认"
            type="checkbox"
            checked={model.settings.confirmBeforeDelete}
            onChange={(e) =>
              model.updateSettings({ confirmBeforeDelete: e.target.checked })
            }
          />
        </label>
      </div>
      <div className="settings-section">
        <h3>AI 智能与 API</h3>
        {isMobile && !canConfigureAi ? (
          <p className="data-help">登录服务器账号后可启用文字、图片和语音快建。</p>
        ) : <>
        <div className="setting-row ai-config-mode-row">
          <span>
            API 来源
            <small>
              {aiMode === "custom"
                ? aiConfig.hasCustomKey
                  ? `使用你自己的 API（已保存 ${aiConfig.customKeyMask}）`
                  : "填写你自己的 Gemini API Key 并保存后即可使用"
                : aiConfig.sharedAvailable
                  ? "当前使用默认提供的服务端 API"
                  : canConfigureAi
                    ? "服务端未配置默认 API Key，可切换并使用你自己的 API"
                    : "在网页服务端登录后可选择使用默认提供的 API 或自己的 API"}
            </small>
          </span>
          <Segmented
            label="AI API 来源"
            layoutId="seg-ai-mode"
            value={aiMode}
            onChange={handleAiModeChange}
            options={[
              { value: "custom", label: "使用自己的 API" },
              { value: "shared", label: "使用默认提供的 API" },
            ]}
          />
        </div>
        {aiMode === "custom" && (
          <form className="ai-config-panel" onSubmit={handleSaveCustomAi}>
            <label className="ai-config-field">
              <span>Gemini API Key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  aiConfig.hasCustomKey
                    ? `已保存 ${aiConfig.customKeyMask}（留空保持不变）`
                    : "输入以 AIza 开头的 Gemini API Key"
                }
                value={aiKeyInput}
                disabled={aiSaving}
                onChange={(e) => {
                  setAiKeyInput(e.target.value);
                  if (aiError) setAiError("");
                }}
              />
            </label>
            <label className="ai-config-field">
              <span>接口地址（可选反代 Base URL）</span>
              <input
                type="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="留空默认 https://generativelanguage.googleapis.com"
                value={aiBaseUrlInput}
                disabled={aiSaving}
                onChange={(e) => {
                  setAiBaseUrlInput(e.target.value);
                  if (aiError) setAiError("");
                }}
              />
            </label>
            <div className="ai-config-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={aiSaving}
              >
                {aiSaving ? "正在保存…" : "保存 API 配置"}
              </button>
              {aiConfig.hasCustomKey && (
                <button
                  type="button"
                  className="ghost-button danger-button"
                  disabled={aiSaving}
                  onClick={handleClearCustomKey}
                >
                  清除已存密钥
                </button>
              )}
            </div>
          </form>
        )}
        {aiError && (
          <p className="ai-config-error" role="alert">
            {aiError}
          </p>
        )}
        {!isServer && !isMobile && (
          <p className="data-help">
            当前为本地模式；登录网页服务端账号后，API 配置会保存在你的云端账号中并跨设备生效。
          </p>
        )}
        </>}
      </div>
      <div className="settings-section">
        <h3>数据与备份</h3>
        <p className="settings-description">
          {isDesktop
            ? "日程使用 SQLite 保存在本机，每天启动时自动备份，保留最近 14 份。"
            : isMobile
              ? "日程保存在此设备，可离线使用。登录后，账号日历会与同一服务器上的设备同步。"
              : isServer
                ? "日程保存在服务器，同一账号可在不同设备访问。导入前会保留备份。"
                : "当前为网页预览，数据保存在此浏览器。桌面版使用独立的本地数据库。"}
        </p>
        {isServer && (
          <p className="settings-description">
            空闲时自动读取其他设备的修改；编辑中的内容会保留。
          </p>
        )}
        <div className="data-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={model.demo}
            onClick={model.exportBackup}
          >
            <ArrowDownToLine size={15} /> 导出备份
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={model.demo}
            onClick={onImport}
          >
            <ArrowUpFromLine size={15} /> 导入日程
          </button>
          {typeof repository.openDataFolder === "function" && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => repository.openDataFolder()}
            >
              <FolderOpen size={15} /> 数据目录
            </button>
          )}
        </div>
        <p className="data-help">
          兼容旧版 events.json；导入会合并日程并跳过重复项。
        </p>
        {info?.dataPath && <code className="data-path">{info.dataPath}</code>}
        {isServer && serverSession && (
          <div className="setting-row">
            <span>
              当前账号
              <small>{serverSession.user.username}</small>
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={model.status !== "saved" || model.loading}
              onClick={async () => {
                setLogoutError("");
                try {
                  await model.switchSpace(() => serverSession.logout());
                } catch (error) {
                  setLogoutError(error.message || "退出登录失败");
                  toast.error("退出登录失败", {
                    description: error.message,
                  });
                }
              }}
            >
              退出登录
            </button>
          </div>
        )}
        {logoutError && (
          <p className="data-help" role="alert">
            {logoutError}
          </p>
        )}
      </div>
      {(isLocalApp || isServer) && <SyncPanel model={model} />}
      <div className="settings-bottom">
        <span>
          精力日历 {info?.version || "2.2.0"}
          <small>让时间，留有余地。</small>
        </span>
        <button type="button" className="text-button" onClick={onHelp}>
          <Keyboard size={14} /> {isMobile ? "使用帮助" : "快捷键"}
        </button>
      </div>
    </Dialog>
  );
}

const SHORTCUTS = [
  {
    group: "创建与编辑",
    items: [
      ["新建日程", "N"],
      ["复制 / 粘贴日程", `${MOD} C ${MOD} V`],
      ["创建日程副本", `${MOD} D`],
      ["保存编辑", `${MOD} Enter`],
      ["撤销", `${MOD} Z`],
      ["重做", `${MOD} Shift Z`],
      ["重做", `${MOD} Y`],
    ],
  },
  {
    group: "浏览",
    items: [
      ["回到今天", "T"],
      ["上一段 / 下一段", "← →"],
      ["日 / 周 / 月视图", "1 2 3"],
      ["搜索与命令", `${MOD} K`],
      ["搜索与命令", "/"],
    ],
  },
  {
    group: "界面",
    items: [
      ["小月历跳转", "["],
      ["当日安排面板", "]"],
      ["关闭浮层 / 取消拖动", "Esc"],
      ["打开帮助", "?"],
    ],
  },
];

function HelpDialog({ onClose }) {
  if (isMobile) {
    return (
      <Dialog label="使用帮助" onClose={onClose} className="help-dialog">
        <div className="dialog-top">
          <h2>使用帮助</h2>
          <IconButton label="关闭帮助" onClick={onClose}><X size={18} /></IconButton>
        </div>
        <ul className="mobile-help">
          <li>月视图点日期打开当天清单，长按日期可新建或粘贴日程。</li>
          <li>周视图点时间格可添加日程，长按日程后拖动可以改期。</li>
          <li>日视图点表盘上的色带或清单中的日程即可编辑。清单的更多菜单可以复制、完成或删除日程。</li>
          <li>偏好与数据中可导入或分享 JSON 备份，并登录账号同步。</li>
        </ul>
      </Dialog>
    );
  }
  return (
    <Dialog label="操作与快捷键" onClose={onClose} className="help-dialog">
      <div className="dialog-top">
        <div>
          <span className="eyebrow">操作指南</span>
          <h2>顺手，就好</h2>
          <p>
            点空白处创建。月视图中在日期上稍作停留即可预览当日安排，把预览里的日程拖到其他日期即可改期；周视图中直接拖动日程改期，拖动边缘调整时长。右击日程即可快速删除（可随时撤销）；右击空白日期可新建或粘贴。搜索框输入新名称可直接创建。
          </p>
        </div>
        <IconButton label="关闭帮助" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="shortcut-groups">
        {SHORTCUTS.map((group) => [
          <h3 key={group.group}>{group.group}</h3>,
          ...group.items.map(([text, key], index) => (
            <div key={index}>
              <span>{text}</span>
              <Keys value={key} />
            </div>
          )),
        ])}
      </div>
      <p className="data-help">
        输入文字时，快捷键不会打断你。所有编辑均可撤销，最多保留 30 步。
      </p>
    </Dialog>
  );
}

export function ContextMenu({
  context,
  event,
  dayEvents = [],
  canPaste,
  onClose,
  onEdit,
  onToggle,
  onCopy,
  onDuplicate,
  onDelete,
  onDeleteEvent,
  onDeleteDayEvents,
  onShowDate,
  onCreateHere,
  onPasteHere,
}) {
  const ref = useRef(null);
  const mobileMenu = Boolean(context?.mobile);
  const resolvedDayEvents = dayEvents?.length ? dayEvents : (context?.events ?? []);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!mobileMenu) {
      const left = Math.min(context.x, window.innerWidth - node.offsetWidth - 8);
      const top = Math.min(context.y, window.innerHeight - node.offsetHeight - 8);
      node.style.left = `${Math.max(8, left)}px`;
      node.style.top = `${Math.max(8, top)}px`;
      node.style.transformOrigin = `${context.x - left}px ${context.y - top}px`;
    }
    node.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [context, mobileMenu]);
  const onKeyDown = (e) => {
    const items = [
      ...ref.current.querySelectorAll("button:not(:disabled)"),
    ];
    const i = items.indexOf(document.activeElement);
    if (mobileMenu && e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      items[(i + delta + items.length) % items.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      onClose();
    }
  };
  const act = (fn) => () => {
    onClose();
    fn();
  };
  return (
    <motion.div
      ref={ref}
      className={`context-menu${mobileMenu ? " mobile-context-menu" : ""}`}
      role="menu"
      aria-label={
        event ? `${event.title} 的操作` : `${context.date || "这一天"} 的操作`
      }
      onKeyDown={onKeyDown}
      initial={mobileMenu ? { opacity: 0, y: 24 } : { opacity: 0, scale: 0.94 }}
      animate={mobileMenu ? { opacity: 1, y: 0 } : { opacity: 1, scale: 1 }}
      exit={mobileMenu ? { opacity: 0, y: 24 } : { opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
      transition={{ type: "spring", stiffness: 600, damping: 38 }}
    >
      {event ? (
        <>
          {mobileMenu && <div className="context-menu-label" role="presentation">{event.title}</div>}
          <button type="button" role="menuitem" onClick={act(onEdit)}>
            <SquarePen size={15} /> 编辑日程
          </button>
          <button type="button" role="menuitem" onClick={act(onToggle)}>
            <CircleCheck size={15} />
            {event.completed ? "标记为未完成" : "标记为已完成"}
          </button>
          <button type="button" role="menuitem" onClick={act(onCopy)}>
            <ClipboardCopy size={15} /> 复制
            {!mobileMenu && <kbd>{MOD} C</kbd>}
          </button>
          <button type="button" role="menuitem" onClick={act(onDuplicate)}>
            <Copy size={15} /> 创建副本
            {!mobileMenu && <kbd>{MOD} D</kbd>}
          </button>
          <hr />
          <button
            type="button"
            role="menuitem"
            className="danger-button"
            onClick={act(onDelete)}
          >
            <Trash2 size={15} /> 删除
          </button>
          {mobileMenu && (
            <button type="button" role="menuitem" onClick={onClose}>
              <X size={15} /> 取消
            </button>
          )}
        </>
      ) : (
        <>
          {mobileMenu && (
            <button type="button" role="menuitem" onClick={act(onShowDate)}>
              <CalendarDays size={15} /> 查看当日安排
            </button>
          )}
          <button type="button" role="menuitem" onClick={act(onCreateHere)}>
            <Plus size={15} /> 在此新建日程
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canPaste}
            onClick={act(onPasteHere)}
          >
            <ClipboardPaste size={15} /> 粘贴到这一天
            {!mobileMenu && <kbd>{MOD} V</kbd>}
          </button>
          {mobileMenu && (
            <button type="button" role="menuitem" onClick={onClose}>
              <X size={15} /> 取消
            </button>
          )}
          {!mobileMenu && resolvedDayEvents.length > 0 && (
            <>
              <hr />
              <div className="context-menu-label" role="presentation">
                当日日程 · 点击删除
              </div>
              {resolvedDayEvents.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="danger-button context-menu-event-delete"
                  data-event-id={item.id}
                  aria-label={`删除 ${item.title}`}
                  title={`删除「${item.title}」`}
                  onClick={act(() => (onDeleteEvent || onDelete)?.(item.id))}
                >
                  <Trash2 size={14} />
                  <i
                    className="context-menu-dot"
                    style={{ "--dot": categoryOf(item).color }}
                    aria-hidden="true"
                  />
                  <span className="context-menu-event-title">
                    删除「{item.title}」
                  </span>
                  <small className="context-menu-event-time">
                    {item.allDay ? "全天" : formatTime(item.start)}
                  </small>
                </button>
              ))}
              {resolvedDayEvents.length > 1 && (
                <>
                  <hr />
                  <button
                    type="button"
                    role="menuitem"
                    className="danger-button context-menu-delete-all"
                    data-action="delete-day-all"
                    onClick={act(() =>
                      (onDeleteDayEvents || onDeleteEvent || onDelete)?.(
                        resolvedDayEvents.map((e) => e.id),
                      ),
                    )}
                  >
                    <Trash2 size={15} />
                    <span>删除当日全部日程（{resolvedDayEvents.length} 项）</span>
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
    </motion.div>
  );
}

export default function PlannerApp() {
  const model = usePlanner(),
    calendarRef = useRef(null),
    fileRef = useRef(null);
  const miniPopoverId = useId(),
    filterPopoverId = useId();
  const miniTriggerRef = useRef(null),
    miniPopoverRef = useRef(null),
    filterTriggerRef = useRef(null),
    filterPopoverRef = useRef(null),
    themeButtonRef = useRef(null),
    themeTransitionCountRef = useRef(0);
  const [view, setView] = useState(DEFAULT_SETTINGS.defaultView),
    [selectedDay, setSelectedDay] = useState(new Date()),
    [anchor, setAnchor] = useState(new Date());
  const [range, setRange] = useState(null),
    [draft, setDraft] = useState(null),
    [dialog, setDialog] = useState(null),
    [panel, setPanel] = useState(() => !isMobile && window.innerWidth > 1150);
  const [miniOpen, setMiniOpen] = useState(false),
    [filterOpen, setFilterOpen] = useState(false),
    [miniResetTick, setMiniResetTick] = useState(0),
    [energyMode, setEnergyMode] = useState(() =>
      readUi().energyMode === "density" ? "density" : "cognitive",
    ),
    [searchSeed, setSearchSeed] = useState(null),
    [categories, setCategories] = useState(CATEGORIES.map((c) => c.id)),
    [context, setContext] = useState(null),
    [flash, setFlash] = useState(null),
    [resolvedTheme, setResolvedTheme] = useState("light"),
    [viewDrag, setViewDrag] = useState(null);
  const overlayPanel = useMediaQuery("(max-width: 1150px)");
  model.blockRefresh(Boolean(draft || dialog || context));
  const rangeWaiter = useRef(null),
    currentRange = useRef(null),
    clipboard = useRef(null),
    lastEvent = useRef(null),
    selectedRef = useRef(selectedDay),
    viewRef = useRef(view),
    viewDragPtr = useRef(null),
    viewDragEnd = useRef(0);
  selectedRef.current = selectedDay;
  viewRef.current = view;
  const api = () => calendarRef.current?.getApi();
  const aiEntryEnabled = Boolean(model.aiStatus?.enabled);
  const showAiCaptureEntry = aiEntryEnabled || !isServer;
  const openAiCapture = useCallback(() => {
    if (!aiEntryEnabled) {
      toast("AI 快建当前未启用；本地模式仅保留入口，便于预览和调整布局。");
      return;
    }
    setSearchSeed({ focusAi: true });
    setDialog("search");
  }, [aiEntryEnabled]);
  const closeDraft = useCallback(() => setDraft(null), []),
    closePanel = useCallback(() => setPanel(false), []),
    closeDialog = useCallback(() => {
      setDialog(null);
      setSearchSeed(null);
    }, []);
  const changeEnergyMode = useCallback((mode) => {
    setEnergyMode(mode);
    writeUi({ energyMode: mode });
  }, []);
  const refit = useCallback(() => {
    // FullCalendar measures on window resize; container-only changes need a nudge.
    requestAnimationFrame(() => calendarRef.current?.getApi().updateSize());
  }, []);

  useEffect(() => {
    const miniEl = miniPopoverRef.current;
    const filterEl = filterPopoverRef.current;
    const onMiniToggle = (e) => {
      const open = e.newState === "open";
      setMiniOpen(open);
      if (open) {
        setMiniResetTick((n) => n + 1);
        positionPopoverFallback(miniTriggerRef.current, miniEl, "start");
      }
    };
    const onFilterToggle = (e) => {
      const open = e.newState === "open";
      setFilterOpen(open);
      if (open) {
        positionPopoverFallback(filterTriggerRef.current, filterEl, "end");
      }
    };
    miniEl?.addEventListener("toggle", onMiniToggle);
    filterEl?.addEventListener("toggle", onFilterToggle);
    return () => {
      miniEl?.removeEventListener("toggle", onMiniToggle);
      filterEl?.removeEventListener("toggle", onFilterToggle);
    };
  }, []);

  const closeMiniPopover = useCallback(() => {
    miniPopoverRef.current?.hidePopover?.();
  }, []);
  const toggleMiniPopover = useCallback(() => {
    miniPopoverRef.current?.togglePopover?.();
  }, []);
  const backRef = useRef(null);
  backRef.current = (canGoBack) => {
    if (context) setContext(null);
    else if (draft) closeDraft();
    else if (dialog) closeDialog();
    else if (miniOpen) closeMiniPopover();
    else if (filterOpen) filterPopoverRef.current?.hidePopover?.();
    else if (panel) closePanel();
    else if (canGoBack) window.history.back();
    else CapacitorApp.minimizeApp().catch(() => {});
  };
  useEffect(() => {
    if (!isMobile || Capacitor.getPlatform() !== "android") return;
    const listener = CapacitorApp.addListener("backButton", ({ canGoBack }) => backRef.current(canGoBack));
    listener.catch(() => {});
    return () => { listener.then((handle) => handle.remove()).catch(() => {}); };
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!isMobile || !viewport) return;
    const style = document.documentElement.style;
    const update = () => {
      if (viewport.scale !== 1) return;
      style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
      style.setProperty("--mobile-viewport-top", `${viewport.offsetTop}px`);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      style.removeProperty("--mobile-viewport-height");
      style.removeProperty("--mobile-viewport-top");
    };
  }, []);

  useLayoutEffect(() => {
    if (!model.loading) setView(model.settings.defaultView);
  }, [model.loading]);
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      if (themeTransitionCountRef.current > 0) return;
      const theme = resolveThemeValue(model.settings.theme);
      const root = document.documentElement;
      if (root.getAttribute("data-planner-theme") !== theme) {
        root.classList.add("theme-switching");
        root.setAttribute("data-planner-theme", theme);
        void root.offsetWidth;
        root.classList.remove("theme-switching");
      }
      syncColorSchemeMeta(model.settings.theme, theme);
      setResolvedTheme(theme);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [model.settings.theme]);
  useEffect(() => {
    if (!isMobile) return;
    SystemBars.setStyle({
      style: resolvedTheme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
    }).catch(() => {});
  }, [resolvedTheme]);

  /** Resolves once FullCalendar reports the new date range (or after a short timeout). */
  const waitForRange = useCallback(
    () =>
      new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          rangeWaiter.current = null;
          setTimeout(resolve, 16);
        };
        const timer = setTimeout(done, 360);
        rangeWaiter.current = done;
      }),
    [],
  );
  const transitionNav = useCallback(
    (type, update) =>
      runViewTransition(type, update, {
        className: "vt-nav",
        settle: api() ? waitForRange : undefined,
      }),
    [waitForRange],
  );
  const navigate = useCallback(
    (date) => {
      const target = localDate(date);
      const calendar = api(),
        current = currentRange.current;
      if (!calendar || !current || (target >= current.start && target < current.end)) {
        setSelectedDay(target);
        calendar?.gotoDate(target);
        return;
      }
      transitionNav(target < current.start ? "backward" : "forward", () => {
        setSelectedDay(target);
        calendar.gotoDate(target);
      });
    },
    [transitionNav],
  );
  const step = useCallback(
    (direction) => {
      const calendar = api();
      if (!calendar) return;
      transitionNav(direction > 0 ? "forward" : "backward", () => {
        if (direction > 0) calendar.next();
        else calendar.prev();
        setSelectedDay(calendar.getDate());
      });
    },
    [transitionNav],
  );
  const changeView = useCallback(
    (next, target = selectedRef.current) => {
      if (next === viewRef.current) return;
      const calendar = api();
      transitionNav("zoom", () => {
        setView(next);
        setSelectedDay(target);
        calendar?.changeView(next, target);
      });
    },
    [transitionNav],
  );
  const onRange = useCallback((info) => {
    currentRange.current = {
      start: new Date(info.view.currentStart),
      end: new Date(info.view.currentEnd),
    };
    setAnchor(new Date(info.view.currentStart));
    setRange((prev) =>
      prev?.start === info.startStr &&
      prev?.end === info.endStr &&
      prev?.title === info.view.title
        ? prev
        : {
            start: info.startStr,
            end: info.endStr,
            title: info.view.title,
            currentStart: +info.view.currentStart,
            currentEnd: +info.view.currentEnd,
          },
    );
    rangeWaiter.current?.();
  }, []);
  const togglePanel = useCallback(() => setPanel((p) => !p), []);
  const changeTheme = useCallback(
    (nextSetting, originEl = null) => {
      const nextResolved = resolveThemeValue(nextSetting);
      const root = document.documentElement;
      const currentResolved =
        root.getAttribute("data-planner-theme") || resolvedTheme;
      if (nextResolved === currentResolved) {
        syncColorSchemeMeta(nextSetting, nextResolved);
        model.updateSettings({ theme: nextSetting });
        return;
      }
      const targetEl = originEl || themeButtonRef.current;
      const rect = targetEl?.getBoundingClientRect?.();
      const hasRect = rect && (rect.width > 0 || rect.height > 0);
      const x = hasRect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const y = hasRect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      root.style.setProperty("--vt-x", `${x}px`);
      root.style.setProperty("--vt-y", `${y}px`);
      root.style.setProperty(
        "--vt-r",
        `${Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))}px`,
      );
      themeTransitionCountRef.current += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        themeTransitionCountRef.current = Math.max(
          0,
          themeTransitionCountRef.current - 1,
        );
      };
      const transition = runViewTransition(
        "theme",
        () => {
          root.setAttribute("data-planner-theme", nextResolved);
          syncColorSchemeMeta(nextSetting, nextResolved);
          flushSync(() => setResolvedTheme(nextResolved));
          model.updateSettings({ theme: nextSetting });
        },
        { className: "theme-switching" },
      );
      if (transition) {
        Promise.resolve(transition.finished).finally(release);
      } else {
        release();
      }
    },
    [resolvedTheme, model.updateSettings],
  );
  const toggleTheme = useCallback(
    (e) => {
      const next = resolvedTheme === "dark" ? "light" : "dark";
      changeTheme(next, e?.currentTarget || null);
    },
    [resolvedTheme, changeTheme],
  );
  const createForDay = useCallback((date) => {
    if (isMobile) setPanel(false);
    setDraft({ start: dateKey(date), allDay: true });
  }, []);
  const newEvent = useCallback(
    (title = "") => {
      const start = new Date(selectedDay);
      const now = new Date();
      start.setHours(now.getHours(), Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
      setDraft({ start, end: new Date(+start + 3600000), allDay: false, title });
    },
    [selectedDay],
  );
  const createAt = useCallback((ctx) => {
    if (ctx.allDay) {
      setDraft({ start: ctx.date, allDay: true });
      return;
    }
    const start = localDate(ctx.date);
    start.setHours(0, ctx.minutes ?? 540, 0, 0);
    setDraft({ start, end: new Date(+start + 3600000), allDay: false });
  }, []);
  const editEvent = useCallback(
    (id, rect, extra) => {
      const event = model.events.find((e) => e.id === id);
      if (event) {
        if (isMobile) setPanel(false);
        lastEvent.current = id;
        setDraft({ event, rect, ...extra });
      }
    },
    [model.events],
  );
  const duplicateEvent = useCallback(
    (id) => {
      const event = model.events.find((e) => e.id === id);
      if (!event) return;
      // eslint-disable-next-line no-unused-vars
      const { id: _id, ...rest } = event;
      model.saveEvent({
        ...rest,
        title: `${event.title}（副本）`.slice(0, 200),
        completed: false,
      });
    },
    [model.events, model.saveEvent],
  );
  const copyEvent = useCallback(
    (id) => {
      const event = model.events.find((e) => e.id === id);
      if (!event) return;
      // eslint-disable-next-line no-unused-vars
      const { id: _id, ...rest } = event;
      clipboard.current = { ...rest, completed: false };
      lastEvent.current = id;
      toast(`已复制「${event.title.slice(0, 40)}」`, {
        description: isMobile ? "在目标日期点粘贴按钮" : `${MOD} V 粘贴到所选日期`,
      });
    },
    [model.events],
  );
  const pasteTo = useCallback(
    (day, minutes = null) => {
      const clip = clipboard.current;
      if (!clip) return false;
      const startDay = localDate(day);
      let start, end;
      if (clip.allDay) {
        const span = Math.max(
          1,
          Math.round(
            (+localDate(clip.end) - +localDate(clip.start)) / 86400000,
          ),
        );
        start = dateKey(startDay);
        end = dateKey(addDays(startDay, span));
      } else {
        const source = localDate(clip.start);
        if (minutes == null)
          startDay.setHours(source.getHours(), source.getMinutes(), 0, 0);
        else startDay.setHours(0, minutes, 0, 0);
        start = startDay;
        end = new Date(
          +startDay + (+localDate(clip.end) - +localDate(clip.start)),
        );
      }
      return model.saveEvent({ ...clip, start, end, allDay: clip.allDay });
    },
    [model.saveEvent],
  );
  const openContext = useCallback((ctx) => {
    if (ctx.id) lastEvent.current = ctx.id;
    setContext(ctx);
  }, []);
  const showDay = useCallback((date) => {
    setSelectedDay(date);
    setPanel(true);
  }, []);
  const openEventActions = useCallback((id, fromEditor = false) => {
    openContext({ id, mobile: true, fromEditor });
  }, [openContext]);
  const filtered = useMemo(
    () => model.events.filter((e) => categories.includes(e.tag)),
    [model.events, categories],
  );
  const scopeCount = useMemo(() => {
    const start = range?.currentStart ??
        +new Date(anchor.getFullYear(), anchor.getMonth(), 1),
      end = range?.currentEnd ??
        +new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    return model.events.filter(
      (e) => +localDate(e.start) < end && +localDate(e.end) > start,
    ).length;
  }, [model.events, anchor, range]);
  const categoryCounts = useMemo(() => {
    const counts = new Map();
    model.events.forEach((e) => counts.set(e.tag, (counts.get(e.tag) || 0) + 1));
    return counts;
  }, [model.events]);
  const importData = () => {
    if (typeof repository.importBackup === "function") model.importBackup();
    else fileRef.current?.click();
  };
  const today = useCallback(() => navigate(new Date()), [navigate]);

  useEffect(() => {
    const key = (e) => {
      if (
        e.isComposing ||
        e.target?.closest?.('input,textarea,select,[contenteditable="true"]')
      )
        return;
      const mod = e.ctrlKey || e.metaKey,
        k = e.key.toLowerCase();
      if (context) {
        if (e.key === "Escape") setContext(null);
        else if (mod && k === "c" && context.id) {
          e.preventDefault();
          copyEvent(context.id);
        } else if (mod && k === "d" && context.id) {
          e.preventDefault();
          duplicateEvent(context.id);
          setContext(null);
        } else if (mod && k === "v") {
          e.preventDefault();
          if (context.date) pasteTo(context.date, context.minutes);
          else pasteTo(selectedRef.current);
          setContext(null);
        }
        return;
      }
      if (draft || dialog) return;
      if (mod && k === "k") {
        e.preventDefault();
        setSearchSeed(null);
        setDialog("search");
      } else if (mod && k === "z") {
        e.preventDefault();
        e.shiftKey ? model.redo() : model.undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        model.redo();
      } else if (mod && k === "c" && lastEvent.current) {
        e.preventDefault();
        copyEvent(lastEvent.current);
      } else if (mod && k === "d" && lastEvent.current) {
        e.preventDefault();
        duplicateEvent(lastEvent.current);
      } else if (mod && k === "v" && clipboard.current) {
        e.preventDefault();
        pasteTo(selectedRef.current);
      } else if (!mod && !e.altKey) {
        if (k === "n") {
          e.preventDefault();
          newEvent();
        } else if (k === "t") {
          e.preventDefault();
          today();
        } else if (["1", "2", "3"].includes(k)) {
          e.preventDefault();
          changeView(viewNames[Number(k) - 1].id);
        } else if (k === "arrowleft" || k === "arrowright") {
          e.preventDefault();
          step(k === "arrowright" ? 1 : -1);
        } else if (k === "[") {
          e.preventDefault();
          toggleMiniPopover();
        } else if (k === "]") {
          e.preventDefault();
          togglePanel();
        } else if (k === "/") {
          e.preventDefault();
          setSearchSeed(null);
          setDialog("search");
        } else if (k === "?") {
          e.preventDefault();
          setDialog("help");
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [
    draft,
    dialog,
    context,
    model.undo,
    model.redo,
    newEvent,
    today,
    changeView,
    step,
    toggleMiniPopover,
    togglePanel,
    copyEvent,
    duplicateEvent,
    pasteTo,
  ]);

  useEffect(() => {
    const onPaste = (e) => {
      if (
        !model.aiStatus?.enabled ||
        draft ||
        dialog ||
        context ||
        e.target?.closest?.('input,textarea,select,[contenteditable="true"]')
      ) {
        return;
      }
      const items = [...(e.clipboardData?.items || [])];
      const imgItem = items.find((item) => item.type.startsWith("image/"));
      const file =
        imgItem?.getAsFile?.() ||
        [...(e.clipboardData?.files || [])].find((f) =>
          f.type.startsWith("image/"),
        );
      if (!file) return;
      e.preventDefault();
      if (file.size > 10 * 1024 * 1024) {
        toast.error("图片体积超过 10 MB 上限");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setSearchSeed({
          focusAi: true,
          image: {
            data: String(reader.result || ""),
            mimeType: file.type || "image/png",
            name: file.name || "剪贴板截图",
          },
        });
        setDialog("search");
      };
      reader.readAsDataURL(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [model.aiStatus?.enabled, draft, dialog, context]);

  const actions = useMemo(
    () => [
      ...(model.aiStatus?.enabled
        ? [
            {
              id: "ai-capture",
              label: "AI 多模态快建日程（文字 / 截图 / 语音）",
              keywords: "ai capture voice image 语音 截图 快建",
              icon: <Sparkles size={15} />,
              run: () => {
                setSearchSeed({ focusAi: true });
                setDialog("search");
              },
            },
          ]
        : []),
      { id: "new", label: "新建日程", keywords: "create add new", icon: <Plus size={15} />, shortcut: "N", run: newEvent },
      { id: "today", label: "回到今天", keywords: "today", icon: <CalendarCheck size={15} />, shortcut: "T", run: today },
      { id: "mini-calendar", label: "小月历跳转", keywords: "calendar jump date mini 日历 跳转", icon: <CalendarDays size={15} />, shortcut: "[", run: () => setTimeout(() => toggleMiniPopover(), 0) },
      { id: "dial", label: "切换到日视图", keywords: "day dial 表盘 日 环", icon: <Clock3 size={15} />, shortcut: "1", run: () => changeView("energyDial") },
      { id: "week", label: "切换到周视图", keywords: "week", icon: <CalendarRange size={15} />, shortcut: "2", run: () => changeView("timeGridWeek") },
      { id: "month", label: "切换到月视图", keywords: "month", icon: <CalendarDays size={15} />, shortcut: "3", run: () => changeView("dayGridMonth") },
      {
        id: "energy-mode",
        label: energyMode === "cognitive" ? "负荷视角：切换为事项密度" : "负荷视角：切换为认知精力",
        keywords: "energy cognitive density 认知 精力 密度 热力",
        icon: <Sparkles size={15} />,
        run: () =>
          changeEnergyMode(energyMode === "cognitive" ? "density" : "cognitive"),
      },
      { id: "theme", label: resolvedTheme === "dark" ? "切换到浅色主题" : "切换到深色主题", keywords: "theme dark light 主题", icon: <SunMoon size={15} />, run: () => toggleTheme() },
      { id: "panel", label: panel ? "隐藏当日安排" : "显示当日安排", keywords: "panel agenda", icon: <PanelRight size={15} />, shortcut: "]", run: togglePanel },
      { id: "settings", label: "偏好与数据", keywords: "settings backup import export 设置 备份 导入 导出", icon: <Settings2 size={15} />, run: () => setDialog("settings") },
      { id: "help", label: "操作与快捷键", keywords: "help shortcuts 帮助", icon: <Keyboard size={15} />, shortcut: "?", run: () => setDialog("help") },
    ],
    [
      model.aiStatus?.enabled,
      energyMode,
      changeEnergyMode,
      newEvent,
      today,
      toggleMiniPopover,
      changeView,
      toggleTheme,
      togglePanel,
      resolvedTheme,
      panel,
    ],
  );

  const chooseCategory = (id) =>
    setCategories((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  const viewMeta = viewNames.find((v) => v.id === view) || viewNames[0];
  const contextEvent = context?.id
    ? model.events.find((e) => e.id === context.id)
    : null;
  const contextDayEvents = useMemo(() => {
    if (!context?.date || context?.id) return [];
    if (view !== "dayGridMonth" && !context.allDay) return [];
    return filtered
      .filter((e) => eventOnDay(e, context.date))
      .sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) ||
          +localDate(a.start) - +localDate(b.start),
      );
  }, [context, view, filtered]);
  const isFiltered = categories.length < CATEGORIES.length;
  const activeCategories = CATEGORIES.filter((c) => categories.includes(c.id));
  const filterLabel = !isFiltered
    ? "分类"
    : activeCategories.length === 1
      ? activeCategories[0].label
      : activeCategories.length === 0
        ? "已隐藏"
        : `${activeCategories.length}/${CATEGORIES.length}`;

  const panelNode = panel && view !== "energyDial" && (
    <TodayPanel
      selected={selectedDay}
      events={filtered}
      allEvents={model.events}
      aiWeights={model.aiWeights}
      energyMode={energyMode}
      onEnergyModeChange={changeEnergyMode}
      onClose={closePanel}
      onEdit={editEvent}
      onDelete={model.deleteEvent}
      onComplete={model.toggleComplete}
      onCreate={createForDay}
      onActions={isMobile ? openEventActions : undefined}
      onPaste={isMobile && clipboard.current ? () => pasteTo(selectedDay) : undefined}
      onDayView={() => {
        if (isMobile || overlayPanel) closePanel();
        changeView("energyDial");
        navigate(selectedDay);
      }}
    />
  );

  const segAt = (container, clientX) => {
    const buttons = [...container.querySelectorAll("[data-view]")];
    if (!buttons.length) return null;
    const index = buttons.findIndex((b) => {
      const r = b.getBoundingClientRect();
      return clientX >= r.left && clientX < r.right;
    });
    if (index !== -1) return buttons[index].dataset.view;
    return clientX < buttons[0].getBoundingClientRect().left
      ? buttons[0].dataset.view
      : buttons.at(-1).dataset.view;
  };
  const segDragHandlers = isMobile
    ? {
        onPointerDown: (e) => {
          viewDragPtr.current = { id: e.pointerId, x: e.clientX, moved: false, captured: false };
        },
        onPointerMove: (e) => {
          const p = viewDragPtr.current;
          if (!p || p.id !== e.pointerId) return;
          if (!p.moved) {
            if (Math.abs(e.clientX - p.x) <= 6) return;
            p.moved = true;
            if (!p.captured) {
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* capture is best-effort */
              }
              p.captured = true;
            }
          }
          setViewDrag(segAt(e.currentTarget, e.clientX));
        },
        onPointerUp: (e) => {
          const p = viewDragPtr.current;
          viewDragPtr.current = null;
          if (!p || p.id !== e.pointerId || !p.moved) return;
          const target = segAt(e.currentTarget, e.clientX);
          viewDragEnd.current = Date.now();
          setViewDrag(null);
          if (target && target !== view) changeView(target);
        },
        onPointerCancel: () => {
          viewDragPtr.current = null;
          setViewDrag(null);
        },
      }
    : {};
  const navCluster = (
    <div className="nav-cluster">
      <IconButton label="上一段时间" shortcut="←" onClick={() => step(-1)}>
        <ChevronLeft size={18} />
      </IconButton>
      <button
        type="button"
        className="today-button"
        title="回到今天（T）"
        onClick={today}
      >
        今天
      </button>
      <IconButton label="下一段时间" shortcut="→" onClick={() => step(1)}>
        <ChevronRight size={18} />
      </IconButton>
    </div>
  );
  const viewSwitch = (
    <div className="segmented" aria-label="日历视图" role="group" {...segDragHandlers}>
      {viewNames.map((v) => (
        <button
          type="button"
          key={v.id}
          data-view={v.id}
          aria-pressed={view === v.id}
          title={`${v.label}视图（${viewNames.indexOf(v) + 1}）`}
          onClick={() => {
            if (Date.now() - viewDragEnd.current < 350) return;
            changeView(v.id);
          }}
        >
          {(viewDrag ?? view) === v.id && (
            <motion.span
              className="segment-highlight"
              layoutId="view-highlight"
              transition={{ type: "spring", stiffness: 520, damping: 40 }}
            />
          )}
          <span>{v.label}</span>
        </button>
      ))}
    </div>
  );
  const aiCaptureButton = showAiCaptureEntry && (
    <button
      type="button"
      className={`ai-capture-trigger${aiEntryEnabled ? "" : " is-unavailable"}`}
      aria-label="AI 多模态快建日程"
      aria-disabled={!aiEntryEnabled}
      title={
        aiEntryEnabled
          ? "AI 快建：输入文字、粘贴截图或语音录入"
          : "本地布局预览：AI 快建当前未启用"
      }
      onClick={openAiCapture}
    >
      <Sparkles size={14} />
      <span>AI 快建</span>
    </button>
  );
  const historyButtons = (
    <div className="history-buttons">
      <IconButton
        label="撤销"
        shortcut={`${MOD} Z`}
        disabled={!model.historyState.undo}
        onClick={model.undo}
      >
        <Undo2 size={15} />
      </IconButton>
      <IconButton
        label="重做"
        shortcut={`${MOD} Shift Z`}
        disabled={!model.historyState.redo}
        onClick={model.redo}
      >
        <Redo2 size={15} />
      </IconButton>
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="planner-shell" data-mobile={isMobile ? "" : undefined}>
        <Toaster
          position={isMobile ? "top-center" : "bottom-right"}
          theme={resolvedTheme}
          offset={24}
          mobileOffset={isMobile ? { top: "calc(var(--safe-top, 0px) + 8px)" } : undefined}
          gap={10}
          toastOptions={{ duration: 3200 }}
        />
        <main className="planner-main">
          <header className="topbar">
            <div className="topbar-left">
              {!isMobile && (
                <a
                  className="topbar-brand"
                  href="#"
                  title="精力日历 · 回到今天（T）"
                  aria-label="精力日历，回到今天"
                  onClick={(e) => {
                    e.preventDefault();
                    today();
                  }}
                >
                  <span className="brand-symbol">
                    <BrandMark size={18} />
                  </span>
                </a>
              )}
              {!isMobile && navCluster}
              <div className="topbar-title">
                <button
                  type="button"
                  ref={miniTriggerRef}
                  popoverTarget={miniPopoverId}
                  className={`date-picker-trigger ${miniOpen ? "is-open" : ""}`}
                  aria-expanded={miniOpen}
                  aria-label="打开小月历跳转日期"
                  title="小月历跳转（[）"
                >
                  <h1 aria-live="polite">
                    {view === "dayGridMonth" || !range ? (
                      <>
                        {anchor.getMonth() + 1} 月
                        <span className="title-year">{anchor.getFullYear()}</span>
                      </>
                    ) : (
                      <>
                        <span className="title-year-prefix">{range.title.match(/^\d{4}年/)?.[0]}</span>
                        {range.title.replace(/^\d{4}年/, "")}
                      </>
                    )}
                  </h1>
                  <ChevronDown size={15} className="trigger-chevron" aria-hidden="true" />
                </button>
                <span className="title-meta">
                  {viewMeta.scope} {scopeCount} 项安排
                </span>
                <div
                  id={miniPopoverId}
                  ref={miniPopoverRef}
                  popover="auto"
                  className="topbar-popover mini-calendar-popover"
                  aria-label="小月历"
                >
                  <MiniCalendar
                    anchor={anchor}
                    selected={selectedDay}
                    onDate={(day) => {
                      closeMiniPopover();
                      navigate(day);
                    }}
                    onToday={() => {
                      closeMiniPopover();
                      today();
                    }}
                    onEdit={editEvent}
                    onDelete={model.deleteEvent}
                    firstDay={model.settings.weekStart}
                    events={model.events}
                    aiWeights={model.aiWeights}
                    energyMode={energyMode}
                    preview={false}
                    resetSignal={miniResetTick}
                  />
                </div>
              </div>
              {isMobile && (
                <button
                  type="button"
                  className="mobile-today"
                  title="回到今天（T）"
                  onClick={today}
                >
                  今天
                </button>
              )}
            </div>
            <div className="topbar-right">
              {!isMobile && viewSwitch}
              {!isMobile && (
                <>
                  <button
                    type="button"
                    ref={filterTriggerRef}
                    popoverTarget={filterPopoverId}
                    className={`filter-trigger ${isFiltered ? "is-filtered" : ""} ${filterOpen ? "is-open" : ""}`}
                    aria-expanded={filterOpen}
                    aria-label="筛选日程分类"
                    title="筛选日程分类"
                  >
                    <span className="filter-dots" aria-hidden="true">
                      {activeCategories.length > 0 ? (
                        activeCategories.slice(0, 5).map((c) => (
                          <i key={c.id} style={{ background: c.color }} />
                        ))
                      ) : (
                        <i className="is-empty" />
                      )}
                    </span>
                    <span className="filter-label">{filterLabel}</span>
                    <ChevronDown size={13} className="trigger-chevron" aria-hidden="true" />
                  </button>
                  <div
                    id={filterPopoverId}
                    ref={filterPopoverRef}
                    popover="auto"
                    className="topbar-popover filter-popover"
                    aria-label="日程分类筛选"
                  >
                    <div className="sidebar-section-heading">
                      <span>日程分类</span>
                      {isFiltered && (
                        <button
                          type="button"
                          onClick={() => setCategories(CATEGORIES.map((c) => c.id))}
                        >
                          全部显示
                        </button>
                      )}
                    </div>
                    {CATEGORIES.map((c) => {
                      const on = categories.includes(c.id);
                      return (
                        <div
                          className="category-row"
                          key={c.id}
                          style={{ "--category": c.color }}
                        >
                          <button
                            type="button"
                            className="category-filter"
                            aria-pressed={on}
                            onClick={() => chooseCategory(c.id)}
                          >
                            <span className={`category-checkbox ${on ? "checked" : ""}`}>
                              {on && (
                                <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
                                  <path
                                    d="M2.5 6.2 5 8.6l4.5-5"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              )}
                            </span>
                            <span>{c.label}</span>
                            <small>{categoryCounts.get(c.id) || ""}</small>
                          </button>
                          <button
                            type="button"
                            className="category-only"
                            aria-label={`仅显示${c.label}`}
                            onClick={() => setCategories([c.id])}
                          >
                            仅此
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              {isMobile && aiCaptureButton}
              <button
                type="button"
                className="search-trigger"
                aria-label="搜索日程"
                onClick={() => {
                  setSearchSeed(null);
                  setDialog("search");
                }}
              >
                <Search size={15} />
                <span>
                  {model.aiStatus?.enabled ? "搜索、操作或 AI 快建" : "搜索或执行操作"}
                </span>
                <Keys value={`${MOD} K`} />
              </button>
              {!isMobile && aiCaptureButton}
              {!isMobile && <button
                type="button"
                className="topbar-create"
                disabled={model.loading || !!model.loadError}
                title="新建日程（N）"
                aria-label="新建日程"
                onClick={() => newEvent()}
              >
                <Plus size={15} />
                <span>新建</span>
              </button>}
              <span className="topbar-divider" />
              <IconButton
                ref={themeButtonRef}
                label="切换明暗主题"
                onClick={toggleTheme}
              >
                {resolvedTheme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
              </IconButton>
              <IconButton
                label="偏好与数据"
                onClick={() => setDialog("settings")}
              >
                <Settings2 size={17} />
              </IconButton>
              {view !== "energyDial" && (
                <IconButton
                  label={panel ? "隐藏当日安排" : "显示当日安排"}
                  shortcut="]"
                  className={panel ? "is-active" : ""}
                  aria-pressed={panel}
                  onClick={togglePanel}
                >
                  <PanelRight size={17} />
                </IconButton>
              )}
            </div>
          </header>
          <AnimatePresence initial={false}>
            {model.demo && (
              <motion.div
                className="demo-banner"
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: "auto", marginBottom: 12 }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.28, ease: EASE_OUT }}
                onAnimationComplete={refit}
              >
                <Sparkles size={15} />
                <strong>示例空间</strong>
                <span>放心拖动与编辑，不会改变你的日历。</span>
                <button type="button" onClick={() => model.setDemoMode(false)}>
                  回到我的日历 <ArrowUpRight size={13} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          <section className="workspace-content">
            <div className="calendar-section">
              {model.loading ? (
                <div className="calendar-skeleton" aria-label="正在打开你的时间…" role="status">
                  {Array.from({ length: 42 }, (_, i) => (
                    <span key={i} />
                  ))}
                </div>
              ) : model.loadError ? (
                <div className="canvas-placeholder error-state">
                  <ShieldCheck size={36} />
                  <h2>数据仍在原处</h2>
                  <p>暂时无法读取日历：{model.loadError}</p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={model.reload}
                  >
                    重新读取
                  </button>
                </div>
              ) : (
                <div className="canvas-container">
                  <Suspense
                    fallback={
                      <div className="calendar-skeleton" role="status">
                        {Array.from({ length: 42 }, (_, i) => (
                          <span key={i} />
                        ))}
                      </div>
                    }
                  >
                    <CalendarCanvas
                      ref={calendarRef}
                      events={filtered}
                      allEvents={model.events}
                      settings={model.settings}
                      view={view}
                      selectedDay={selectedDay}
                      range={range}
                      flash={flash}
                      onDate={setSelectedDay}
                      onCreate={setDraft}
                      onEdit={editEvent}
                      onDelete={model.deleteEvent}
                      onMove={model.moveEvent}
                      onRange={onRange}
                      onContext={openContext}
                      onShowDay={isMobile ? showDay : undefined}
                      onEventActions={isMobile ? openEventActions : undefined}
                      onSwipe={isMobile ? step : undefined}
                      onPaste={isMobile && clipboard.current ? () => pasteTo(selectedDay) : undefined}
                      aiWeights={model.aiWeights}
                      energyMode={energyMode}
                    />
                  </Suspense>
                  {isMobile && (
                    <button
                      className="mobile-create"
                      type="button"
                      aria-label="新建日程"
                      onClick={() => newEvent()}
                    >
                      <Plus size={26} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
              {!isMobile && (
              <footer className="calendar-footer">
                <div className={`save-indicator ${model.status}`} role="status">
                  <i />
                  {model.demo ? (
                    <span>示例空间 · 更改不会保存</span>
                  ) : model.status === "error" ? (
                    <button type="button" onClick={model.retry}>
                      尚未保存 · 重试保存
                    </button>
                  ) : model.status === "saving" ? (
                    <span>正在保存…</span>
                  ) : isLocalApp ? (
                    <><span>已保存在本机</span><SyncStatus /></>
                  ) : isServer ? (
                    <span>已保存到服务器</span>
                  ) : (
                    <span>已保存在此浏览器</span>
                  )}
                </div>
                <span className="footer-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="storage-card footer-space-trigger"
                  title="空间状态与偏好设置"
                  onClick={() => setDialog("settings")}
                >
                  <span className="footer-space-icon" aria-hidden="true">
                    {isServer ? <Cloud size={13} /> : <HardDrive size={13} />}
                  </span>
                  <StorageLabel server={isServer} />
                </button>
                {historyButtons}
              </footer>
              )}
            </div>
            <AnimatePresence>
              {!isMobile && panel && overlayPanel && (
                <motion.div
                  key="panel-scrim"
                  className="panel-scrim"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setPanel(false)}
                />
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {!isMobile && panel &&
                (overlayPanel ? (
                  <motion.div
                    key="panel-overlay"
                    className="day-panel-wrap"
                    initial={{ opacity: 0, x: 28 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 28, transition: { duration: 0.18 } }}
                    transition={{ type: "spring", stiffness: 420, damping: 40 }}
                  >
                    {panelNode}
                  </motion.div>
                ) : (
                  <motion.div
                    key="panel-inline"
                    className="day-panel-wrap"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: "auto", opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: 0.34, ease: EASE_OUT }}
                    onAnimationComplete={refit}
                  >
                    {panelNode}
                  </motion.div>
                ))}
            </AnimatePresence>
          </section>
          {isMobile && (
            <div className="mobile-tabbar">
              <div className="mobile-status-strip" role="status">{model.status === "error" && (
                <button type="button" className="mobile-status-error" onClick={model.retry}>尚未保存 · 重试保存</button>
              )}{isLocalApp && <SyncStatus alertsOnly onOpen={() => setDialog("settings")} />}</div>
              <div className="mobile-tabbar-row">{viewSwitch}{historyButtons}</div>
            </div>
          )}
        </main>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="visually-hidden"
          aria-label="导入日历文件"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) {
              if (file.size > 20 * 1024 * 1024) toast.error("文件超过 20 MB");
              else await model.importBackup(await file.text());
            }
            e.target.value = "";
          }}
        />
        <AnimatePresence>
          {isMobile && panelNode && (
            <Dialog key="mobile-day" label="当日安排" className="mobile-day-dialog" onClose={closePanel}>
              {panelNode}
            </Dialog>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {draft && (
            <EventEditor
              key={draft.event?.id || "new"}
              draft={draft}
              onSave={model.saveEvent}
              onDelete={model.deleteEvent}
              onClose={closeDraft}
              confirmBeforeDelete={model.settings.confirmBeforeDelete}
              onSettings={model.updateSettings}
              aiEnabled={Boolean(model.aiStatus?.enabled)}
              cognitiveWeight={
                draft.event ? model.aiWeights[String(draft.event.id)] : null
              }
              onOverrideWeight={model.setCognitiveOverride}
              onRescoreWeight={model.rescoreEvent}
              onActions={isMobile ? (id) => openEventActions(id, true) : undefined}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {dialog === "settings" && (
            <SettingsDialog
              key="settings"
              model={model}
              onClose={closeDialog}
              onImport={importData}
              onHelp={() => setDialog("help")}
              onThemeChange={changeTheme}
            />
          )}
          {dialog === "help" && <HelpDialog key="help" onClose={closeDialog} />}
          {dialog === "search" && (
            <SearchDialog
              key="search"
              events={model.events}
              actions={actions}
              aiEnabled={Boolean(model.aiStatus?.enabled)}
              settings={model.settings}
              initialCapture={searchSeed}
              onQuickCapture={model.quickCapture}
              onCommitDrafts={(drafts) => {
                setDialog(null);
                setSearchSeed(null);
                if (model.saveEventsBatch(drafts) && drafts[0]) {
                  navigate(localDate(drafts[0].start));
                  setFlash({ id: drafts[0].id, at: Date.now() });
                }
              }}
              onClose={closeDialog}
              onCreate={(title) => newEvent(title)}
              onChoose={(event) => {
                setDialog(null);
                setSearchSeed(null);
                navigate(localDate(event.start));
                editEvent(event.id);
                setFlash({ id: event.id, at: Date.now() });
              }}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {context && (
            <div
              key="context-scrim"
              className={`context-scrim${context.mobile ? " mobile-context-scrim" : ""}`}
              onClick={() => setContext(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContext(null);
              }}
            />
          )}
          {context && (
            <ContextMenu
              key="context-menu"
              context={context}
              event={contextEvent}
              dayEvents={contextDayEvents}
              canPaste={!!clipboard.current}
              onClose={() => setContext(null)}
              onEdit={() => { if (!context.fromEditor) editEvent(context.id); }}
              onToggle={() => model.toggleComplete(context.id)}
              onCopy={() => copyEvent(context.id)}
              onDuplicate={() => duplicateEvent(context.id)}
              onDelete={() => {
                if (context.mobile && model.settings.confirmBeforeDelete) {
                  editEvent(context.id, null, { confirmDelete: true });
                } else {
                  model.deleteEvent(context.id);
                  if (context.fromEditor) closeDraft();
                }
              }}
              onDeleteEvent={(id) => model.deleteEvent(id)}
              onDeleteDayEvents={(ids) => model.deleteEvent(ids)}
              onShowDate={() => showDay(localDate(context.date))}
              onCreateHere={() => createAt(context)}
              onPasteHere={() => pasteTo(context.date, context.minutes)}
            />
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
