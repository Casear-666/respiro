import test from "node:test";
import assert from "node:assert/strict";
import { energyForCount, energyLegend } from "../../shared/energy.js";
import { normalizeEvent, overlapLevels } from "../../shared/domain.js";
test("workload uses a distinct warm progression from sage to gold, caramel, clay and wine", () => {
  const palette = [1, 2, 3, 5, 8].map(energyForCount);
  assert.deepEqual(
    palette.map((c) => c.label),
    ["从容", "充实", "较忙", "繁忙", "高负荷"],
  );
  assert.equal(new Set(palette.map((c) => c.gradient)).size, 5);
  assert.ok(palette[0].h > 90);
  assert.ok(palette[1].h > 35 && palette[1].h < 60);
  assert.ok(palette[2].h > 20 && palette[2].h < 35);
  assert.ok(palette[4].h > 340);
  assert.ok(energyLegend().includes(palette[2].ink));
});
test("all interpolated card colors maintain readable labels and bounded cell transparency", () => {
  for (let count = 1; count <= 8; count += 0.125) {
    const color = energyForCount(count);
    assert.ok(color.contrast >= 4.5, `${count}: ${color.contrast}`);
    assert.ok(color.cell.includes("/"));
    assert.ok(Number.isFinite(color.h));
  }
  assert.equal(energyForCount(100).gradient, energyForCount(8).gradient);
});
test("moving overlapping tasks apart changes colors; restoring their times restores heat", () => {
  const make = (id) =>
    normalizeEvent({
      id,
      title: "同分类日程",
      tag: "work",
      allDay: true,
      start: "2026-10-08",
      end: "2026-10-12",
    });
  const source = [make("a"), make("b"), make("c")];
  const original = energyForCount(overlapLevels(source).get("a")).gradient;
  const moved = [
    source[0],
    source[1],
    { ...source[2], start: "2026-10-12", end: "2026-10-15" },
  ];
  assert.notEqual(
    energyForCount(overlapLevels(moved).get("a")).gradient,
    original,
  );
  assert.notEqual(
    energyForCount(overlapLevels(moved).get("c")).gradient,
    original,
  );
  assert.equal(
    energyForCount(overlapLevels(source).get("a")).gradient,
    original,
  );
});
