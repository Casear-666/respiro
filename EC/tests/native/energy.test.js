import test from "node:test";
import assert from "node:assert/strict";
import { energyForCount, energyLegend } from "../../shared/energy.js";
import { normalizeEvent, overlapLevels } from "../../shared/domain.js";
test("workload uses a blue progression from pale sky to deep indigo", () => {
  const palette = [1, 2, 3, 5, 8].map(energyForCount);
  assert.deepEqual(
    palette.map((c) => c.label),
    ["从容", "充实", "较忙", "繁忙", "高负荷"],
  );
  const hues = palette.map((c) => c.h);
  for (let i = 0; i < hues.length; i++) {
    assert.ok(hues[i] >= 195 && hues[i] <= 250, `hue ${hues[i]}`);
    if (i) {
      assert.ok(hues[i] > hues[i - 1], "hues strictly increase");
      assert.ok(palette[i].l < palette[i - 1].l, "lightness strictly decreases");
    }
  }
  assert.equal(new Set(palette.map((c) => c.gradient)).size, 5);
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
