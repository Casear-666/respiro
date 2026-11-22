// Dial geometry shared by the GL canvas, the SVG rim and hit-testing.
// 0:00 sits at the top; minutes advance clockwise, matching src/planner/DayDial.
export const MINUTES_PER_DAY = 1440;
export const SNAP_MINUTES = 15;

// minutes -> clockwise angle in radians measured from 12 o'clock.
export const minutesToAngle = (minutes) =>
  ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY * Math.PI / 720;

// minutes -> turn fraction in [0,1), the unit the GL pulse uniforms use.
export const minutesToTurn = (minutes) =>
  (((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / MINUTES_PER_DAY;

// Point on a circle of `radius` centred at (cx, cy), screen coordinates (y down).
export function dialPoint(radius, minutes, cx = 150, cy = 150) {
  const a = minutesToAngle(minutes);
  return [cx + radius * Math.sin(a), cy - radius * Math.cos(a)];
}

// Inverse of dialPoint: pointer position -> minutes in [0,1440).
export function angleToMinutes(x, y, cx = 150, cy = 150) {
  const a = Math.atan2(x - cx, cy - y); // swapped axes: 0 = up, clockwise positive
  const minutes = (a / Math.PI) * 720;
  return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

// Snap minutes to the nearest `step`, wrapping around midnight.
export function snapMinutes(minutes, step = SNAP_MINUTES) {
  const snapped = Math.round(minutes / step) * step;
  return ((snapped % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

// Shortest signed minute difference from `a` to `b` across midnight, in (-720, 720].
export function minuteDelta(from, to) {
  let d = to - from;
  while (d > MINUTES_PER_DAY / 2) d -= MINUTES_PER_DAY;
  while (d <= -MINUTES_PER_DAY / 2) d += MINUTES_PER_DAY;
  return d;
}

// Greedy lane packing for overlapping arcs, same rule as DayDial:
// arcs sorted by start; each takes the first lane whose occupant has ended.
export function assignLanes(arcs) {
  const lanes = [];
  const sorted = [...arcs].sort((a, b) => a.from - b.from || a.length - b.length);
  const placed = new Map();
  for (const arc of sorted) {
    const until = arc.from + arc.length;
    let lane = lanes.findIndex((end) => end <= arc.from);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = until;
    placed.set(arc, lane);
  }
  return {
    laneOf: (arc) => placed.get(arc) ?? 0,
    laneCount: Math.max(1, lanes.length),
  };
}
