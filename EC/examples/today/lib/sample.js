// A demo week generated around the real "today": Mon 2 · Tue 4 · Wed 6
// (overlapping) · Thu 8 (deep overlap -> level 3) · Fri 3 · Sat 1 · Sun 0,
// plus one multi-day all-day item. Uses the app's domain model throughout.
import {
  addDays,
  dateKey,
  dayLoad,
  localDate,
  normalizeEvent,
  overlapLevels,
} from "../../../shared/domain.js";

// [dayOffset 0=Mon, "HH:MM", durationMin, title, tag]
const PLAN = [
  // Monday — calm
  [0, "07:40", 50, "晨间阅读", "personal"],
  [0, "19:30", 60, "散步与播客", "personal"],
  // Tuesday — steady
  [1, "09:00", 120, "专注设计", "work"],
  [1, "11:00", 45, "项目碰头", "meeting"],
  [1, "15:00", 90, "整理作品集", "work"],
  [1, "20:00", 45, "拉伸与冥想", "personal"],
  // Wednesday — busy, overlapping
  [2, "09:00", 150, "方案初稿", "work"],
  [2, "10:00", 60, "晨会同步", "meeting"],
  [2, "10:30", 90, "客户沟通", "meeting"],
  [2, "14:00", 120, "深度写作", "work"],
  [2, "15:30", 60, "方案评审", "urgent"],
  [2, "18:00", 60, "健身与晚餐", "personal"],
  // Thursday — overload, triple overlap mid-afternoon
  [3, "08:30", 60, "邮件与清单", "other"],
  [3, "09:30", 120, "专注实现", "work"],
  [3, "11:00", 45, "设计走查", "meeting"],
  [3, "14:00", 120, "冲刺收尾", "work"],
  [3, "14:30", 90, "需求评审", "meeting"],
  [3, "15:00", 120, "修复回归", "urgent"],
  [3, "16:30", 60, "进度对表", "meeting"],
  [3, "20:00", 60, "整理明天", "other"],
  // Friday — winding down
  [4, "09:30", 120, "本周复盘", "work"],
  [4, "14:00", 60, "一对一交流", "meeting"],
  [4, "17:30", 90, "朋友的晚饭", "personal"],
  // Saturday — nearly blank
  [5, "10:30", 90, "逛展与咖啡", "personal"],
];

let seq = 0;
const timed = (monday, [dayOffset, hm, dur, title, tag]) => {
  const start = addDays(monday, dayOffset);
  const [h, m] = hm.split(":").map(Number);
  start.setHours(h, m, 0, 0);
  return normalizeEvent({
    id: `tide-${dateKey(monday)}-${seq++}`,
    title,
    tag,
    start,
    end: new Date(+start + dur * 60000),
  });
};

export function sampleWeek(now = new Date()) {
  const monday = addDays(now, -((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const events = PLAN.map((spec) => timed(monday, spec));
  // One all-day marker sits on Thursday: it raises the day's count to 9 but
  // the load scalar clamps at 8, so the dial's full range is unchanged.
  const thursday = addDays(monday, 3);
  events.push(
    normalizeEvent({
      id: `tide-${dateKey(monday)}-allday`,
      title: "版本发布窗口",
      tag: "urgent",
      allDay: true,
      start: dateKey(thursday),
      end: dateKey(addDays(thursday, 1)),
    }),
  );

  // The week should feel lived-in: days before today land at ~60% done and
  // everything on today that already ended is marked complete. A past
  // level-3 day keeps its overlapping cluster pending (non-overlapping
  // items still complete) so the high-tide story survives. Overlaps are
  // measured per day, timed events only — the all-day marker would make
  // every Thursday item look "overlapping" otherwise.
  const todayKey = dateKey(now);
  const dayEvents = new Map();
  for (const e of events) {
    if (e.allDay) continue;
    const s = localDate(e.start);
    const k = dateKey(s);
    if (!dayEvents.has(k)) dayEvents.set(k, []);
    dayEvents.get(k).push(e);
  }
  const surgeDays = new Set();
  for (const [k, list] of dayEvents) {
    if (k < todayKey && dayLoad(events, localDate(list[0].start)).level === 3) {
      surgeDays.add(k);
    }
  }
  const done = new Set();
  for (const [k, list] of dayEvents) {
    if (k > todayKey) continue;
    if (k === todayKey) {
      for (const e of list) {
        if (+localDate(e.end) < +now) done.add(e.id);
      }
      continue;
    }
    const ov = overlapLevels(list);
    list.forEach((e, i) => {
      const keep = surgeDays.has(k) ? (ov.get(e.id) ?? 1) >= 2 : i % 5 >= 3;
      if (!keep) done.add(e.id);
    });
  }
  for (let i = 0; i < events.length; i++) {
    if (done.has(events[i].id)) events[i] = { ...events[i], completed: true };
  }
  return events;
}

export const weekDays = (now = new Date()) => {
  const monday = addDays(now, -((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => dateKey(addDays(monday, i)));
};
