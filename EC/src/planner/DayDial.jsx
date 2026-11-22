import { createContext, useContext, useEffect, useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight, Plus } from "lucide-react";
import { addDays, categoryOf, dateKey, eventCognitiveInfo, eventOnDay, formatTime, localDate } from "../../shared/domain";

export const DialContext =
  globalThis.__EC_DIAL_CONTEXT__ ??
  (globalThis.__EC_DIAL_CONTEXT__ = createContext(null));
export const dialViews = {
  energyDial: {
    duration: { days: 1 },
    content: ({ dateProfile }) => (
      <DayDial key={+dateProfile.currentRange.start} day={dateProfile.currentRange.start.toISOString().slice(0, 10)} />
    ),
  },
};

const OUTER = 141, BAND = 38, GAP = 3;
const safeGradId = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "_");

function point(radius, minutes) {
  const angle = minutes * Math.PI / 720;
  return [150 + radius * Math.sin(angle), 150 - radius * Math.cos(angle)];
}

// Two segments also describe a full 24-hour circle, whose endpoints coincide.
function arcPath(radius, start, length) {
  const at = minutes => point(radius, minutes).join(" ");
  const arc = `A ${radius} ${radius} 0 0 1`;
  return `M ${at(start)} ${arc} ${at(start + length / 2)} ${arc} ${at(start + length)}`;
}

// A point on the arc used as the gradient's far end; long arcs fade toward
// their midpoint so the highlight stays near the start cap.
function arcEnd(radius, from, length) {
  const span = length >= 720 ? length / 2 : length;
  return point(radius, from + span);
}

