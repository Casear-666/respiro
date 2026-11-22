// Today's timeline: time, category dot, title, cognitive chip, checkbox.
// Current / next item is highlighted; hover syncs with the rim arc.
import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import {
  addDays,
  categoryOf,
  eventCognitiveInfo,
  eventOnDay,
  formatTime,
  localDate,
} from "../../../shared/domain.js";

function range(event, start, end) {
  if (event.allDay) return "全天";
  const from = localDate(event.start) < start ? "00:00" : formatTime(event.start);
  const to = localDate(event.end) >= end ? "24:00" : formatTime(event.end);
  return `${from}–${to}`;
}

export function Timeline({ events, day, now, hoverId, onHover, onToggle, onDelete, reduced }) {
  const start = localDate(day);
  start.setHours(0, 0, 0, 0);
  const end = addDays(start, 1);
  const entries = events
    .filter((e) => eventOnDay(e, start))
    .sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        +localDate(a.start) - +localDate(b.start),
    );
  const currentId =
    entries.find((e) => !e.allDay && +localDate(e.start) <= +now && +localDate(e.end) > +now)?.id ??
    entries.find((e) => !e.allDay && +localDate(e.start) > +now)?.id;
  return (
    <ul className="timeline" aria-label="今日安排">
      <AnimatePresence initial={false}>
        {entries.length === 0 && (
          <motion.li className="tl-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            今天是留白时光
          </motion.li>
        )}
        {entries.map((event) => {
          const cat = categoryOf(event);
          const cog = eventCognitiveInfo(event);
          const isNow = event.id === currentId;
          return (
            <motion.li
              key={event.id}
              layout={reduced ? false : "position"}
              initial={{ opacity: 0, y: reduced ? 0 : 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: reduced ? 0 : 16, transition: { duration: 0.18 } }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <div
                className="tl-row"
                data-hover={hoverId === event.id || undefined}
                data-now={isNow || undefined}
                data-done={event.completed || undefined}
                onPointerEnter={() => onHover(event.id)}
                onPointerLeave={() => onHover(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onDelete(event.id);
                }}
              >
                <button
                  type="button"
                  className="tl-check"
                  aria-label={event.completed ? "取消完成" : "标记完成"}
                  aria-pressed={event.completed}
                  onClick={() => onToggle(event.id)}
                >
                  {event.completed && <Check size={13} strokeWidth={3} />}
                </button>
                <time className="tl-time">{range(event, start, end)}</time>
                <i className="tl-dot" style={{ background: cat.color }} />
                <span className="tl-title">{event.title}</span>
                <span className="cog-chip" data-score={cog.score} title={`认知耗能：${cog.label}`}>
                  {cog.level.short}
                </span>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
