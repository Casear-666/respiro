import test from "node:test";
import assert from "node:assert/strict";
import { addDays, localDate, normalizeEvent } from "../../../shared/domain.js";
import { loadOf, minutesToText, wrapSummary } from "./load.js";
import { sampleWeek, weekDays } from "./sample.js";

const DAY = "2026-03-04"; // a Wednesday
const ev = (id, from, to, extra = {}) =>
  normalizeEvent({
    id,
    title: id,
    tag: "work",
    start: `${DAY}T${from}:00`,
    end: `${DAY}T${to}:00`,
    ...extra,
  });

test("load scalar maps event density: 0 -> 0, 1 -> 0, 8+ -> 1", () => {
  assert.equal(loadOf([], DAY).load, 0);
  assert.equal(loadOf([ev("a", "09:00", "10:00")], DAY).load, 0);
  const eight = Array.from({ length: 8 }, (_, i) =>
    ev(`e${i}`, `0${i}:00`, `0${i}:30`),
  );
  assert.equal(loadOf(eight, DAY).load, 1);
  const ten = [...eight, ev("x8", "10:00", "10:30"), ev("x9", "11:00", "11:30")];
  assert.equal(loadOf(ten, DAY).load, 1); // clamps at 8
  assert.equal(loadOf([ev("q", "09:00", "10:00"), ev("w", "10:30", "11:30")], DAY).load, 1 / 7);
});

test("completed events are excluded from the load", () => {
  const events = [
    ev("a", "09:00", "10:00"),
    ev("b", "10:00", "11:00", { completed: true }),
    ev("c", "11:00", "12:00", { completed: true }),
  ];
  assert.equal(loadOf(events, DAY).count, 1);
  assert.equal(loadOf(events, DAY).load, 0);
});

test("sample week has the required per-weekday counts and Thursday overloads", () => {
  const now = new Date("2026-03-04T12:00:00"); // Wednesday
  const events = sampleWeek(now);
  const days = weekDays(now);
  // Required timed counts: Mon 2 · Tue 4 · Wed 6 · Thu 8 · Fri 3 · Sat 1 ·
  // Sun 0 (today may carry up to 2 pre-completed events; the one all-day
  // marker on Thursday is not a timed event).
  const timedCount = (d) =>
    events.filter(
      (e) =>
        !e.allDay &&
        !e.completed &&
        +localDate(e.start) < +addDays(localDate(d), 1) &&
        +localDate(e.end) > +localDate(d),
    ).length;
  const expected = [2, 4, 6, 8, 3, 1, 0];
  const todayIndex = (now.getDay() + 6) % 7;
  days.forEach((d, i) => {
    const n = timedCount(d);
    if (i === todayIndex) {
      assert.ok(n <= expected[i], `today may carry ended events as done: ${n}`);
    } else if (i < todayIndex) {
      // past days arrive ~60% pre-completed
      assert.ok(n < expected[i], `past day ${i} partially done: ${n}`);
    } else {
      assert.equal(n, expected[i], `day ${i}`);
    }
  });
  assert.equal(loadOf(events, days[3]).level, 3, "Thursday reaches 留意重叠");
  assert.equal(loadOf(events, days[6]).level, 0, "Sunday is blank");
});

test("minutesToText renders hours and minutes in the app's voice", () => {
  assert.equal(minutesToText(0), "0 分");
  assert.equal(minutesToText(45), "45 分");
  assert.equal(minutesToText(60), "1 小时");
  assert.equal(minutesToText(330), "5 小时 30 分");
});

test("wrapSummary counts completions, focused minutes and busiest window", () => {
  const events = [
    ev("a", "09:00", "10:30", { completed: true }),
    ev("b", "14:00", "16:00"),
    ev("c", "14:30", "15:30"),
    ev("d", "15:00", "17:00"),
    ev("e", "19:00", "20:00", { completed: true }),
  ];
  const s = wrapSummary(events, DAY);
  assert.equal(s.doneCount, 2);
  assert.equal(s.total, 5);
  assert.equal(s.focusedMinutes, 90 + 60);
  assert.equal(s.busiest, "14:00–16:00"); // triple overlap starts at b
});
