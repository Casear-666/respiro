import test from "node:test";
import assert from "node:assert/strict";
import {
  angleToMinutes,
  assignLanes,
  dialPoint,
  minuteDelta,
  minutesToAngle,
  snapMinutes,
} from "./geometry.js";

test("minutesToAngle / angleToMinutes round-trip across the whole day", () => {
  for (const m of [0, 15, 90, 359.5, 720, 1000.25, 1439.9]) {
    const a = minutesToAngle(m);
    const x = 150 + 100 * Math.sin(a);
    const y = 150 - 100 * Math.cos(a);
    const back = angleToMinutes(x, y);
    const diff = Math.abs(minuteDelta(m, back));
    assert.ok(diff < 0.01, `minute ${m} -> ${back}`);
  }
});

test("0:00 sits at the top, 6:00 on the right, 12:00 at the bottom", () => {
  assert.deepEqual(dialPoint(100, 0).map(Math.round), [150, 50]);
  assert.deepEqual(dialPoint(100, 360).map(Math.round), [250, 150]);
  assert.deepEqual(dialPoint(100, 720).map(Math.round), [150, 250]);
  assert.deepEqual(dialPoint(100, 1080).map(Math.round), [50, 150]);
});

test("snapMinutes rounds to 15 and wraps across midnight", () => {
  assert.equal(snapMinutes(67), 60);
  assert.equal(snapMinutes(68), 75);
  assert.equal(snapMinutes(1439), 0); // wraps to midnight
  assert.equal(snapMinutes(1432), 1440 - 15);
  assert.equal(snapMinutes(7), 0);
  assert.equal(snapMinutes(8), 15);
});

test("minuteDelta takes the short way around midnight", () => {
  assert.equal(minuteDelta(1430, 10), 20);
  assert.equal(minuteDelta(10, 1430), -20);
  assert.equal(minuteDelta(100, 460), 360);
});

test("assignLanes packs overlapping arcs into separate lanes", () => {
  const arcs = [
    { id: "a", from: 0, length: 120 },
    { id: "b", from: 60, length: 120 }, // overlaps a
    { id: "c", from: 90, length: 60 }, // overlaps a and b
    { id: "d", from: 200, length: 60 }, // free again
  ];
  const { laneOf, laneCount } = assignLanes(arcs);
  assert.equal(laneCount, 3);
  assert.equal(laneOf(arcs[0]), 0);
  assert.equal(laneOf(arcs[1]), 1);
  assert.equal(laneOf(arcs[2]), 2);
  assert.equal(laneOf(arcs[3]), 0);
});
