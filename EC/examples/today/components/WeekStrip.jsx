// Week strip: seven capsules, each a mini liquid tube filled to that day's
// load with its energy colour. Click switches the dial's day.
import { energyForCount } from "../../../shared/energy.js";
import { RollingNumber } from "./RollingNumber.jsx";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

export function WeekStrip({ days, loads, selected, onSelect }) {
  return (
    <div className="week-strip" role="tablist" aria-label="本周">
      {days.map((day, i) => {
        const l = loads.get(day);
        const load = l?.load ?? 0;
        const energy = energyForCount(Math.max(1, l?.count ?? 1));
        const active = day === selected;
        return (
          <button
            key={day}
            type="button"
            role="tab"
            aria-selected={active}
            className="capsule"
            data-active={active || undefined}
            data-surge={(l?.level ?? 0) >= 3 || undefined}
            data-empty={(l?.count ?? 0) === 0 || undefined}
            onClick={() => onSelect(day)}
            title={`${day} · ${l?.label ?? ""}`}
          >
            <span className="cap-tube">
              <span
                className="cap-fill"
                style={{
                  height: `${8 + load * 84}%`,
                  background: energy.gradient,
                }}
              />
            </span>
            <span className="cap-day">{WEEK[i]}</span>
            <span className="cap-count">
              <RollingNumber value={l?.count ?? 0} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
