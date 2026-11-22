// Calm Rhine-Lab-style leader-line annotations around the dial: a small dot
// on the rim, a 1px line out to a mono label. Lines/dots are SVG; labels are
// HTML so they can host rolling numbers and rich text.
import { dialPoint } from "../lib/geometry.js";

const M = 60; // viewBox margin around the 300-unit dial space
const BOX = 300 + 2 * M;
const R_ANCHOR = 141;
const pct = (v) => `${(((v + M) / BOX) * 100).toFixed(3)}%`;

export function Callouts({ items, hover }) {
  const all = [...items];
  if (hover) all.push({ ...hover, temp: true });
  return (
    <div className="callouts" aria-hidden="true">
      <svg viewBox={`${-M} ${-M} ${BOX} ${BOX}`}>
        {all.map((item, i) => {
          const [ax, ay] = dialPoint(R_ANCHOR + 4, item.minutes);
          const side = item.side ?? (ax >= 150 ? 1 : -1);
          const len = item.len ?? 46;
          const ex = ax + side * len;
          const ey = ay + (item.lift ?? 0);
          return (
            <g key={item.key ?? i} className="callout" data-temp={item.temp || undefined}>
              <circle className="callout-dot" cx={ax} cy={ay} r="2.2" />
              <line className="callout-line" x1={ax} y1={ay} x2={ex} y2={ey} />
            </g>
          );
        })}
      </svg>
      {all.map((item, i) => {
        const [ax, ay] = dialPoint(R_ANCHOR + 4, item.minutes);
        const side = item.side ?? (ax >= 150 ? 1 : -1);
        const len = item.len ?? 46;
        const ex = ax + side * len;
        const ey = ay + (item.lift ?? 0);
        return (
          <span
            key={item.key ?? i}
            className="callout-label mono"
            data-side={side > 0 ? "right" : "left"}
            data-temp={item.temp || undefined}
            style={{ left: pct(ex + side * 7), top: pct(ey) }}
          >
            {item.title && <b>{item.title} </b>}
            {item.label}
          </span>
        );
      })}
    </div>
  );
}
