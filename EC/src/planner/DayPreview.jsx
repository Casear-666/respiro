import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  animate,
  motion,
  useReducedMotion,
  useSpring,
} from "framer-motion";
import { GripVertical } from "lucide-react";
import { categoryOf, eventCognitiveInfo, formatTime } from "../../shared/domain";
import { energyForCount } from "../../shared/energy";

export const DWELL = {
  lift: 120,
  open: 400,
  warm: 160,
  warmWindow: 300,
  grace: 150,
};
export const PREVIEW_MOTION = {
  enter: { duration: 0.12, ease: "easeOut" },
  exit: { duration: 0.14, ease: [0.4, 0, 1, 1] },
  gap: 8,
  edge: 12,
};
export const DRAG = {
  threshold: 6,
  follow: { stiffness: 700, damping: 45 },
  drop: 0.16,
  back: { type: "spring", stiffness: 500, damping: 38 },
};

const modality = { current: false };
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab" || e.key.startsWith("Arrow")) modality.current = true;
  });
  document.addEventListener("pointerdown", () => {
    modality.current = false;
  });
}
export function useKeyboardModality() {
  return modality;
}

export function useDwell({ onLift }) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(null);
  const timers = useRef({}),
    current = useRef(null),
    lastClosedAt = useRef(0),
    liftedKey = useRef(null),
    cardRef = useRef(null),
    openRef = useRef(null);
  openRef.current = open;
  const lift = (key) => {
    if (liftedKey.current === key) return;
    liftedKey.current = key;
    onLift?.(key);
  };
  const clear = (...names) =>
    names.forEach((name) => clearTimeout(timers.current[name]));
  const close = (options = {}) => {
    clear("lift", "open", "grace");
    const was = openRef.current;
    if (was) lastClosedAt.current = Date.now();
    current.current = null;
    lift(null);
    setOpen(null);
    if (options.restoreFocus && was?.via === "keyboard")
      (was.el.querySelector("button") ?? was.el).focus?.();
  };
  const enter = (key, el, via = "pointer") => {
    if (current.current?.key === key) {
      clear("grace");
      return;
    }
    clear("lift", "open", "grace");
    current.current = { key, el, via };
    if (reduced) {
      lift(key);
      setOpen({ key, el, via });
      return;
    }
    const warm =
      openRef.current ||
      Date.now() - lastClosedAt.current < DWELL.warmWindow;
    timers.current.lift = setTimeout(
      () => lift(key),
      warm ? 0 : DWELL.lift,
    );
    timers.current.open = setTimeout(
      () => setOpen({ key, el, via }),
      warm ? DWELL.warm : DWELL.open,
    );
  };
  const release = () => {
    clear("grace");
    if (openRef.current)
      timers.current.grace = setTimeout(() => close(), DWELL.grace);
  };
  const leave = () => {
    clear("lift", "open");
    current.current = null;
    release();
    if (!openRef.current) lift(null);
  };
  const hold = () => clear("grace");
  useEffect(() => {
    if (!open) return;
    const down = (e) => {
      if (!cardRef.current?.contains(e.target)) close();
    };
    const scroll = (e) => {
      if (!cardRef.current?.contains(e.target)) close();
    };
    const end = () => close();
    const key = (e) => {
      if (e.key === "Escape") close({ restoreFocus: true });
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", end);
    window.addEventListener("blur", end);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", end);
      window.removeEventListener("blur", end);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(
    () => () => {
      clear("lift", "open", "grace");
      lift(null);
    },
    [],
  );
  return { open, enter, leave, hold, release, close, cardRef };
}

const weekNames = ["日", "一", "二", "三", "四", "五", "六"];

export function DayPreview({
  open,
  cardRef,
  onHold,
  onRelease,
  onClose,
  placement = "top",
  resolve,
  onEdit,
  onDelete,
  onRowPointerDown,
  hidden,
  emptyHint,
}) {
  const reduced = useReducedMotion();
  const positioner = useRef(null);
  const data = open ? resolve(open.key) : null;
  const rows = data?.events ?? [];
  useLayoutEffect(() => {
    const layer = positioner.current;
    if (!open || hidden || !layer) return;
    const r = open.el.getBoundingClientRect();
    const { width: w, height: h } = layer.getBoundingClientRect();
    const vw = window.innerWidth,
      vh = window.innerHeight,
      { edge, gap } = PREVIEW_MOTION;
    let px, py;
    if (placement === "right") {
      px = r.right + gap;
      if (px + w > vw - edge && r.left - gap - w >= edge) {
        px = r.left - w - gap;
      }
      px = Math.max(edge, Math.min(px, vw - w - edge));
      py = Math.max(edge, Math.min(r.top - 12, vh - h - edge));
    } else {
      py = r.top - h - gap;
      if (py < edge) {
        py = r.bottom + gap;
      }
      py = Math.max(edge, Math.min(py, vh - h - edge));
      px = Math.max(
        edge,
        Math.min(r.left + r.width / 2 - w / 2, vw - w - edge),
      );
    }
    // Commit the measured position before the browser can paint the new date.
    layer.style.left = `${px}px`;
    layer.style.top = `${py}px`;
    layer.style.visibility = "visible";
  }, [open, placement, hidden, rows.length]);
  const load = data?.load ?? { count: 0, minutes: 0 },
    isCognitive = data?.energyMode === "cognitive",
    heatCount = isCognitive ? (load.effectiveCount ?? load.count) : load.count,
    heat = energyForCount(heatCount),
    date = data?.date ?? new Date();
  const draggable = Boolean(onRowPointerDown);
  return createPortal(
    <AnimatePresence>
      {open && data && !hidden && (
        <div
          className="day-preview"
          ref={positioner}
          key="preview"
        >
          <motion.div
            ref={cardRef}
            className={`day-preview-card${rows.length ? "" : " is-empty"}`}
            role="dialog"
            aria-label={`${date.getMonth() + 1}月${date.getDate()}日 · 周${weekNames[date.getDay()]} 的安排`}
            data-date={open.key}
            style={{ "--preview-ink": heat.ink }}
            initial={reduced ? false : { opacity: 0 }}
            animate={{
              opacity: 1,
              transition: reduced ? { duration: 0 } : PREVIEW_MOTION.enter,
            }}
            exit={{
              opacity: 0,
              transition: reduced ? { duration: 0 } : PREVIEW_MOTION.exit,
            }}
            onPointerEnter={() => !hidden && onHold()}
            onPointerLeave={() => !hidden && onRelease()}
            onBlur={(e) => {
              const next = e.relatedTarget;
              if (
                next &&
                (cardRef.current?.contains(next) || open.el.contains(next))
              )
                return;
              onClose();
            }}
            onKeyDown={(e) => {
              const items = [
                ...cardRef.current.querySelectorAll(".day-preview-item"),
              ];
              const index = items.indexOf(document.activeElement);
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                items[
                  e.key === "ArrowDown"
                    ? Math.min(index + 1, items.length - 1)
                    : Math.max(index - 1, 0)
                ]?.focus();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose({ restoreFocus: true });
              }
            }}
          >
            <div className="day-preview-head">
              <strong>
                {date.getMonth() + 1}月{date.getDate()}日 · 周
                {weekNames[date.getDay()]}
              </strong>
              {data.today && <i>今天</i>}
            </div>
            <p className="day-preview-summary">
              {rows.length && !load.count ? (
                "全部已完成"
              ) : rows.length ? (
                <>
                  {load.count} 项安排 · <b>{heat.label}</b>
                  {load.minutes
                    ? ` · 约 ${Number((load.minutes / 60).toFixed(1))} 小时`
                    : ""}
                  {isCognitive && load.cognitiveSummary && (
                    <span className="day-preview-cog-summary">
                      {load.cognitiveSummary}
                    </span>
                  )}
                </>
              ) : (
                "留白时光"
              )}
            </p>
            {rows.length > 0 && (
              <ul key={open.key} className="day-preview-list">
                {rows.map((event, index) => {
                  const level = data.levels.get(event.id) || 1;
                  const cog = isCognitive
                    ? eventCognitiveInfo(event, data?.weightsMap)
                    : null;
                  return (
                    <li key={event.id} style={{ "--row-delay": `${Math.min(index, 5) * 35}ms` }}>
                      <button
                        type="button"
                        className={`day-preview-item${event.completed ? " is-complete" : ""}${draggable ? " is-draggable" : ""}`}
                        data-event-id={event.id}
                        style={{ "--dot": categoryOf(event).color }}
                        onPointerDown={
                          draggable
                            ? (e) => onRowPointerDown(event, e)
                            : undefined
                        }
                        onClick={(e) =>
                          onEdit(
                            event,
                            e.currentTarget.getBoundingClientRect(),
                          )
                        }
                        onContextMenu={(e) => {
                          if (!onDelete) return;
                          e.preventDefault();
                          e.stopPropagation();
                          onDelete(event.id);
                        }}
                      >
                        {draggable && (
                          <GripVertical
                            size={12}
                            className="day-preview-grip"
                          />
                        )}
                        <span className="day-preview-time">
                          {event.allDay
                            ? "全天"
                            : `${formatTime(event.start)}–${formatTime(event.end)}`}
                        </span>
                        <i className="day-preview-dot" />
                        <span className="day-preview-title">
                          {event.title}
                        </span>
                        {cog && cog.score >= 4 && (
                          <span
                            className="day-preview-cog"
                            data-score={cog.score}
                            title={`认知耗能：${cog.label}`}
                          >
                            {cog.level.short}
                          </span>
                        )}
                        {level > 1 && (
                          <b
                            className="day-preview-conflict"
                            aria-label={`${level} 项日程重叠`}
                          >
                            {level}
                          </b>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {rows.length === 0 && emptyHint && (
              <p className="day-preview-hint">{emptyHint}</p>
            )}
            {draggable && rows.length > 0 && (
              <p className="day-preview-hint">拖到其他日期即可改期</p>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function DragChip({ drag, pointerX, pointerY }) {
  const reduced = useReducedMotion();
  const x = useSpring(pointerX, DRAG.follow),
    y = useSpring(pointerY, DRAG.follow);
  const started = useRef(false);
  useLayoutEffect(() => {
    if (drag && !started.current) {
      x.jump(pointerX.get());
      y.jump(pointerY.get());
    }
    started.current = Boolean(drag);
  }, [drag, pointerX, pointerY, x, y]);
  useEffect(() => {
    if (!drag?.result || reduced) return;
    if (drag.result === "cancel" && drag.from) {
      animate(x, drag.from.left + drag.from.width / 2, DRAG.back);
      animate(y, drag.from.top + drag.from.height / 2, DRAG.back);
    }
    if (drag.result === "drop" && drag.target) {
      animate(x, drag.target.left + drag.target.width / 2, {
        duration: DRAG.drop,
      });
      animate(y, drag.target.top + drag.target.height / 2, {
        duration: DRAG.drop,
      });
    }
  }, [drag?.result]);
  return createPortal(
    <AnimatePresence>
      {drag && (
        <motion.div
          className="drag-chip"
          style={{
            x: reduced ? pointerX : x,
            y: reduced ? pointerY : y,
            left: -12,
            top: -14,
          }}
          initial={{ scale: 1, rotate: 0, opacity: 0.85 }}
          animate={{
            scale: 0.94,
            rotate: reduced ? 0 : 0.6,
            opacity: 1,
            transition: { duration: 0.12 },
          }}
          exit={{
            opacity: 0,
            scale: drag.result === "drop" ? 0.5 : 0.9,
            transition: { duration: drag.result === "drop" ? DRAG.drop : 0.14 },
          }}
        >
          <i
            className="day-preview-dot"
            style={{ "--dot": categoryOf(drag.event).color }}
          />
          <span className="drag-chip-title">{drag.event.title}</span>
          <span className="drag-chip-time">
            {drag.event.allDay ? "全天" : formatTime(drag.event.start)}
          </span>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
