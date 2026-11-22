// One scalar drives the whole page: `load` in [0,1] follows the app's density
// mode (CalendarCanvas heatVal = dayLoad.count, completed events excluded).
import {
  addDays,
  dateKey,
  dayLoad,
  eventOnDay,
  localDate,
  overlapLevels,
} from "../../../shared/domain.js";
import { energyForCount } from "../../../shared/energy.js";

export function loadOf(events, day) {
  const b = dayLoad(events, day);
  const load = b.count === 0 ? 0 : (Math.min(8, Math.max(1, b.count)) - 1) / 7;
  return {
    load,
    count: b.count,
    minutes: Math.round(b.minutes),
    level: b.level,
    peak: b.peak,
    label: b.label,
    overload: b.level === 3,
    energy: energyForCount(Math.max(1, b.count)),
  };
}

const MOODS = [
  "今天是留白时光。",
  "节奏从容，事情一件件来。",
  "安排充实，记得给自己留白。",
  "留意重叠，挑一件可以挪走的事。",
];
export const moodSentence = (level) => MOODS[Math.min(3, Math.max(0, level))];

// Timed events that share their slot with at least one other active event —
// the list a surge warning plate should suggest moving.
export function overlappingItems(events, day) {
  const arcs = dayArcs(events, day).filter((a) => !a.event.completed);
  const levels = overlapLevels(arcs.map((a) => a.event));
  return arcs.filter((a) => (levels.get(a.event.id) ?? 1) >= 2);
}

export function minutesToText(minutes) {
  const m = Math.round(minutes);
  if (m <= 0) return "0 分";
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h} 小时${r ? ` ${r} 分` : ""}` : `${r} 分`;
}

// Timed events that touch `day`, clamped to the day, in clock order.
export function dayArcs(events, day) {
  const start = localDate(day);
  start.setHours(0, 0, 0, 0);
  const end = addDays(start, 1);
  const minute = (stamp) => {
    if (stamp === +end) return 1440;
    const d = new Date(stamp);
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  };
  return events
    .filter((e) => !e.allDay && eventOnDay(e, start))
    .map((event) => {
      const from = minute(Math.max(+start, +localDate(event.start)));
      const to = minute(Math.min(+end, +localDate(event.end)));
      return { event, from, length: Math.max(1, to - from) };
    })
    .sort((a, b) => a.from - b.from);
}

// Wrap-up summary: completed count, focused minutes and the busiest 2h window.
export function wrapSummary(events, day) {
  const start = localDate(day);
  start.setHours(0, 0, 0, 0);
  const end = addDays(start, 1);
  const arcs = dayArcs(events, day);
  const clamp = (v) => Math.max(0, Math.min(1440, v));
  const done = arcs.filter((a) => a.event.completed);
  const focusedMinutes = done.reduce((t, a) => t + a.length, 0);
  const total = events.filter((e) => eventOnDay(e, start)).length;

  // Find the 2-hour window holding the deepest overlap of active (not
  // completed) events; fall back to the first event's start on quiet days.
  const levels = overlapLevels(arcs.map((a) => ({
    ...a.event,
    start: new Date(+start + a.from * 60000),
    end: new Date(+start + clamp(a.from + a.length) * 60000),
  })));
  let bestStart = arcs[0]?.from ?? 12 * 60;
  let bestDepth = 0;
  for (const a of arcs) {
    if (a.event.completed) continue;
    const depth = levels.get(a.event.id) ?? 1;
    if (depth > bestDepth) {
      bestDepth = depth;
      bestStart = a.from;
    }
  }
  const hh = (m) => `${String(Math.floor(clamp(m) / 60) % 24).padStart(2, "0")}:${String(Math.round(clamp(m) % 60)).padStart(2, "0")}`;
  const busiest =
    arcs.length === 0 ? null : `${hh(bestStart)}–${hh(Math.min(1440, bestStart + 120))}`;
  return {
    doneCount: done.length,
    total,
    focusedMinutes,
    busiest,
    dayKey: dateKey(start),
    end,
  };
}
