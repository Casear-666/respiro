export const CATEGORIES = [
  { id: "work", label: "工作", color: "#75886e", soft: "#eaf0e6" },
  { id: "meeting", label: "会议", color: "#b58b52", soft: "#f5eddf" },
  { id: "personal", label: "生活", color: "#8a83a4", soft: "#eeebf4" },
  { id: "urgent", label: "重要", color: "#c07965", soft: "#f7e9e2" },
  { id: "other", label: "其他", color: "#8e969b", soft: "#edf0f1" },
];
export const DEFAULT_TITLE = "新安排";
export const DEFAULT_SETTINGS = {
  theme: "light",
  defaultView: "dayGridMonth",
  weekStart: 1,
  showWeekends: true,
  workStart: "08:00",
  workEnd: "22:00",
};
export function normalizeSettings(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_SETTINGS,
    theme: ["light", "dark", "system"].includes(input.theme)
      ? input.theme
      : DEFAULT_SETTINGS.theme,
    defaultView: ["dayGridMonth", "timeGridWeek", "timeGridDay"].includes(
      input.defaultView,
    )
      ? input.defaultView
      : DEFAULT_SETTINGS.defaultView,
    weekStart: input.weekStart === 0 ? 0 : 1,
    showWeekends:
      typeof input.showWeekends === "boolean" ? input.showWeekends : true,
  };
}

