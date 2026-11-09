import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEvent,
  parseBackup,
  createBackup,
  mergeEvents,
  eventOnDay,
  addDays,
  localDate,
  dateKey,
  overlapLevels,
  dayLoad,
  rowNeighbors,
  eventsByDay,
  shiftByDays,
  DEFAULT_TITLE,
  sampleEvents,
} from "../../shared/domain.js";
const make = (
  id,
  start = "2026-10-20T09:00:00+08:00",
  end = "2026-10-20T10:00:00+08:00",
  extra = {},
) =>
  normalizeEvent({
    id,
    title: `日程 ${id}`,
    start,
    end,
    tag: "work",
    ...extra,
  });
test("legacy JSON with BOM migrates without losing ids, dates, notes or tags", () => {
  const data = parseBackup(
    "\uFEFF" +
      JSON.stringify([
        {
          id: 8,
          title: "旧日程",
          start: "2026-10-20T01:00:00Z",
          end: "2026-10-20T02:00:00Z",
          description: "保留备注",
          tag: "meeting",
        },
      ]),
  );
  assert.equal(data[0].id, "8");
  assert.equal(data[0].description, "保留备注");
  assert.equal(data[0].tag, "meeting");
  assert.equal(data[0].allDay, false);
  assert.deepEqual(parseBackup(createBackup(data)), data);
});
test("all-day end is exclusive and never spills into following day", () => {
  const event = make("a", "2026-10-20", "2026-10-21", { allDay: true });
  assert.equal(eventOnDay(event, "2026-10-20"), true);
  assert.equal(eventOnDay(event, "2026-10-21"), false);
  assert.equal(dayLoad([event], "2026-10-20").minutes, 0);
});
test("invalid dates, inverted times, oversized titles, oversized notes, malformed and newer backups fail clearly", () => {
  assert.throws(() => make("x", "bad"), /结束时间/);
  assert.equal(make("x", undefined, undefined, { title: " " }).title, DEFAULT_TITLE);
  assert.throws(
    () => make("x", undefined, undefined, { title: "字".repeat(201) }),
    /200/,
  );
  assert.throws(
    () => make("x", "2026-02-30", "2026-03-04", { allDay: true }),
    /有效的日期/,
  );
  assert.throws(
    () => make("x", undefined, undefined, { description: "x".repeat(5001) }),
    /5000/,
  );
  assert.throws(() => parseBackup("{"), /有效的日历备份/);
  assert.throws(() => parseBackup('{"version":3,"events":[]}'), /升级/);
  assert.throws(
    () => parseBackup(JSON.stringify([{ title: "bad", start: "bad" }])),
    /第 1 项/,
  );
});
test("untitled entries default to the new-arrangement title through import and merge", () => {
  const parsed = parseBackup(
    JSON.stringify([
      { start: "2026-10-20T01:00:00Z", end: "2026-10-20T02:00:00Z" },
    ]),
  );
  assert.equal(parsed[0].title, "新安排");
  const merged = mergeEvents(
    [],
    [parsed[0], { start: "2026-10-20T01:00:00Z", end: "2026-10-20T02:00:00Z" }],
  );
  assert.equal(merged.added, 1);
  assert.equal(merged.skipped, 1);
  assert.equal(merged.events.length, 1);
});
test("merge skips duplicates but preserves colliding ids with different contents", () => {
  const existing = [make("1")],
    incoming = [
      make("1"),
      make("1", undefined, undefined, { title: "另一个日程" }),
    ];
  const merged = mergeEvents(existing, incoming, () => "new-id");
  assert.equal(merged.added, 1);
  assert.equal(merged.skipped, 1);
  assert.equal(merged.events.length, 2);
  assert.equal(merged.events[1].id, "new-id");
  assert.equal(mergeEvents(merged.events, incoming).added, 0);
  assert.deepEqual(merged.addedEvents, [merged.events[1]]);
  assert.deepEqual(mergeEvents(merged.events, incoming).addedEvents, []);
  assert.equal(incoming[1].id, "1");
});
test("overlap sweep handles adjacent intervals, chains, all-day and completed events", () => {
  const list = [
    make("a"),
    make("b", "2026-10-20T10:00:00+08:00", "2026-10-20T11:00:00+08:00"),
    make("c", "2026-10-20T09:30:00+08:00", "2026-10-20T10:30:00+08:00"),
    make("d", undefined, undefined, { completed: true }),
    make("e", "2026-10-20", "2026-10-21", { allDay: true }),
  ];
  assert.deepEqual(
    [...overlapLevels(list)],
    [
      ["a", 3],
      ["b", 3],
      ["c", 3],
      ["e", 3],
    ],
  );
  assert.equal(dayLoad(list, "2026-10-20").minutes, 120);
  assert.equal(overlapLevels([list[0], list[1]]).get("a"), 1);
});
test("all-day and multi-day workloads participate in heat, excluding the exclusive end date", () => {
  const events = [
    make("a", "2026-10-08", "2026-10-15", { allDay: true }),
    make("b", "2026-10-08", "2026-10-15", { allDay: true }),
    make("c", "2026-10-08", "2026-10-10", { allDay: true }),
  ];
  assert.equal(overlapLevels(events).get("a"), 3);
  assert.equal(dayLoad(events, "2026-10-08").count, 3);
  assert.equal(dayLoad(events, "2026-10-10").count, 2);
  assert.equal(dayLoad(events, "2026-10-14").peak, 2);
  assert.equal(dayLoad(events, "2026-10-15").count, 0);
  assert.equal(dayLoad([events[0]], "2026-10-08").level, 1);
});
test("rowNeighbors walks the visible week row without crossing its edges", () => {
  const monday = "2026-10-19",
    wednesday = "2026-10-21",
    sunday = "2026-10-25",
    saturday = "2026-10-24",
    friday = "2026-10-23";
  assert.deepEqual(rowNeighbors(monday, { firstDay: 1 }).prev, null);
  assert.equal(rowNeighbors(monday, { firstDay: 1 }).next, "2026-10-20");
  assert.deepEqual(rowNeighbors(wednesday, { firstDay: 1 }), {
    prev: "2026-10-20",
    next: "2026-10-22",
  });
  assert.equal(rowNeighbors(sunday, { firstDay: 1 }).next, null);
  assert.equal(rowNeighbors(sunday, { firstDay: 1 }).prev, saturday);
  assert.equal(rowNeighbors(sunday, { firstDay: 0 }).prev, null);
  assert.equal(rowNeighbors(sunday, { firstDay: 0 }).next, "2026-10-26");
  assert.equal(rowNeighbors(saturday, { firstDay: 0 }).next, null);
  assert.equal(rowNeighbors(saturday, { firstDay: 0 }).prev, friday);
  assert.equal(
    rowNeighbors(friday, { firstDay: 1, showWeekends: false }).next,
    null,
  );
  assert.equal(
    rowNeighbors(monday, { firstDay: 1, showWeekends: false }).prev,
    null,
  );
  assert.equal(
    rowNeighbors(wednesday, { firstDay: 1, showWeekends: false }).next,
    "2026-10-22",
  );
  assert.deepEqual(rowNeighbors(wednesday, { single: true }), {
    prev: null,
    next: null,
  });
});
test("eventsByDay buckets multi-day events with exclusive ends and keeps completed ones sorted", () => {
  const events = [
    make("span", "2026-10-08", "2026-10-11", { allDay: true }),
    make("timed", "2026-10-09T14:00:00+08:00", "2026-10-09T15:00:00+08:00"),
    make("done", "2026-10-09T09:00:00+08:00", "2026-10-09T10:00:00+08:00", {
      completed: true,
    }),
  ];
  const map = eventsByDay(events, "2026-10-08", 4);
  assert.deepEqual(
    [...map.values()].map((list) => list.map((e) => e.id)),
    [["span"], ["span", "done", "timed"], ["span"], []],
  );
});
test("shiftByDays keeps all-day date strings and timed wall-clock hours", () => {
  const allDay = make("span", "2026-10-08", "2026-10-11", { allDay: true });
  assert.deepEqual(shiftByDays(allDay, 2), {
    start: "2026-10-10",
    end: "2026-10-13",
  });
  const timed = make(
    "timed",
    "2026-10-20T09:30:00+08:00",
    "2026-10-20T10:45:00+08:00",
  );
  const shifted = shiftByDays(timed, -3);
  assert.equal(
    localDate(shifted.start).getHours(),
    9,
  );
  assert.equal(localDate(shifted.start).getMinutes(), 30);
  assert.equal(localDate(shifted.end).getMinutes(), 45);
  assert.equal(
    dateKey(localDate(shifted.start)),
    dateKey(addDays("2026-10-20", -3)),
  );
  assert.deepEqual(shiftByDays(timed, 0), {
    start: timed.start,
    end: timed.end,
  });
});
test("range maxima match a brute-force oracle on a varied 300-event schedule", () => {
  const base = +new Date("2026-10-20T00:00:00+08:00");
  const events = Array.from({ length: 300 }, (_, i) =>
    make(
      String(i),
      new Date(base + ((i * 47) % 1400) * 60000),
      new Date(base + (((i * 47) % 1400) + 15 + (i % 9) * 10) * 60000),
    ),
  );
  const levels = overlapLevels(events);
  for (const e of events) {
    const points = [
      +new Date(e.start),
      ...events
        .map((x) => +new Date(x.start))
        .filter((t) => t >= +new Date(e.start) && t < +new Date(e.end)),
    ];
    const expected = Math.max(
      ...points.map(
        (t) =>
          events.filter((x) => +new Date(x.start) <= t && +new Date(x.end) > t)
            .length,
      ),
    );
    assert.equal(levels.get(e.id), expected);
  }
});
test("10,000 concurrent events are computed without quadratic per-event scans", () => {
  const events = Array.from({ length: 10000 }, (_, i) => make(String(i)));
  const start = performance.now(),
    levels = overlapLevels(events);
  assert.equal(levels.size, 10000);
  assert.equal(levels.get("5000"), 10000);
  assert.ok(performance.now() - start < 2000);
});
test("demo data is valid, reproducible within a week and isolated from storage", () => {
  const list = sampleEvents(new Date("2026-10-20T12:00:00+08:00"));
  assert.equal(list.length, 15);
  assert.equal(new Set(list.map((e) => e.id)).size, list.length);
  list.forEach((e) => assert.deepEqual(normalizeEvent(e), e));
});
