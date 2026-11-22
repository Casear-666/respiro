// The tide dial: a WebGL2 glass disc holding liquid (level/turbulence = day
// load) under a crisp SVG rim carrying the 24h event arcs — the same rim
// geometry as src/planner/DayDial (OUTER 141 / BAND 38 on a 300 viewBox).
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import { categoryOf, formatTime } from "../../../shared/domain.js";
import { createTide } from "../gl/tide.js";
import { makeSpring, makeSpring2 } from "../lib/springs.js";
import {
  angleToMinutes,
  assignLanes,
  dialPoint,
  minuteDelta,
  minutesToTurn,
  snapMinutes,
} from "../lib/geometry.js";
import { RollingText } from "./RollingNumber.jsx";

const OUTER = 141;
const BAND = 38;
const GAP = 3;
const safeId = (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, "_");

function arcPath(radius, start, length) {
  const at = (m) => dialPoint(radius, m).join(" ");
  const arc = `A ${radius} ${radius} 0 0 1`;
  return `M ${at(start)} ${arc} ${at(start + length / 2)} ${arc} ${at(start + length)}`;
}
const arcEnd = (radius, from, length) =>
  dialPoint(radius, from + (length >= 720 ? length / 2 : length));

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeOutBack = (x) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

function hsl(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export const TideDial = forwardRef(function TideDial(
  {
    arcs,
    day,
    isToday,
    nowMinutes,
    bootT, // null when the briefing has finished (or is skipped)
    targets, // {load, energy:{h,s,l}, dark, overload, focus, focusRemain}
    reduced,
    focusEvent,
    hoverId,
    onHover,
    onToggle,
    onDelete,
    onQuickAdd,
    onMove,
    onPointerPage,
  },
  ref,
) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const tideRef = useRef(null);
  const tiltRef = useRef(null);
  const targetRef = useRef(targets);
  targetRef.current = targets;
  const bootTRef = useRef(bootT);
  bootTRef.current = bootT;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const [glOk, setGlOk] = useState(true);
  const [drag, setDrag] = useState(null); // {id, from}
  const dragRef = useRef(null);

  const { laneOf, laneCount } = useMemo(() => assignLanes(arcs), [arcs]);
  const laneGap = 2.5;
  const laneW = Math.min(6.5, (BAND - (laneCount - 1) * laneGap) / laneCount);
  const laneRadius = (lane) => OUTER - laneW / 2 - lane * (laneW + laneGap);

  useImperativeHandle(ref, () => ({
    pulse(minutes) {
      tideRef.current?.addPulse(minutesToTurn(minutes));
    },
    ripple(minutes, strength = 1) {
      const x = Math.sin((minutes / 720) * Math.PI) * 0.8;
      tideRef.current?.addRipple(Math.max(-0.9, Math.min(0.9, x)), strength);
    },
  }));

  // ── GL loop ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const tide = createTide(canvas);
    tideRef.current = tide;
    if (!tide) {
      setGlOk(false);
      return;
    }
    setGlOk(true);

    const loadS = makeSpring(0, { stiffness: 34 });
    const focusS = makeSpring(0, { stiffness: 30 });
    const surgeS = makeSpring(0, { stiffness: 22 });
    let glitchStart = -1; // rAF-time stamp of the surge-entry glitch
    const darkS = makeSpring(0, { stiffness: 30 });
    const revealS = makeSpring(0, { stiffness: 40 });
    const tiltS = makeSpring2(0, 0, { stiffness: 26, damping: 7 });
    const levelS = makeSpring(0, { stiffness: 46, damping: 12 }); // slight slosh
    const ampS = makeSpring(0, { stiffness: 40 });
    const lightS = makeSpring2(-0.42, 0.46, { stiffness: 40, damping: 14 });
    let prevSurge = 0;
    let wipeT = 1; // day-switch wipe envelope 0..1
    let lastDay = null;
    let warmed = false; // first frame snaps springs to targets (deterministic paint)

    let px = null;
    let py = null;
    let pt = 0;
    const onMove = (e) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      lightS.set(Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny)));
      const now = performance.now();
      const dt = Math.max(16, now - pt) / 1000;
      pt = now;
      if (px != null) {
        const vx = (nx - px) / dt;
        const vy = (ny - py) / dt;
        // slosh follows pointer velocity, eased back to the parallax tilt
        tiltS.set(
          Math.max(-0.6, Math.min(0.6, nx * 0.12 + vx * 0.05)),
          Math.max(-0.6, Math.min(0.6, vy * 0.05)),
        );
      }
      px = nx;
      py = ny;
      if (tiltRef.current && !reducedRef.current) {
        tiltRef.current.style.transform = `rotateX(${(-ny * 6).toFixed(2)}deg) rotateY(${(nx * 6).toFixed(2)}deg)`;
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    let raf = 0;
    let last = performance.now();
    const frame = (t) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      if (document.hidden) return;
      const trg = targetRef.current;
      const boot = bootTRef.current;
      const quiet = reducedRef.current;

      loadS.target = trg.load;
      focusS.target = trg.focus;
      surgeS.target = trg.surge;
      darkS.target = trg.dark;
      // day change: drain the level briefly while a wipe passes (the first
      // dayKey is the initial mount — not a user switch — so no wipe)
      if (trg.dayKey !== lastDay) {
        const fresh = lastDay == null;
        lastDay = trg.dayKey;
        if (!fresh) wipeT = 0;
      }
      wipeT = Math.min(1, wipeT + dt / 0.8);
      const wipeDrain = 1 - 0.75 * Math.sin(Math.PI * Math.min(1, wipeT));
      // surge entry: a brief glitch/scan, timed against the rAF clock so it
      // decays correctly even when frames are sparse (headless captures)
      if (surgeS.target > 0.5 && prevSurge <= 0.5) glitchStart = t;
      prevSurge = surgeS.target;
      const glitch = glitchStart < 0 ? 0 : Math.max(0, 1 - (t - glitchStart) / 900);
      // boot: glass materializes ~2.4s in, liquid pours 2.6–3.4 then settles
      const reveal = boot == null ? 1 : clamp01((boot - 2.4) / 0.55);
      const pour = boot == null ? 1 : clamp01((boot - 2.6) / 0.8);
      revealS.target = reveal;
      loadS.step(dt);
      focusS.step(dt);
      surgeS.step(dt);
      darkS.step(dt);
      revealS.step(dt);
      const [tx, ty] = tiltS.step(dt);
      const [lx, ly] = [lightS.sx.step(dt), lightS.sy.step(dt)];

      // First frame: settle every spring instantly so the initial paint is
      // already the steady state (also makes headless screenshots exact).
      if (!warmed) {
        warmed = true;
        loadS.snap(trg.load);
        focusS.snap(trg.focus);
        surgeS.snap(trg.surge);
        darkS.snap(trg.dark);
        revealS.snap(reveal);
        levelS.snap(
          Math.min(0.78, 0.16 + 0.62 * trg.load + trg.surge * 0.10) *
            (trg.focus > 0.5 ? 0.82 : 1) * pour,
        );
        ampS.snap(quiet ? 0 : 0.012 + 0.05 * trg.load + trg.surge * 0.04);
      }
      const load = loadS.value;
      const surge = surgeS.value;
      levelS.target =
        Math.min(0.78, 0.16 + 0.62 * load + surge * 0.10) * (trg.focus > 0.5 ? 0.82 : 1) * pour * wipeDrain;
      ampS.target = quiet
        ? 0
        : Math.max(0.004, (0.012 + 0.05 * load + surge * 0.045) * (1 - focusS.value * 0.88));
      levelS.step(dt);
      ampS.step(dt);

      document.documentElement.style.setProperty("--load", load.toFixed(4));
      document.documentElement.style.setProperty("--surge", surge.toFixed(4));

      const energy = trg.energy;
      const low = hsl(energy.h, Math.min(96, energy.s + 10), Math.min(80, energy.l + 9));
      const high = hsl(energy.h, Math.min(96, energy.s + 4), Math.max(8, energy.l - 12));
      tide.resize();
      tide.frame(dt, {
        center: [canvas.clientWidth / 2, canvas.clientHeight / 2],
        radius: (canvas.clientWidth / 2) * 0.735, // glass edge under the arcs
        level: levelS.value,
        waveAmp: quiet ? 0.006 : ampS.value + (revealS.value < 1 ? 0.05 * (1 - revealS.value) : 0),
        tilt: quiet ? [0, 0] : [tx, ty],
        light: [lx, ly],
        colorLow: low,
        colorHigh: high,
        dark: darkS.value,
        reveal: revealS.value,
        surge,
        glitch: quiet ? 0 : glitch,
        pour: boot == null ? 0 : pour < 1 ? pour : 0,
        focus: focusS.value,
      });
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      tide.destroy();
      tideRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── pointer → dial minutes ───────────────────────────────────────
  const svgRef = useRef(null);
  const minutesAt = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 300;
    const y = ((e.clientY - rect.top) / rect.height) * 300;
    return angleToMinutes(x, y);
  };

  const startDrag = (arc, e) => {
    if (e.button !== 0 || dragRef.current) return;
    e.preventDefault();
    const grab = minutesAt(e);
    dragRef.current = {
      id: arc.event.id,
      grab,
      from: arc.from,
      length: arc.length,
      last: arc.from,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const delta = minuteDelta(d.grab, minutesAt(e));
    let from = snapMinutes(d.from + delta);
    from = Math.max(0, Math.min(1440 - Math.max(15, d.length), from));
    if (from !== d.last) {
      d.last = from;
      setDrag({ id: d.id, from });
      onPointerPage?.("tick"); // soft tick per snap step
    }
  };
  const endDrag = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (d && d.last !== d.from) onMove(d.id, d.last, d.length);
  };
  useEffect(() => {
    const cancel = (e) => {
      if (e.key === "Escape" && dragRef.current) {
        dragRef.current = null;
        setDrag(null);
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);

  // ── derived rim geometry ─────────────────────────────────────────
  const booted = bootT == null;
  const trackDraw = booted ? 1 : clamp01((bootT - 2.2) / 0.9);
  const tickDraw = booted ? 1 : clamp01((bootT - 2.4) / 0.8);
  const arcsIn = booted || bootT >= 3.4;
  const isDragging = (arc) => drag?.id === arc.event.id;
  const arcFrom = (arc) => (isDragging(arc) ? drag.from : arc.from);
  const displayArcs = arcs.map((arc) => ({ ...arc, from: arcFrom(arc) }));

  const nowShown = useMemo(() => {
    if (!isToday) return null;
    if (booted) return nowMinutes;
    const p = clamp01((bootT - 4.4) / 0.6);
    return p <= 0 ? null : nowMinutes * easeOutBack(p);
  }, [booted, bootT, isToday, nowMinutes]);

  const focusProgress = useMemo(() => {
    if (!focusEvent) return null;
    const arc = displayArcs.find((a) => a.event.id === focusEvent.id);
    if (!arc) return null;
    const total = arc.length;
    // session countdown: progress follows elapsed session time, not the clock
    const elapsedMin = (targets.focusElapsed ?? 0) / 60;
    return { radius: laneRadius(laneOf(arc)), from: arc.from, length: total * clamp01(elapsedMin / total), total };
  }, [focusEvent, displayArcs, laneOf, laneRadius, targets.focusElapsed]);

  const enter = (i) => ({
    duration: reduced ? 0 : 0.34,
    delay: reduced ? 0 : i * 0.09,
    ease: [0.22, 1, 0.36, 1],
  });
  const leave = { duration: reduced ? 0 : 0.2, ease: [0.4, 0, 1, 1] };

  return (
    <div className="tide-dial" ref={wrapRef} data-gl={glOk ? "on" : "off"}>
      <div className="tide-tilt" ref={tiltRef}>
        <canvas ref={canvasRef} className="tide-gl" aria-hidden="true" />
        <svg
          ref={svgRef}
          className="tide-svg"
          viewBox="0 0 300 300"
          role="group"
          aria-label="24 小时日程表盘"
        >
          <defs>
            {displayArcs.map((arc) => {
              const radius = laneRadius(laneOf(arc));
              const [sx, sy] = dialPoint(radius, arc.from);
              const [ex, ey] = arcEnd(radius, arc.from, arc.length);
              const base = categoryOf(arc.event).color;
              return (
                <linearGradient
                  key={safeId(arc.event.id)}
                  id={`tg-${uid}-${safeId(arc.event.id)}`}
                  gradientUnits="userSpaceOnUse"
                  x1={sx}
                  y1={sy}
                  x2={ex}
                  y2={ey}
                >
                  <stop offset="0" stopColor={base} />
                  <stop offset="1" stopColor={`color-mix(in oklch, ${base} 70%, white)`} />
                </linearGradient>
              );
            })}
          </defs>

          {/* empty-rim hit ring for quick-add */}
          <circle
            cx="150"
            cy="150"
            r={OUTER - BAND / 2}
            fill="none"
            stroke="transparent"
            strokeWidth={BAND + 6}
            className="tide-hit"
            onClick={(e) => onQuickAdd(snapMinutes(minutesAt(e)))}
          />

          {/* lane tracks: hairline rings drawn clockwise during the briefing */}
          {Array.from({ length: laneCount }, (_, lane) => (
            <circle
              key={lane}
              className="tide-track"
              cx="150"
              cy="150"
              r={laneRadius(lane)}
              fill="none"
              strokeWidth="1.1"
              pathLength="1"
              strokeDasharray={`${trackDraw} 1`}
              transform="rotate(-90 150 150)"
            />
          ))}

          {/* 96 fine 15-minute ticks, every 3h longer, popping in clockwise */}
          {Array.from({ length: 96 }, (_, i) => {
            const hour = i % 12 === 0;
            const quarter = i % 4 === 0;
            const [x1, y1] = dialPoint(hour ? 93 : quarter ? 95 : 97, i * 15);
            const [x2, y2] = dialPoint(hour ? 103.5 : 102, i * 15);
            const pop = booted ? 1 : clamp01(tickDraw * 96 - i);
            return (
              <line
                key={i}
                className={hour ? "tide-tick hour" : quarter ? "tide-tick quarter" : "tide-tick"}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                style={{ opacity: hour ? pop : pop * 0.8 }}
              />
            );
          })}
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => {
            const [x, y] = dialPoint(84, h * 60);
            return (
              <text key={h} x={x} y={y} textAnchor="middle" dominantBaseline="central" className="tide-hour" style={{ opacity: trackDraw }}>
                {String(h).padStart(2, "0")}
              </text>
            );
          })}

          {/* event arcs */}
          <AnimatePresence initial={false}>
            {arcsIn &&
              displayArcs.map((arc, i) => {
                const radius = laneRadius(laneOf(arc));
                const aw = laneW;
                const pxPerMin = (2 * Math.PI * radius) / 1440;
                // a minimum span keeps short events reading as arcs, not pills
                const span = Math.max(arc.length, 10);
                const inset = arc.length >= 1440 ? 0 : Math.min(span / 3, aw / (2 * pxPerMin));
                const d = arcPath(radius, arc.from + inset, span - 2 * inset);
                const [ex2, ey2] = arcEnd(radius, arc.from + inset, span - 2 * inset);
                const dim = (hoverId && hoverId !== arc.event.id) || (focusEvent && focusEvent.id !== arc.event.id);
                const past = isToday && !arc.event.completed && arc.from + arc.length < nowMinutes;
                return (
                  <g key={arc.event.id}>
                    <motion.path
                      d={d}
                      fill="none"
                      strokeLinecap="round"
                      strokeWidth={laneW}
                      className="tide-arc-gap"
                      initial={reduced || booted ? false : { pathLength: 0, opacity: 0 }}
                      animate={{ pathLength: 1, opacity: 1 }}
                      exit={{ pathLength: 0, opacity: 0, transition: leave }}
                      transition={enter(i)}
                      style={{ pointerEvents: "none" }}
                    />
                    <motion.path
                      d={d}
                      fill="none"
                      strokeLinecap="round"
                      stroke={`url(#tg-${uid}-${safeId(arc.event.id)})`}
                      strokeWidth={aw}
                      className="tide-arc"
                      data-done={arc.event.completed || undefined}
                      data-past={past || undefined}
                      data-drag={isDragging(arc) || undefined}
                      initial={reduced || booted ? false : { pathLength: 0, opacity: 0 }}
                      animate={{ pathLength: 1, opacity: dim ? 0.28 : past ? 0.45 : 1 }}
                      exit={{ pathLength: 0, opacity: 0, transition: leave }}
                      transition={enter(i)}
                      tabIndex={0}
                      role="button"
                      aria-label={`${arc.event.title} ${formatTime(arc.event.start)}，回车切换完成`}
                      onPointerEnter={() => onHover(arc.event.id)}
                      onPointerLeave={() => onHover(null)}
                      onFocus={() => onHover(arc.event.id)}
                      onBlur={() => onHover(null)}
                      onPointerDown={(e) => startDrag(arc, e)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onClick={(e) => {
                        if (dragRef.current == null || Math.abs((drag?.from ?? arc.from) - arc.from) < 1)
                          onToggle(arc.event.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onToggle(arc.event.id);
                        }
                        if (e.key === "Delete" || e.key === "Backspace") onDelete(arc.event.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        onDelete(arc.event.id);
                      }}
                    >
                      <title>{`${arc.event.title} · 左键完成，拖动改期，右键删除`}</title>
                    </motion.path>
                    {arc.event.completed &&
                      (() => {
                        const s = Math.min(9, laneW * 1.6);
                        return (
                          <g className="tide-check" transform={`translate(${ex2 - s / 2} ${ey2 - s / 2})`}>
                            <Check size={s} strokeWidth={3} />
                          </g>
                        );
                      })()}
                  </g>
                );
              })}
          </AnimatePresence>

          {/* focus progress ring */}
          {focusProgress && (
            <path
              className="tide-progress"
              d={arcPath(focusProgress.radius, focusProgress.from, Math.max(0.5, focusProgress.length))}
              fill="none"
              strokeLinecap="round"
              strokeWidth={laneW}
            />
          )}

          {/* now hand */}
          {nowShown != null && (
            <g className="tide-now" pointerEvents="none">
              {(() => {
                const [x1, y1] = dialPoint(OUTER - BAND, nowShown);
                const [x2, y2] = dialPoint(OUTER + 2, nowShown);
                const [dx, dy] = dialPoint(146, nowShown);
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

        {/* centre overlay: focus countdown */}
        {focusEvent && (
          <div className="tide-count" aria-live="off">
            <RollingText text={targets.focusRemain ?? "00:00"} duration={400} className="tide-count-num" />
            <small>{focusEvent.title}</small>
          </div>
        )}
      </div>
    </div>
  );
});