export const dateKey = (value) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const localDate = (value) =>
  new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00` : value,
  );
export const addDays = (value, count) => {
  const d = localDate(value);
  d.setDate(d.getDate() + count);
  return d;
};
export const uid = () => globalThis.crypto.randomUUID();
export const categoryOf = (event) =>
  CATEGORIES.find((c) => c.id === event.tag) || CATEGORIES[4];
export const formatTime = (value) =>
  localDate(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export const shiftByDays = (event, delta) => ({
  start: event.allDay
    ? dateKey(addDays(localDate(event.start), delta))
    : addDays(localDate(event.start), delta).toISOString(),
  end: event.allDay
    ? dateKey(addDays(localDate(event.end), delta))
    : addDays(localDate(event.end), delta).toISOString(),
});
export const eventOnDay = (event, day) => {
  const start = localDate(day);
  start.setHours(0, 0, 0, 0);
  return (
    localDate(event.start) < addDays(start, 1) && localDate(event.end) > start
  );
};

export function normalizeEvent(input) {
  if (!input || typeof input !== "object") throw new Error("日程格式不正确");
  const title = String(input.title || "").trim() || DEFAULT_TITLE;
  if (title.length > 200) throw new Error("日程名称不能超过 200 字");
  const description = String(input.description || "").trim();
  if (description.length > 5000) throw new Error("备注不能超过 5000 字");
  const allDay = input.allDay === true;
  if (
    allDay &&
    ![input.start, input.end].every(
      (v) =>
        /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && dateKey(localDate(v)) === v,
    )
  ) {
    throw new Error("全天日程需要有效的日期");
  }
  const s = localDate(input.start),
    e = localDate(input.end);
  if (!Number.isFinite(+s) || !Number.isFinite(+e) || e <= s)
    throw new Error("结束时间必须晚于开始时间");
  const id = String(input.id ?? uid());
  if (!id || id.length > 120) throw new Error("日程编号无效");
  return {
    id,
    title,
    start: allDay ? input.start : s.toISOString(),
    end: allDay ? input.end : e.toISOString(),
    allDay,
    description,
    tag: CATEGORIES.some((c) => c.id === input.tag) ? input.tag : "other",
    completed: input.completed === true,
  };
}

export function parseBackup(raw) {
  if (typeof raw !== "string" || raw.length > 20 * 1024 * 1024)
    throw new Error("备份文件过大（上限 20 MB）");
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("无法读取 JSON，请选择有效的日历备份");
  }
  if (parsed?.version > 2) throw new Error("备份来自更新的版本，请先升级软件");
  const list = Array.isArray(parsed) ? parsed : parsed?.events;
  if (!Array.isArray(list) || list.length > 50000)
    throw new Error("备份需要包含有效的日程列表（最多 50,000 项）");
  return list.map((event, index) => {
    try {
      return normalizeEvent(event);
    } catch (err) {
      throw new Error(`第 ${index + 1} 项：${err.message}`);
    }
  });
}

export function mergeEvents(existing, incoming, createId = uid) {
  const map = new Map(existing.map((e) => [String(e.id), e]));
  const fingerprints = new Set(existing.map(fingerprint));
  const addedEvents = [];
  let skipped = 0;
  for (const source of incoming) {
    const event = normalizeEvent(source);
    const key = fingerprint(event);
    if (fingerprints.has(key)) {
      skipped++;
      continue;
    }
    if (map.has(event.id)) event.id = createId();
    map.set(event.id, event);
    fingerprints.add(key);
    addedEvents.push(event);
  }
  return {
    events: [...map.values()],
    added: addedEvents.length,
    skipped,
    addedEvents,
  };
}
function fingerprint(e) {
  return JSON.stringify([
    e.title,
    e.start,
    e.end,
    e.allDay,
    e.description,
    e.tag,
    e.completed,
  ]);
}
export const createBackup = (events) =>
  JSON.stringify(
    {
      app: "Energy Calendar",
      version: 2,
      exportedAt: new Date().toISOString(),
      events,
    },
    null,
    2,
  );

// One global sweep; end points sort before start points so adjacent events do not conflict.
// Range maxima use a segment tree rather than running a second sweep for every event.
export function overlapLevels(events) {
  const active = events.filter((e) => !e.completed);
  const coords = [
    ...new Set(active.flatMap((e) => [+localDate(e.start), +localDate(e.end)])),
  ].sort((a, b) => a - b);
  const indices = new Map(coords.map((t, i) => [t, i]));
  const diff = new Int32Array(coords.length + 1);
  for (const e of active) {
    diff[indices.get(+localDate(e.start))]++;
    diff[indices.get(+localDate(e.end))]--;
  }
  let size = 1;
  while (size < coords.length) size *= 2;
  const tree = new Int32Array(size * 2);
  let count = 0;
  for (let i = 0; i < coords.length; i++) {
    count += diff[i];
    tree[size + i] = count;
  }
  for (let i = size - 1; i; i--)
    tree[i] = Math.max(tree[i * 2], tree[i * 2 + 1]);
  const result = new Map();
  for (const e of active) {
    let l = size + indices.get(+localDate(e.start)),
      r = size + indices.get(+localDate(e.end)),
      max = 1;
    while (l < r) {
      if (l & 1) max = Math.max(max, tree[l++]);
      if (r & 1) max = Math.max(max, tree[--r]);
      l >>= 1;
      r >>= 1;
    }
    result.set(e.id, max);
  }
  return result;
}

// `bucket` holds the active events touching `start`; dayLoad/rangeLoads share this math.
function dayLoadBucket(bucket, start) {
  const end = addDays(start, 1);
  const points = bucket
    .filter((e) => !e.allDay)
    .map((e) => [
      Math.max(+start, +localDate(e.start)),
      Math.min(+end, +localDate(e.end)),
    ])
    .sort((a, b) => a[0] - b[0]);
  let minutes = 0,
    right = -Infinity;
  for (const [s, e] of points) {
    minutes += Math.max(0, e - Math.max(s, right)) / 60000;
    right = Math.max(right, e);
  }
  const levels = overlapLevels(
    bucket.map((e) => ({
      ...e,
      start: new Date(Math.max(+start, +localDate(e.start))),
      end: new Date(Math.min(+end, +localDate(e.end))),
    })),
  );
  const peak = Math.max(1, ...levels.values());
  const level =
    peak >= 3 || bucket.length >= 5 || minutes >= 480
      ? 3
      : peak >= 2 || bucket.length >= 3 || minutes >= 300
        ? 2
        : bucket.length > 0
          ? 1
          : 0;
  return {
    minutes,
    count: bucket.length,
    peak,
    level,
    label: ["留白时光", "从容有序", "安排充实", "留意重叠"][level],
  };
}

export function dayLoad(events, value) {
  const start = localDate(value);
  start.setHours(0, 0, 0, 0);
  return dayLoadBucket(
    events.filter((e) => !e.completed && eventOnDay(e, start)),
    start,
  );
}

export function rowNeighbors(
  value,
  { firstDay = 1, showWeekends = true, single = false } = {},
) {
  if (single) return { prev: null, next: null };
  const start = localDate(value);
  const column = (d) => (d.getDay() - firstDay + 7) % 7;
  const self = column(start);
  const step = (delta) => {
    for (let i = 1; i <= 6; i++) {
      const d = addDays(start, delta * i);
      if (delta < 0 ? column(d) > self : column(d) < self) return null;
      if (!showWeekends && d.getDay() % 6 === 0) continue;
      return dateKey(d);
    }
    return null;
  };
  return { prev: step(-1), next: step(1) };
}

// Workloads for `count` consecutive days from `firstDay`, computed in one pass.
export function rangeLoads(events, firstDay, count = 42) {
  const start = localDate(firstDay);
  start.setHours(0, 0, 0, 0);
  const buckets = Array.from({ length: count }, () => []);
  for (const e of events) {
    if (e.completed) continue;
    const s = +localDate(e.start),
      en = +localDate(e.end);
    // -1 guards the day-index guess against non-86400s days (DST).
    let k = Math.max(0, Math.floor((s - +start) / 86400000) - 1);
    while (k < count && +addDays(start, k) < en) {
      if (+addDays(start, k + 1) > s) buckets[k].push(e);
      k++;
    }
  }
  const map = new Map();
  for (let k = 0; k < count; k++) {
    const day = addDays(start, k);
    map.set(dateKey(day), dayLoadBucket(buckets[k], day));
  }
  return map;
}

export function eventsByDay(events, firstDay, count) {
  const start = localDate(firstDay);
  start.setHours(0, 0, 0, 0);
  const buckets = Array.from({ length: count }, () => []);
  for (const e of events) {
    const s = +localDate(e.start),
      en = +localDate(e.end);
    let k = Math.max(0, Math.floor((s - +start) / 86400000) - 1);
    while (k < count && +addDays(start, k) < en) {
      if (+addDays(start, k + 1) > s) buckets[k].push(e);
      k++;
    }
  }
  const map = new Map();
  for (let k = 0; k < count; k++) {
    map.set(
      dateKey(addDays(start, k)),
      buckets[k].sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) ||
          +localDate(a.start) - +localDate(b.start),
      ),
    );
  }
  return map;
}

export function sampleEvents(now = new Date()) {
  const monday = addDays(now, -((now.getDay() + 6) % 7));
  const make = (day, hour, minute, duration, title, tag, description = "") => {
    const start = addDays(monday, day);
    start.setHours(hour, minute, 0, 0);
    return normalizeEvent({
      id: `demo-${day}-${hour}-${minute}`,
      title,
      tag,
      start,
      end: new Date(+start + duration * 60000),
      description,
    });
  };
  return [
    make(
      0,
      9,
      30,
      90,
      "一周，从容开始",
      "work",
      "整理本周的优先事项，给重要的事留出时间。",
    ),
    make(0, 14, 0, 60, "产品灵感碰头", "meeting"),
    make(1, 10, 0, 120, "留一段专注时间", "work"),
    make(1, 15, 0, 60, "和设计聊聊", "meeting"),
    make(1, 18, 30, 60, "散步，去看看秋天", "personal"),
    make(2, 9, 0, 90, "把想法变成草稿", "work"),
    make(2, 14, 0, 60, "项目进展同步", "meeting"),
    make(2, 14, 30, 60, "方案讨论", "urgent"),
    make(3, 10, 0, 120, "深度工作 · 请勿打扰", "work"),
    make(3, 16, 0, 45, "读完那本书", "personal"),
    make(4, 11, 0, 60, "本周的小小回顾", "work"),
    make(4, 15, 0, 90, "分享新的想法", "meeting"),
    make(5, 10, 0, 120, "和朋友喝杯咖啡", "personal"),
    make(6, 16, 0, 60, "给下周留一点空白", "other"),
    {
      ...make(0, 0, 0, 1440, "保持好奇，慢慢来", "other"),
      allDay: true,
      start: dateKey(monday),
      end: dateKey(addDays(monday, 3)),
    },
  ];
}