export function DayDial({ day, legend }) {
  const ctx = useContext(DialContext) || globalThis.__EC_DIAL_STATE__ || {};
  const { events = [], onEdit, onCreate, onDelete, aiWeights, energyMode } = ctx;
  const [hover, setHover] = useState(null);
  const [focus, setFocus] = useState(null);
  const [nowMinute, setNowMinute] = useState(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  });
  const reduced = useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const start = localDate(day);
  const end = addDays(start, 1);
  const isToday = dateKey(start) === dateKey(new Date());
  useEffect(() => {
    if (!isToday) return;
    const timer = setInterval(() => {
      const d = new Date();
      setNowMinute(d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60);
    }, 30000);
    return () => clearInterval(timer);
  }, [isToday]);
  const entries = events.filter(event => eventOnDay(event, day))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || localDate(a.start) - localDate(b.start));
  const timed = entries.filter(event => !event.allDay);
  let coveredUntil = +start, busy = 0;
  const lanes = [];
  const arcs = timed.map(event => {
    const from = Math.max(+start, +localDate(event.start));
    const to = Math.min(+end, +localDate(event.end));
    busy += Math.max(0, to - Math.max(from, coveredUntil));
    coveredUntil = Math.max(coveredUntil, to);
    let lane = lanes.findIndex(until => until <= from);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = to;
    // The dial follows local clock labels, including on daylight-saving changes.
    const minute = stamp => {
      if (stamp === +end) return 1440;
      const date = new Date(stamp);
      return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
    };
    return { event, lane, from: minute(from), length: Math.max(1, minute(to) - minute(from)) };
  });
  const laneCount = Math.max(1, lanes.length);
  const laneGap = Math.min(GAP, BAND / (laneCount * 3));
  const w = Math.min(26, (BAND - (laneCount - 1) * laneGap) / laneCount);
  const laneRadius = lane => OUTER - w / 2 - lane * (w + laneGap);
  const minutes = Math.round(busy / 60000);
  const active = entries.find(event => event.id === (hover ?? focus));
  const showCog = energyMode === "cognitive" || Boolean(aiWeights && Object.keys(aiWeights).length);
  const activeCog = active && showCog ? eventCognitiveInfo(active, aiWeights) : null;
  const range = event => event.allDay ? "全天" :
    (localDate(event.start) < start ? "00:00" : formatTime(event.start)) + "–" +
    (localDate(event.end) >= end ? "24:00" : formatTime(event.end));
  const ink = event => {
    const category = categoryOf(event);
    return `var(--dial-${category.id}, ${category.color})`;
  };
  const enter = { duration: reduced ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] };
  const leave = { duration: reduced ? 0 : 0.21, ease: [0.4, 0, 1, 1] };
  const edit = (event, element) => onEdit?.(event.id, element.getBoundingClientRect());
  const remove = (event, e) => {
    if (!onDelete || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    setHover((cur) => (cur === event.id ? null : cur));
    setFocus((cur) => (cur === event.id ? null : cur));
    onDelete(event.id);
  };
  const create = element => {
    const from = localDate(day);
    from.setHours(9);
    onCreate({ start: from, end: new Date(+from + 3600000), allDay: false, rect: element.getBoundingClientRect() });
  };
  // The ends open at different speeds and meet between 18 and 21.
  const labelDelays = [180, 305, 395, 470, 550, 650, 795, 710];
  const revealId = `dial-reveal-${uid}`;
  return (
    <section className="day-dial" aria-label="昼夜表盘">
      <div className="dial-instrument">
      <div className="dial-face">
        <svg className="dial-plot" viewBox="0 0 300 300" aria-label="24 小时日程分布">
          <defs>
            {/* Ticks and event lanes follow the two moving ends of the track. */}
            <mask id={revealId} maskUnits="userSpaceOnUse" x="0" y="0" width="300" height="300">
              <path className="dial-reveal-stroke" d={arcPath(112, 0, 1440)} fill="none"
                stroke="white" strokeWidth="100" pathLength="1" />
            </mask>
            {arcs.map(({ event, lane, from, length }) => {
              const radius = laneRadius(lane);
              const [sx, sy] = point(radius, from);
              const [ex, ey] = arcEnd(radius, from, length);
              const base = categoryOf(event).color;
              const id = `dialg-${uid}-${safeGradId(event.id)}`;
              return (
                <linearGradient key={id} id={id} gradientUnits="userSpaceOnUse" x1={sx} y1={sy} x2={ex} y2={ey}>
                  <stop offset="0" style={{ stopColor: base }} />
                  <stop offset="1" style={{ stopColor: `color-mix(in oklch, ${base} 72%, white)` }} />
                </linearGradient>
              );
            })}
          </defs>
          {Array.from({ length: laneCount }, (_, lane) => (
            <circle key={lane} className="dial-track" cx="150" cy="150" r={laneRadius(lane)} fill="none"
              strokeWidth={w} pathLength="1" strokeLinecap="round"
              transform="rotate(-90 150 150)" />
          ))}
          <g mask={`url(#${revealId})`}>
          {Array.from({ length: 24 }, (_, hour) => hour).filter((hour) => hour % 3 !== 0).map((hour) => {
            const [x, y] = point(96, hour * 60);
            return <circle key={hour} className="dial-tick" cx={x} cy={y} r="1" />;
          })}
          <AnimatePresence initial={false}>
            {arcs.map(({ event, lane, from, length }) => {
              const radius = laneRadius(lane);
              const aw = w - Math.min(4, w * 0.25);
              const pixelsPerMinute = 2 * Math.PI * radius / 1440;
              const inset = length >= 1440 ? 0 : Math.min(length / 3, aw / (2 * pixelsPerMinute));
              const d = arcPath(radius, from + inset, length - 2 * inset);
              const gid = `dialg-${uid}-${safeGradId(event.id)}`;
              return (
                <g key={event.id} onContextMenu={e => remove(event, e)}>
                  <motion.path d={d} fill="none" strokeLinecap="round"
                    strokeWidth={w} className="dial-arc-gap"
                    initial={reduced ? false : { pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    exit={{ pathLength: 0, opacity: 0, pointerEvents: "none", transition: leave }}
                    transition={enter}
                    style={{ pointerEvents: "none" }} />
                  <motion.path d={d} fill="none" strokeLinecap="round"
                    stroke={`url(#${gid})`} strokeWidth={aw} className="dial-arc"
                    initial={reduced ? false : { pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: active && active.id !== event.id ? 0.32 : 1 }}
                    exit={{ pathLength: 0, opacity: 0, pointerEvents: "none", transition: leave }}
                    transition={enter}
                    onPointerEnter={() => setHover(event.id)} onPointerLeave={() => setHover(null)}
                    onClick={e => edit(event, e.currentTarget)}
                    onContextMenu={e => remove(event, e)}>
                    <title>{event.title} · {range(event)}{onDelete ? " · 左键编辑，右键删除" : ""}</title>
                  </motion.path>
                </g>
              );
            })}
          </AnimatePresence>
          </g>
          {labelDelays.map((delay, index) => {
            const hour = index * 3;
            const [x, y] = point(84, hour * 60);
            const major = hour % 6 === 0;
            return <text key={hour} x={x} y={y} textAnchor="middle" dominantBaseline="central"
              className={major ? "dial-hour" : "dial-hour-minor"} style={{ "--dial-label-delay": `${delay}ms` }}>
              {String(hour).padStart(2, "0")}
            </text>;
          })}
          {isToday && nowMinute >= 0 && nowMinute <= 1440 && (
            <g className="dial-now" pointerEvents="none">
              {(() => {
                const [x1, y1] = point(OUTER - BAND, nowMinute);
                const [x2, y2] = point(OUTER, nowMinute);
                const [dx, dy] = point(146, nowMinute);
                return (
                  <>
                    <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth="2" strokeLinecap="round" />
                    <circle cx={dx} cy={dy} r="3" />
                  </>
                );
              })()}
            </g>
          )}
        </svg>
        <div className="dial-center">
          <small>{active ? range(active) : "已安排"}</small>
          {active ? (
            <>
              <b>{active.title}</b>
              {activeCog && (
                <span className="dial-center-cog" data-score={activeCog.score}>
                  {activeCog.label}
                </span>
              )}
            </>
          ) : (
            <strong>{Math.floor(minutes / 60)}<small>时</small>{minutes % 60}<small>分</small></strong>
          )}
        </div>
      </div>
      {legend}
      </div>
      <div className="dial-agenda">
        <header><h3>当日安排 <small>{entries.length} 项</small></h3>
          {onCreate && <button className="dial-add" type="button" onClick={e => create(e.currentTarget)}><Plus size={15} /> 添加日程</button>}
        </header>
        <ul>
          <AnimatePresence initial={false} mode="popLayout">
            {!entries.length && <motion.li key="empty" className="dial-empty" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={leave}>今天留白</motion.li>}
            {entries.map(event => {
              const cog = showCog ? eventCognitiveInfo(event, aiWeights) : null;
              return (
              <motion.li key={event.id} layout={reduced ? false : "position"} initial={{ opacity: 0, y: reduced ? 0 : 8 }}
                animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: reduced ? 0 : 14, pointerEvents: "none", transition: leave }} transition={enter}
                onContextMenu={e => remove(event, e)}>
                <button type="button" className="dial-entry" data-active={active?.id === event.id}
                  title={onDelete ? "左键编辑，右键删除" : undefined}
                  onPointerEnter={() => setHover(event.id)} onPointerLeave={() => setHover(null)}
                  onFocus={() => setFocus(event.id)} onBlur={() => setFocus(null)}
                  onClick={e => edit(event, e.currentTarget)}
                  onContextMenu={e => remove(event, e)}>
                  <i style={{background: ink(event)}} /><span className="dial-entry-copy"><b>{event.title}</b><time>{range(event)}</time></span>
                  {cog && (
                    <span className="cog-badge" data-score={cog.score} title={`认知耗能：${cog.label}`}>
                      {cog.level.short}
                    </span>
                  )}
                  {event.completed && <small>已完成</small>}<ChevronRight className="dial-chevron" size={14} aria-hidden="true" />
                </button>
              </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      </div>
    </section>
  );
}
