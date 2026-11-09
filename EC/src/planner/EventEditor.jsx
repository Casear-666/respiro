import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  CornerDownLeft,
  Tag,
  TextAlignStart,
  Trash2,
  X,
} from "lucide-react";
import {
  CATEGORIES,
  DEFAULT_TITLE,
  addDays,
  dateKey,
  localDate,
  normalizeEvent,
} from "../../shared/domain";
import Dialog from "./Dialog";

const datetime = (value) => {
  const date = localDate(value);
  return `${dateKey(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
const DURATIONS = [
  [30, "30 分钟"],
  [60, "1 小时"],
  [90, "1.5 小时"],
  [120, "2 小时"],
];
const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || "");

export default function EventEditor({ draft, onSave, onDelete, onClose }) {
  const existing = draft.event;
  const initial =
    existing ||
    (() => {
      let start = localDate(draft.start || new Date()),
        end;
      if (draft.allDay)
        return {
          start: dateKey(start),
          end: dateKey(draft.end || addDays(start, 1)),
          allDay: true,
          tag: "work",
        };
      if (!draft.start) {
        start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
      }
      end = draft.end ? localDate(draft.end) : new Date(+start + 3600000);
      return { start, end, allDay: false, tag: "work" };
    })();
  const [title, setTitle] = useState(existing?.title || draft.title || ""),
    [description, setDescription] = useState(existing?.description || "");
  const [tag, setTag] = useState(initial.tag || "work"),
    [allDay, setAllDay] = useState(initial.allDay || false);
  const [start, setStart] = useState(
    initial.allDay
      ? dateKey(localDate(initial.start))
      : datetime(initial.start),
  );
  const [end, setEnd] = useState(
    initial.allDay ? dateKey(addDays(initial.end, -1)) : datetime(initial.end),
  );
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(!!draft.confirmDelete),
    [duplicate, setDuplicate] = useState(false);
  const editing = existing && !duplicate;
  const category = CATEGORIES.find((c) => c.id === tag) || CATEGORIES[4];
  const close = useCallback(() => onClose(), [onClose]);
  const duration = useMemo(() => {
    if (allDay) return 0;
    const ms = +localDate(end) - +localDate(start);
    return Number.isFinite(ms) ? ms / 60000 : 0;
  }, [allDay, start, end]);
  const changeAllDay = (value) => {
    setAllDay(value);
    setError("");
    if (value) {
      setStart(start.slice(0, 10));
      setEnd(end.slice(0, 10));
    } else {
      setStart(`${start.slice(0, 10)}T09:00`);
      setEnd(`${end.slice(0, 10)}T10:00`);
    }
  };
  const setDuration = (minutes) => {
    setAllDay(false);
    setError("");
    const s = localDate(start.length === 10 ? `${start}T09:00` : start);
    setStart(datetime(s));
    setEnd(datetime(new Date(+s + minutes * 60000)));
  };
  const submit = (e) => {
    e.preventDefault();
    try {
      const form = e.currentTarget.closest("form") || e.currentTarget;
      const fields = new FormData(form);
      const enteredStart = fields.get("start"),
        enteredEnd = fields.get("end");
      const event = normalizeEvent({
        ...(editing ? existing : {}),
        title,
        description,
        tag,
        allDay,
        start: allDay ? enteredStart : localDate(enteredStart),
        end: allDay ? dateKey(addDays(enteredEnd, 1)) : localDate(enteredEnd),
      });
      onSave(event);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Dialog
      label={editing ? "编辑日程" : "新建日程"}
      onClose={close}
      className="event-editor"
      anchor={draft.rect}
    >
      <form
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.currentTarget.requestSubmit();
          }
        }}
        style={{ "--category": category.color }}
      >
        <div className="editor-top">
          <i aria-hidden="true" />
          <span>
            {editing ? "编辑日程" : duplicate ? "复制为新日程" : "新建日程"}
          </span>
          <button
            type="button"
            className="icon-button sm"
            aria-label="关闭编辑"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="editor-body">
          <input
            className="event-title-input"
            aria-label="日程名称"
            placeholder="添加标题"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setError("");
            }}
            maxLength={200}
            autoFocus
            data-autofocus
          />

          <div className="editor-row">
            <Clock3 size={17} aria-hidden="true" />
            <div>
              <div className="editor-row-head">
                <span>时间</span>
                <label className="switch-label">
                  全天
                  <input
                    className="switch"
                    type="checkbox"
                    role="switch"
                    checked={allDay}
                    onChange={(e) => changeAllDay(e.target.checked)}
                  />
                </label>
              </div>
              <div className="date-fields">
                <label>
                  <span>开始</span>
                  <input
                    aria-label="开始时间"
                    name="start"
                    type={allDay ? "date" : "datetime-local"}
                    value={start}
                    onChange={(e) => {
                      setStart(e.target.value);
                      setError("");
                    }}
                    required
                  />
                </label>
                <ArrowRight size={14} aria-hidden="true" />
                <label>
                  <span>{allDay ? "结束（含当天）" : "结束"}</span>
                  <input
                    aria-label="结束时间"
                    name="end"
                    type={allDay ? "date" : "datetime-local"}
                    value={end}
                    onChange={(e) => {
                      setEnd(e.target.value);
                      setError("");
                    }}
                    required
                  />
                </label>
              </div>
              <div className="duration-options" aria-label="快速时长">
                {DURATIONS.map(([minutes, text]) => (
                  <button
                    type="button"
                    className="chip"
                    key={minutes}
                    aria-pressed={duration === minutes}
                    onClick={() => setDuration(minutes)}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="editor-row">
            <Tag size={17} aria-hidden="true" />
            <div className="category-choices" aria-label="日程分类">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="chip"
                  aria-pressed={tag === c.id}
                  style={{ "--category": c.color, "--category-soft": c.soft }}
                  onClick={() => setTag(c.id)}
                >
                  <i />
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="editor-row notes-area">
            <TextAlignStart size={17} aria-hidden="true" />
            <textarea
              aria-label="日程备注"
              placeholder="添加备注、地点或一点提醒…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={5000}
            />
          </div>

          <AnimatePresence initial={false}>
            {error && (
              <motion.p
                className="form-error"
                role="alert"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <CircleAlert size={15} aria-hidden="true" />
                {error}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <div className="editor-footer">
          <div className="editor-secondary">
            {editing ? (
              <>
                <button
                  type="button"
                  className="icon-button danger-button"
                  aria-label="删除日程"
                  title="删除日程"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={16} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="复制日程"
                  title="复制为新日程"
                  onClick={() => {
                    setDuplicate(true);
                    setConfirmDelete(false);
                    setTitle(
                      `${title.trim() || DEFAULT_TITLE}（副本）`.slice(0, 200),
                    );
                  }}
                >
                  <Copy size={16} />
                </button>
              </>
            ) : (
              <span className="subtle">
                <kbd>{isMac ? "⌘" : "Ctrl"}</kbd>
                <kbd>
                  <CornerDownLeft size={10} />
                </kbd>
                保存
              </span>
            )}
          </div>
          <div className="editor-primary">
            <button type="button" className="ghost-button" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="primary-button">
              <Check size={15} />
              {editing ? "保存更改" : "创建日程"}
            </button>
          </div>
        </div>
        <AnimatePresence initial={false}>
          {confirmDelete && editing && (
            <motion.div
              className="delete-confirm"
              role="alert"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              <div>
                <span>删除这项日程？之后仍可撤销。</span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setConfirmDelete(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary-button solid-danger"
                  onClick={() => {
                    onDelete(existing.id);
                    onClose();
                  }}
                >
                  删除
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </form>
    </Dialog>
  );
}
