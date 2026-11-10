import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Toaster, toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleQuestionMark,
  ClipboardCopy,
  ClipboardPaste,
  Clock3,
  Copy,
  CornerDownLeft,
  FolderOpen,
  Keyboard,
  Laptop,
  Leaf,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
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
import { isDesktop, isServer, repository } from "./repository";
import { useServerSession } from "./ServerGate";
const CalendarCanvas = lazy(() => import("./CalendarCanvas"));
import EventEditor from "./EventEditor";
import Dialog from "./Dialog";
import "./planner.css";

const weekNames = ["日", "一", "二", "三", "四", "五", "六"];
const viewNames = [
  { id: "dayGridMonth", label: "月", scope: "本月" },
  { id: "timeGridWeek", label: "周", scope: "本周" },
  { id: "timeGridDay", label: "日", scope: "当日" },
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
const shortDate = (value) => {
  const d = localDate(value);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekNames[d.getDay()]}`;
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
    return;
  }
  if (className) root.classList.add(className);
  try {
    const transition = document.startViewTransition({
      update: async () => {
        const wait = settle?.();
        update();
        if (wait) await wait;
      },
      types: [type],
    });
    transition.finished.finally(() => {
      if (className) root.classList.remove(className);
    });
  } catch {
    if (className) root.classList.remove(className);
    update();
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
function IconButton({ label, children, className = "", shortcut, ...props }) {
  return (
    <button
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
          onClick={() => onChange(option.value)}
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

function MiniCalendar({ anchor, selected, onDate, onEdit, firstDay, events }) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const offset = (first.getDay() - firstDay + 7) % 7;
  const start = addDays(first, -offset),
    today = dateKey(new Date());
  const monthKey = `${anchor.getFullYear()}-${anchor.getMonth()}`;
  const days = useMemo(
    () => Array.from({ length: 42 }, (_, i) => addDays(start, i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [monthKey, firstDay],
  );
  const loads = useMemo(
    () => rangeLoads(events, days[0], days.length),
    [days, events],
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
    dwell.close();
  }, [monthKey]);
  const resolve = useCallback(
    (key) => ({
      date: localDate(key),
      events: dayLists.get(key) ?? [],
      load: loads.get(key) ?? dayLoad(events, key),
      levels,
      today: key === today,
    }),
    [dayLists, loads, levels, today, events],
  );
  return (
    <div className="mini-calendar">
      <div className="mini-month">
        <span>
          {anchor.getFullYear()} 年 {anchor.getMonth() + 1} 月
        </span>
        <div>
          <IconButton
            className="sm"
            label="上一月（小日历）"
            onClick={() =>
              onDate(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))
            }
          >
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton
            className="sm"
            label="下一月（小日历）"
            onClick={() =>
              onDate(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))
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
            count = counts.get(key) || 0;
          return (
            <button
              type="button"
              key={key}
              onClick={() => {
                onDate(day);
                dwell.close();
              }}
              onPointerEnter={(e) => {
                if (e.pointerType === "touch" || e.buttons) return;
                dwell.enter(key, e.currentTarget);
              }}
              onPointerLeave={() => dwell.leave()}
              onFocus={(e) => {
                if (keyboardModality.current)
                  dwell.enter(key, e.currentTarget, "keyboard");
              }}
              onBlur={() => dwell.leave()}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && dwell.open?.key === key) {
                  e.preventDefault();
                  dwell.cardRef.current
                    ?.querySelector(".day-preview-item")
                    ?.focus();
                }
              }}
              title={count ? `${key} · ${count} 项安排` : key}
              aria-label={`跳转到 ${key}${count ? `，${count} 项安排` : ""}`}
              aria-current={key === today ? "date" : undefined}
              style={count ? { "--dot": energyForCount(count).ink } : undefined}
              className={`${day.getMonth() !== anchor.getMonth() ? "outside" : ""} ${key === dateKey(selected) ? "selected" : ""} ${key === today ? "today" : ""} ${liftKey === key ? "is-dwell" : ""}`}
            >
              {day.getDate()}
              {count > 0 && <i className="mini-dot" />}
            </button>
          );
        })}
      </motion.div>
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
        emptyHint="点击查看这一天"
      />
    </div>
  );
}

function TodayPanel({
  selected,
  events,
  allEvents,
  onClose,
  onEdit,
  onComplete,
  onCreate,
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
    () => dayLoad(allEvents || events, selected),
    [allEvents, events, selected],
  );
  const heat = energyForCount(load.count);
  const today = dateKey(selected) === dateKey(new Date());
  const filled = Math.round(
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
          <span>{today ? "今天，慢慢来。" : "给这一天，留点期待。"}</span>
        </div>
      </div>
      <div
        className={`energy-card energy-card-${load.level}`}
        style={{ "--workload-ink": heat.ink }}
      >
        <div className="energy-card-heading">
          <Leaf size={15} />
          <span>{load.count ? heat.label : "留白时光"}</span>
          <span className="energy-hours">
            {load.count}
            <small>项</small>
          </span>
        </div>
        <div className="energy-meter" aria-hidden="true">
          {Array.from({ length: 16 }, (_, i) => (
            <i
              className={i < filled ? "filled" : ""}
              key={i}
              style={{ "--i": i }}
            />
          ))}
        </div>
        <p>
          {load.peak > 1
            ? `有 ${load.peak} 项日程时间重叠，可以试着挪一挪。`
            : load.count > 0
              ? `共 ${load.count} 项安排${load.minutes ? ` · 定时占用 ${Number((load.minutes / 60).toFixed(1))} 小时` : " · 全天日程也计入繁忙程度"}`
              : "还没有安排，把时间留给自己。"}
        </p>
      </div>
      <div className="agenda-heading">
        <h3>
          当日安排 <span>{daily.length}</span>
        </h3>
        <IconButton
          className="sm"
          label="为这一天添加日程"
          onClick={() => onCreate(selected)}
        >
          <Plus size={16} />
        </IconButton>
      </div>
      <div className="agenda-list">
        <AnimatePresence initial={false} mode="popLayout">
          {daily.length ? (
            daily.map((event) => {
              const category = categoryOf(event);
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
                    </span>
                  </button>
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
              <svg viewBox="0 0 120 90" aria-hidden="true">
                <path d="M20 64h80M30 72h60M40 80h40" />
                <path d="M37 59a23 23 0 0 1 46 0" />
                <path d="M60 12v8M27 26l6 6M93 26l-6 6M15 52h8M97 52h8" />
              </svg>
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
      <div className="panel-note">
        <BrandMark size={16} />
        <p>不必填满每一个空格，好的计划也容得下变化。</p>
      </div>
    </aside>
  );
}

function SettingsDialog({ model, onClose, onImport, onHelp }) {
  const [info, setInfo] = useState(null),
    [logoutError, setLogoutError] = useState("");
  const serverSession = useServerSession();
  useEffect(() => {
    repository
      .info()
      .then(setInfo)
      .catch(() => {});
  }, []);
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
            onChange={(theme) => model.updateSettings({ theme })}
            options={[
              { value: "light", label: "暖白", icon: <Sun size={14} /> },
              { value: "dark", label: "墨夜", icon: <Moon size={14} /> },
              { value: "system", label: "系统", icon: <Laptop size={14} /> },
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
        <h3>数据与备份</h3>
        <p className="settings-description">
          {isDesktop
            ? "日程使用 SQLite 保存在本机，每天启动时自动备份，保留最近 14 份。"
            : isServer
              ? "日程保存在服务器，同一账号可在不同设备访问。导入前会保留备份。"
              : "当前为网页预览，数据保存在此浏览器。桌面版使用独立的本地数据库。"}
        </p>
        {isServer && (
          <p className="settings-description">
            在其他设备修改后，刷新页面查看最新日程。
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
          {isDesktop && (
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
                  await serverSession.logout();
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
      <div className="settings-bottom">
        <span>
          精力日历 {info?.version || "2.0.1"}
          <small>让时间，留有余地。</small>
        </span>
        <button type="button" className="text-button" onClick={onHelp}>
          <Keyboard size={14} /> 快捷键
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
      ["月 / 周 / 日视图", "1 2 3"],
      ["搜索与命令", `${MOD} K`],
      ["搜索与命令", "/"],
    ],
  },
  {
    group: "界面",
    items: [
      ["收起 / 展开侧栏", "["],
      ["当日安排面板", "]"],
      ["关闭浮层 / 取消拖动", "Esc"],
      ["打开帮助", "?"],
    ],
  },
];

function HelpDialog({ onClose }) {
  return (
    <Dialog label="操作与快捷键" onClose={onClose} className="help-dialog">
      <div className="dialog-top">
        <div>
          <span className="eyebrow">操作指南</span>
          <h2>顺手，就好</h2>
          <p>
            点空白处创建。月视图中在日期上稍作停留即可预览当日安排，把预览里的日程拖到其他日期即可改期；周、日视图中直接拖动日程改期，拖动边缘调整时长。右击日程可编辑、复制或删除；右击空白日期可新建或粘贴。搜索框输入新名称可直接创建。
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

function Highlight({ text, query }) {
  if (!query) return text;
  const index = text.toLocaleLowerCase().indexOf(query);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

function SearchDialog({ events, actions, onClose, onChoose, onCreate }) {
  const [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const listRef = useRef(null);
  const q = query.trim().toLocaleLowerCase();
  const groups = useMemo(() => {
    const byStart = (a, b) => +localDate(a.start) - +localDate(b.start);
    const matchedEvents = q
      ? events
          .filter((e) =>
            `${e.title} ${e.description}`.toLocaleLowerCase().includes(q),
          )
          .sort(byStart)
          .slice(0, 30)
      : events
          .filter((e) => !e.completed && +localDate(e.end) >= Date.now())
          .sort(byStart)
          .slice(0, 6);
    const matchedActions = [
      ...(q
        ? [
            {
              id: "create-event",
              label: `新建日程「${query.trim()}」`,
              keywords: "",
              icon: <Plus size={15} />,
              run: () => onCreate(query.trim()),
            },
          ]
        : []),
      ...actions.filter(
        (a) =>
          !q ||
          `${a.label} ${a.keywords || ""}`.toLocaleLowerCase().includes(q),
      ),
    ];
    const eventGroup = matchedEvents.length && {
      label: q ? "日程" : "即将到来",
      items: matchedEvents.map((event) => ({ kind: "event", event })),
    };
    const actionGroup = matchedActions.length && {
      label: q ? "操作" : "快捷操作",
      items: matchedActions.map((action) => ({ kind: "action", action })),
    };
    return (q ? [eventGroup, actionGroup] : [actionGroup, eventGroup]).filter(
      Boolean,
    );
  }, [events, actions, q, query, onCreate]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const run = (item) => {
    if (!item) return;
    if (item.kind === "event") onChoose(item.event);
    else {
      onClose();
      item.action.run();
    }
  };
  let index = -1;
  return (
    <Dialog label="搜索日程" onClose={onClose} className="search-dialog">
      <div className="search-dialog-input">
        <Search size={19} />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={flat.length ? `palette-${active}` : undefined}
          aria-label="搜索日程"
          placeholder="搜索日程，或输入一个操作…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!flat.length) return;
              const delta = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (i + delta + flat.length) % flat.length);
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              run(flat[active]);
            }
          }}
        />
        <button
          type="button"
          className="icon-button sm"
          aria-label="关闭搜索"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div
        className="search-results"
        id="palette-list"
        role="listbox"
        ref={listRef}
      >
        {groups.map((group) => (
          <div key={group.label} role="group" aria-label={group.label}>
            <div className="palette-group-label">{group.label}</div>
            {group.items.map((item) => {
              index += 1;
              const i = index;
              const selected = i === active;
              if (item.kind === "event") {
                const e = item.event;
                return (
                  <button
                    type="button"
                    tabIndex={-1}
                    role="option"
                    id={`palette-${i}`}
                    data-index={i}
                    aria-selected={selected}
                    className="palette-item"
                    key={`e-${e.id}`}
                    onMouseMove={() => !selected && setActive(i)}
                    onClick={() => run(item)}
                  >
                    <span
                      className="search-result-dot"
                      style={{ background: categoryOf(e).color }}
                    />
                    <span className="palette-text">
                      <strong>
                        <Highlight text={e.title} query={q} />
                      </strong>
                      <small>
                        {shortDate(e.start)} ·{" "}
                        {e.allDay ? "全天" : formatTime(e.start)}
                        {e.completed ? " · 已完成" : ""}
                      </small>
                    </span>
                    <CornerDownLeft size={14} className="palette-enter" />
                  </button>
                );
              }
              const a = item.action;
              return (
                <button
                  type="button"
                  tabIndex={-1}
                  role="option"
                  id={`palette-${i}`}
                  data-index={i}
                  aria-selected={selected}
                  className="palette-item"
                  key={`a-${a.id}`}
                  onMouseMove={() => !selected && setActive(i)}
                  onClick={() => run(item)}
                >
                  <span className="palette-icon">{a.icon}</span>
                  <span className="palette-text">
                    <strong>
                      <Highlight text={a.label} query={q} />
                    </strong>
                  </span>
                  {a.shortcut && <Keys value={a.shortcut} />}
                </button>
              );
            })}
          </div>
        ))}
        {!flat.length && (
          <p className="search-empty">
            {q ? "没有找到，试试另一个关键词。" : "输入日程名称或备注，快速回到那一天。"}
          </p>
        )}
      </div>
      <div className="palette-footer" aria-hidden="true">
        <span>
          <Keys value="↑ ↓" /> 选择
        </span>
        <span>
          <kbd>
            <CornerDownLeft size={10} />
          </kbd>
          打开
        </span>
        <span>
          <kbd>Esc</kbd> 关闭
        </span>
      </div>
    </Dialog>
  );
}

function ContextMenu({
  context,
  event,
  canPaste,
  onClose,
  onEdit,
  onToggle,
  onCopy,
  onDuplicate,
  onDelete,
  onCreateHere,
  onPasteHere,
}) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const left = Math.min(context.x, window.innerWidth - node.offsetWidth - 8);
    const top = Math.min(context.y, window.innerHeight - node.offsetHeight - 8);
    node.style.left = `${Math.max(8, left)}px`;
    node.style.top = `${Math.max(8, top)}px`;
    node.style.transformOrigin = `${context.x - left}px ${context.y - top}px`;
    node.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [context]);
  const onKeyDown = (e) => {
    const items = [
      ...ref.current.querySelectorAll("button:not(:disabled)"),
    ];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
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
      className="context-menu"
      role="menu"
      aria-label={
        event ? `${event.title} 的操作` : `${context.date || "这一天"} 的操作`
      }
      onKeyDown={onKeyDown}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
      transition={{ type: "spring", stiffness: 600, damping: 38 }}
    >
      {event ? (
        <>
          <button type="button" role="menuitem" onClick={act(onEdit)}>
            <SquarePen size={15} /> 编辑日程
          </button>
          <button type="button" role="menuitem" onClick={act(onToggle)}>
            <CircleCheck size={15} />
            {event.completed ? "标记为未完成" : "标记为已完成"}
          </button>
          <button type="button" role="menuitem" onClick={act(onCopy)}>
            <ClipboardCopy size={15} /> 复制
            <kbd>{MOD} C</kbd>
          </button>
          <button type="button" role="menuitem" onClick={act(onDuplicate)}>
            <Copy size={15} /> 创建副本
            <kbd>{MOD} D</kbd>
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
        </>
      ) : (
        <>
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
            <kbd>{MOD} V</kbd>
          </button>
        </>
      )}
    </motion.div>
  );
}

export default function PlannerApp() {
  const model = usePlanner(),
    calendarRef = useRef(null),
    fileRef = useRef(null);
  const [view, setView] = useState("dayGridMonth"),
    [selectedDay, setSelectedDay] = useState(new Date()),
    [anchor, setAnchor] = useState(new Date());
  const [range, setRange] = useState(null),
    [draft, setDraft] = useState(null),
    [dialog, setDialog] = useState(null),
    [panel, setPanel] = useState(() => window.innerWidth > 1150);
  const [sidebar, setSidebar] = useState(false),
    [collapsed, setCollapsed] = useState(() => !!readUi().sidebarCollapsed),
    [categories, setCategories] = useState(CATEGORIES.map((c) => c.id)),
    [context, setContext] = useState(null),
    [flash, setFlash] = useState(null),
    [resolvedTheme, setResolvedTheme] = useState("light");
  const narrow = useMediaQuery("(max-width: 900px)"),
    overlayPanel = useMediaQuery("(max-width: 1150px)");
  const rangeWaiter = useRef(null),
    currentRange = useRef(null),
    clipboard = useRef(null),
    lastEvent = useRef(null),
    selectedRef = useRef(selectedDay),
    viewRef = useRef(view);
  selectedRef.current = selectedDay;
  viewRef.current = view;
  const api = () => calendarRef.current?.getApi();
  const closeDraft = useCallback(() => setDraft(null), []),
    closeDialog = useCallback(() => setDialog(null), []);
  const refit = useCallback(() => {
    // FullCalendar measures on window resize; container-only changes need a nudge.
    requestAnimationFrame(() => calendarRef.current?.getApi().updateSize());
  }, []);

  useEffect(() => {
    if (!model.loading) setView(model.settings.defaultView);
  }, [model.loading]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const theme =
        model.settings.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : model.settings.theme;
      document.documentElement.setAttribute("data-planner-theme", theme);
      setResolvedTheme(theme);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [model.settings.theme]);

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
      setSidebar(false);
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
    (next) => {
      if (next === viewRef.current) return;
      const calendar = api();
      transitionNav("zoom", () => {
        setView(next);
        calendar?.changeView(next, selectedRef.current);
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
  const toggleSidebar = useCallback(() => {
    if (narrow) {
      setSidebar((open) => !open);
      return;
    }
    setCollapsed((value) => {
      writeUi({ sidebarCollapsed: !value });
      return !value;
    });
    setTimeout(refit, 360);
  }, [narrow, refit]);
  const togglePanel = useCallback(() => setPanel((p) => !p), []);
  const toggleTheme = useCallback(
    (e) => {
      const next = resolvedTheme === "dark" ? "light" : "dark";
      const root = document.documentElement;
      const rect = e?.currentTarget?.getBoundingClientRect?.();
      if (rect) {
        const x = rect.left + rect.width / 2,
          y = rect.top + rect.height / 2;
        root.style.setProperty("--vt-x", `${x}px`);
        root.style.setProperty("--vt-y", `${y}px`);
        root.style.setProperty(
          "--vt-r",
          `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`,
        );
      }
      runViewTransition(
        "theme",
        () => {
          root.setAttribute("data-planner-theme", next);
          setResolvedTheme(next);
        },
        { className: "theme-switching" },
      );
      model.updateSettings({ theme: next });
    },
    [resolvedTheme, model.updateSettings],
  );
  const createForDay = useCallback((date) => {
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
        description: `${MOD} V 粘贴到所选日期`,
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
    if (isDesktop) model.importBackup();
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
          toggleSidebar();
        } else if (k === "]") {
          e.preventDefault();
          togglePanel();
        } else if (k === "/") {
          e.preventDefault();
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
    toggleSidebar,
    togglePanel,
    copyEvent,
    duplicateEvent,
    pasteTo,
  ]);

  const actions = useMemo(
    () => [
      { id: "new", label: "新建日程", keywords: "create add new", icon: <Plus size={15} />, shortcut: "N", run: newEvent },
      { id: "today", label: "回到今天", keywords: "today", icon: <CalendarCheck size={15} />, shortcut: "T", run: today },
      { id: "month", label: "切换到月视图", keywords: "month", icon: <CalendarDays size={15} />, shortcut: "1", run: () => changeView("dayGridMonth") },
      { id: "week", label: "切换到周视图", keywords: "week", icon: <CalendarRange size={15} />, shortcut: "2", run: () => changeView("timeGridWeek") },
      { id: "day", label: "切换到日视图", keywords: "day", icon: <Clock3 size={15} />, shortcut: "3", run: () => changeView("timeGridDay") },
      { id: "theme", label: resolvedTheme === "dark" ? "切换到暖白主题" : "切换到墨夜主题", keywords: "theme dark light 主题", icon: <SunMoon size={15} />, run: () => toggleTheme() },
      { id: "panel", label: panel ? "隐藏当日安排" : "显示当日安排", keywords: "panel agenda", icon: <PanelRight size={15} />, shortcut: "]", run: togglePanel },
      { id: "settings", label: "偏好与数据", keywords: "settings backup import export 设置 备份 导入 导出", icon: <Settings2 size={15} />, run: () => setDialog("settings") },
      { id: "help", label: "操作与快捷键", keywords: "help shortcuts 帮助", icon: <Keyboard size={15} />, shortcut: "?", run: () => setDialog("help") },
    ],
    [newEvent, today, changeView, toggleTheme, togglePanel, resolvedTheme, panel],
  );

  const chooseCategory = (id) =>
    setCategories((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  const viewMeta = viewNames.find((v) => v.id === view) || viewNames[0];
  const contextEvent = context?.id
    ? model.events.find((e) => e.id === context.id)
    : null;
  const sidebarHidden = !narrow && collapsed;

  const panelNode = panel && (
    <TodayPanel
      selected={selectedDay}
      events={filtered}
      allEvents={model.events}
      onClose={() => setPanel(false)}
      onEdit={editEvent}
      onComplete={model.toggleComplete}
      onCreate={createForDay}
      onDayView={() => {
        if (overlayPanel) setPanel(false);
        changeView("timeGridDay");
        navigate(selectedDay);
      }}
    />
  );

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={`planner-shell ${sidebar ? "sidebar-open" : ""}`}
        data-sidebar={sidebarHidden ? "collapsed" : "open"}
      >
        <Toaster
          position="bottom-right"
          theme={resolvedTheme}
          offset={24}
          gap={10}
          toastOptions={{ duration: 3200 }}
        />
        {sidebar && narrow && (
          <button
            className="sidebar-backdrop"
            aria-label="收起导航"
            onClick={() => setSidebar(false)}
          />
        )}
        <aside
          className="planner-sidebar"
          aria-label="导航"
          inert={sidebarHidden || (narrow && !sidebar) ? true : undefined}
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && e.propertyName === "margin-left")
              refit();
          }}
        >
          <div className="sidebar-inner">
            <div className="sidebar-head">
              <a
                className="brand"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  today();
                }}
              >
                <span className="brand-symbol">
                  <BrandMark size={20} />
                </span>
                <span>
                  <strong>精力日历</strong>
                  <small>ENERGY CALENDAR</small>
                </span>
              </a>
              <IconButton
                className="sidebar-collapse sm"
                label="收起侧栏"
                shortcut="["
                onClick={toggleSidebar}
              >
                <PanelLeftClose size={16} />
              </IconButton>
            </div>
            <button
              type="button"
              className="sidebar-create"
              disabled={model.loading || !!model.loadError}
              onClick={() => newEvent()}
            >
              <Plus size={17} />
              <span>新建日程</span>
              <kbd>N</kbd>
            </button>
            <nav className="sidebar-nav" aria-label="视图">
              <button
                type="button"
                className={view !== "timeGridDay" ? "active" : ""}
                onClick={() => {
                  changeView("dayGridMonth");
                  setSidebar(false);
                }}
              >
                <CalendarDays size={17} />
                <span>我的日历</span>
                <span className="nav-count">{model.events.length}</span>
              </button>
              <button
                type="button"
                className={view === "timeGridDay" ? "active" : ""}
                onClick={() => {
                  setPanel(true);
                  changeView("timeGridDay");
                  today();
                }}
              >
                <Sun size={17} />
                <span>专注今天</span>
                <ArrowUpRight size={14} />
              </button>
            </nav>
            <div className="sidebar-divider" />
            <MiniCalendar
              anchor={anchor}
              selected={selectedDay}
              onDate={navigate}
              onEdit={editEvent}
              firstDay={model.settings.weekStart}
              events={model.events}
            />
            <div className="sidebar-divider" />
            <div className="category-section">
              <div className="sidebar-section-heading">
                <span>日程分类</span>
                {categories.length < CATEGORIES.length && (
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
            <div className="sidebar-spacer" />
            <div className="sidebar-footer">
              <button
                type="button"
                className="storage-card"
                onClick={() => setDialog("settings")}
              >
                <span className="local-avatar">
                  <Leaf size={17} />
                </span>
                <span>
                  <strong>{isServer ? "我的云端日历" : "我的本地空间"}</strong>
                  <small>
                    {isServer
                      ? "已连接服务器"
                      : isDesktop
                        ? "离线可用 · 只属于你"
                        : "网页预览 · 本机保存"}
                  </small>
                </span>
                <Settings2 size={16} />
              </button>
            </div>
          </div>
        </aside>
        <main className="planner-main">
          <header className="topbar">
            <div className="topbar-left">
              {(narrow || collapsed) && (
                <IconButton
                  label={narrow ? "展开导航" : "展开侧栏"}
                  shortcut={narrow ? undefined : "["}
                  onClick={toggleSidebar}
                >
                  {narrow ? <Menu size={19} /> : <PanelLeftOpen size={18} />}
                </IconButton>
              )}
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
              <div className="topbar-title">
                <h1 aria-live="polite">
                  {view === "dayGridMonth" || !range ? (
                    <>
                      {anchor.getMonth() + 1} 月
                      <span className="title-year">{anchor.getFullYear()}</span>
                    </>
                  ) : (
                    range.title
                  )}
                </h1>
                <span className="title-meta">
                  {viewMeta.scope} {scopeCount} 项安排
                </span>
              </div>
            </div>
            <div className="topbar-right">
              <div className="segmented" aria-label="日历视图" role="group">
                {viewNames.map((v) => (
                  <button
                    type="button"
                    key={v.id}
                    aria-pressed={view === v.id}
                    title={`${v.label}视图（${viewNames.indexOf(v) + 1}）`}
                    onClick={() => changeView(v.id)}
                  >
                    {view === v.id && (
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
              <span className="topbar-divider" />
              <button
                type="button"
                className="search-trigger"
                aria-label="搜索日程"
                onClick={() => setDialog("search")}
              >
                <Search size={15} />
                <span>搜索或执行操作</span>
                <Keys value={`${MOD} K`} />
              </button>
              <IconButton
                label="切换明暗主题"
                onClick={toggleTheme}
              >
                {resolvedTheme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
              </IconButton>
              <IconButton
                label="操作与快捷键"
                shortcut="?"
                onClick={() => setDialog("help")}
              >
                <CircleQuestionMark size={17} />
              </IconButton>
              <IconButton
                label={panel ? "隐藏当日安排" : "显示当日安排"}
                shortcut="]"
                className={panel ? "is-active" : ""}
                aria-pressed={panel}
                onClick={togglePanel}
              >
                <PanelRight size={17} />
              </IconButton>
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
                      onMove={model.moveEvent}
                      onRange={onRange}
                      onContext={openContext}
                    />
                  </Suspense>
                  <AnimatePresence>
                    {model.events.length === 0 && (
                      <motion.div
                        className="onboarding-card"
                        initial={{ opacity: 0, y: 16, scale: 0.98 }}
                        animate={{
                          opacity: 1,
                          y: 0,
                          scale: 1,
                          transition: { delay: 0.25, type: "spring", stiffness: 380, damping: 32 },
                        }}
                        exit={{ opacity: 0, y: 10, transition: { duration: 0.16 } }}
                      >
                        <span className="onboarding-mark">
                          <BrandMark size={24} />
                        </span>
                        <div>
                          <strong>从一小段时间开始</strong>
                          <p>点击空白处写下安排，拖动它，就能轻松改期。</p>
                        </div>
                        <div className="onboarding-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={importData}
                          >
                            <ArrowUpFromLine size={14} /> 导入旧日程
                          </button>
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => model.setDemoMode(true)}
                          >
                            <Sparkles size={14} /> 体验示例
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
              <footer className="calendar-footer">
                <div className={`save-indicator ${model.status}`} role="status">
                  <i />
                  {model.demo ? (
                    "示例空间 · 更改不会保存"
                  ) : model.status === "error" ? (
                    <button type="button" onClick={model.retry}>
                      尚未保存 · 重试保存
                    </button>
                  ) : model.status === "saving" ? (
                    "正在保存…"
                  ) : isDesktop ? (
                    "所有更改已保存在本机"
                  ) : isServer ? (
                    "所有更改已保存到服务器"
                  ) : (
                    "已保存在此浏览器"
                  )}
                </div>
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
              </footer>
            </div>
            <AnimatePresence>
              {panel && overlayPanel && (
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
              {panel &&
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
          {draft && (
            <EventEditor
              key={draft.event?.id || "new"}
              draft={draft}
              onSave={model.saveEvent}
              onDelete={model.deleteEvent}
              onClose={closeDraft}
              confirmBeforeDelete={model.settings.confirmBeforeDelete}
              onSettings={model.updateSettings}
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
            />
          )}
          {dialog === "help" && <HelpDialog key="help" onClose={closeDialog} />}
          {dialog === "search" && (
            <SearchDialog
              key="search"
              events={model.events}
              actions={actions}
              onClose={closeDialog}
              onCreate={(title) => newEvent(title)}
              onChoose={(event) => {
                setDialog(null);
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
              className="context-scrim"
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
              canPaste={!!clipboard.current}
              onClose={() => setContext(null)}
              onEdit={() => editEvent(context.id)}
              onToggle={() => model.toggleComplete(context.id)}
              onCopy={() => copyEvent(context.id)}
              onDuplicate={() => duplicateEvent(context.id)}
              onDelete={() => model.deleteEvent(context.id)}
              onCreateHere={() => createAt(context)}
              onPasteHere={() => pasteTo(context.date, context.minutes)}
            />
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
