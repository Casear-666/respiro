// Editorial HUD: corner registration marks, thin frame rules, a live clock,
// and mono readouts flanking the dial — the observatory chrome.
import { useEffect, useState } from "react";
import { RollingText } from "./RollingNumber.jsx";

const WEEK_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function HudFrame({ day, date, dayIndex, info, visible, frameIn = visible }) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(clock.getHours())}:${pad(clock.getMinutes())}:${pad(clock.getSeconds())}`;
  const serial = `EC-TIDE-${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  const fill = Math.round(
    Math.min(0.78, 0.16 + 0.62 * info.load + (info.level === 3 ? 0.1 : 0)) * 100,
  );
  const wave = (0.12 + 0.5 * info.load).toFixed(2);
  const busy = `${Math.floor(info.minutes / 60)}H${String(info.minutes % 60).padStart(2, "0")}M`;

  return (
    <div className="hud" aria-hidden="true">
      {/* frame marks draw in early so the boot mid-frame reads as assembly */}
      <div className="hud-frame-marks" style={{ opacity: frameIn }}>
        <i className="hud-corner tl" />
        <i className="hud-corner tr" />
        <i className="hud-corner bl" />
        <i className="hud-corner br" />
        <div className="hud-rule top" />
        <div className="hud-rule bottom" />
      </div>
      <div className="hud-readouts" style={{ opacity: visible }}>

      <div className="hud-readout hud-top-left mono">
        <RollingText text={time} duration={320} className="hud-clock" />
        <span className="hud-tag">{serial}</span>
      </div>
      <div className="hud-readout hud-top-right mono">
        <span className="hud-tag">SECTION {String(dayIndex + 1).padStart(2, "0")}/07 · {WEEK_EN[date.getDay()]}</span>
      </div>
      <div className="hud-readout hud-left mono">
        <span><em>潮位</em> LEVEL <RollingText text={`${fill}%`} /></span>
        <span><em>波高</em> WAVE <RollingText text={wave} /></span>
      </div>
      <div className="hud-readout hud-right mono">
        <span><em>占用</em> BUSY <RollingText text={busy} /></span>
        <span><em>事项</em> ITEMS <RollingText text={String(info.count).padStart(2, "0")} /></span>
      </div>
      <div className="hud-readout hud-bottom mono">
        <span className="hud-tag">让时间，留有余地。</span>
      </div>
      </div>
    </div>
  );
}
