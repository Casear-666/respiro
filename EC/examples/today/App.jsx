import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Moon, RotateCcw, Sun, Volume2, VolumeX } from "lucide-react";
import {
  addDays,
  dateKey,
  eventCognitiveInfo,
  formatTime,
  localDate,
} from "../../shared/domain.js";
import { loadOf, minutesToText, moodSentence, dayArcs, wrapSummary, overlappingItems } from "./lib/load.js";
import { sampleWeek, weekDays } from "./lib/sample.js";
import { focusCandidate, initState, reducer, shiftDay } from "./lib/state.js";
import * as audio from "./lib/audio.js";
import { TideDial } from "./components/TideDial.jsx";
import { Callouts } from "./components/Callouts.jsx";
import { Timeline } from "./components/Timeline.jsx";
import { WeekStrip } from "./components/WeekStrip.jsx";
import { Toast } from "./components/Toast.jsx";
import { WrapCard } from "./components/WrapCard.jsx";
import { FocusHint } from "./components/FocusOverlay.jsx";
import { BootLayer } from "./components/BootLayer.jsx";
import { HudFrame } from "./components/HudFrame.jsx";
import { WarningPlate } from "./components/WarningPlate.jsx";
import { RollingNumber, RollingText } from "./components/RollingNumber.jsx";

const params = new URLSearchParams(location.search);
const BOOT_END = 5.7;
const LS = { theme: "tide-theme", sound: "tide-sound", boot: "tide-boot-seen" };
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const paramDay = /^\d{4}-\d{2}-\d{2}$/.test(params.get("day") ?? "") ? params.get("day") : null;
const paramState = ["today", "focus", "wrap"].includes(params.get("state")) ? params.get("state") : null;
const paramTheme = ["light", "dark"].includes(params.get("theme")) ? params.get("theme") : null;
const freezeT = params.has("freeze") ? Math.max(0, Math.min(BOOT_END, parseFloat(params.get("freeze")) || 0)) : null;
const forceReduce = params.get("motion") === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function App() {
  const [today] = useState(() => dateKey(new Date()));
  const initialDay = paramDay ?? today;
  const [state, dispatch] = useReducer(reducer, null, () => {
    const events = sampleWeek(new Date());
    const s = initState({ events, day: initialDay });
    // The briefing plays once per calendar day unless a param overrides it.
    const seen = localStorage.getItem(LS.boot) === today;
    const shouldBoot =
      !seen && params.get("noboot") !== "1" && !paramState && !forceReduce;
    s.scene = shouldBoot ? "boot" : (paramState ?? "today");
    if (s.scene === "focus") s.focusId = focusCandidate(events, initialDay)?.id ?? null;
    return s;
  });
  const [bootT, setBootT] = useState(() => (state.scene === "boot" ? freezeT ?? 0 : null));
  const [theme, setTheme] = useState(() => paramTheme ?? localStorage.getItem(LS.theme) ?? "light");
  const [sound, setSound] = useState(() => localStorage.getItem(LS.sound) !== "off");
  const [hoverId, setHoverId] = useState(null);
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const dialRef = useRef(null);
  const toastTimer = useRef(null);

  const { scene, day, events, focusId } = state;
  const reduced = forceReduce;

  // ── derived data ────────────────────────────────────────────────
  const week = useMemo(() => weekDays(new Date()), [today]);
  const loads = useMemo(() => new Map(week.map((d) => [d, loadOf(events, d)])), [events, week]);
  const info = loads.get(day) ?? loadOf(events, day);
  const arcs = useMemo(() => dayArcs(events, day), [events, day]);
  const date = localDate(day);
  const isToday = day === today;
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const summary = useMemo(() => (scene === "wrap" ? wrapSummary(events, day) : null), [scene, events, day]);
  const focusEvent = useMemo(() => {
    if (scene !== "focus") return null;
    return events.find((e) => e.id === focusId) ?? focusCandidate(events, day, now);
  }, [scene, events, focusId, day, now]);
  // focus is a session: the countdown starts from the event's full duration
  // when the scene opens, not at the event's calendar end
  const focusStartRef = useRef(null);
  useEffect(() => {
    if (scene === "focus" && focusStartRef.current == null) focusStartRef.current = Date.now();
    if (scene !== "focus") focusStartRef.current = null;
  }, [scene]);
  const focusElapsed = useMemo(
    () =>
      scene === "focus" && focusStartRef.current != null
        ? Math.max(0, (+now - focusStartRef.current) / 1000)
        : 0,
    [scene, now, focusEvent],
  );
  const focusRemain = useMemo(() => {
    if (!focusEvent) return null;
    const dur = Math.max(0, (+localDate(focusEvent.end) - +localDate(focusEvent.start)) / 1000);
    const left = Math.max(0, dur - focusElapsed);
    const m = Math.floor(left / 60);
    const s = Math.floor(left % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [focusEvent, focusElapsed]);

  const showToast = useCallback((text, hint) => {
    clearTimeout(toastTimer.current);
    const id = Date.now();
    setToast({ id, text, hint });
    toastTimer.current = setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 3500);
  }, []);

  // ── boot clock ──────────────────────────────────────────────────
  useEffect(() => {
    if (bootT == null || freezeT != null) return;
    let raf;
    let last = performance.now();
    const step = (t) => {
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      setBootT((b) => {
        const next = (b ?? 0) + dt;
        if (next >= BOOT_END) {
          dispatch({ type: "scene", scene: "today" });
          localStorage.setItem(LS.boot, today);
          return null;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [bootT == null, freezeT, today]);

  const skipBoot = useCallback(() => {
    if (bootT != null && freezeT == null) {
      setBootT(null);
      dispatch({ type: "scene", scene: "today" });
      localStorage.setItem(LS.boot, today);
    }
  }, [bootT, freezeT, today]);

  // ── sound ────────────────────────────────────────────────────────
  useEffect(() => {
    audio.setSoundEnabled(sound);
    localStorage.setItem(LS.sound, sound ? "on" : "off");
  }, [sound]);
  useEffect(() => {
    const unlock = () => audio.unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  useEffect(() => {
    if (scene === "focus" && sound) audio.startPad(info.load);
    else audio.stopPad();
    return () => audio.stopPad();
  }, [scene, sound]); // eslint-disable-line react-hooks/exhaustive-deps

  // surge entry/exit cues + the briefing's phase sounds (replays are gestures,
  // so audio is usually unlocked there; first-run cues no-op silently)
  const surge = info.level === 3;
  const prevSurge = useRef(surge);
  useEffect(() => {
    if (surge === prevSurge.current) return;
    prevSurge.current = surge;
    surge ? audio.warn() : audio.recover();
  }, [surge]);
  useEffect(() => {
    if (scene !== "boot" || freezeT != null) return;
    const clicks = [];
    for (let t = 0.05; t < 1.15; t += 0.055) clicks.push(t);
    const timers = [
      ...clicks.map((t) => setTimeout(audio.click, t * 1000)),
      setTimeout(audio.scan, 1700),
      setTimeout(audio.pour, 2600),
      setTimeout(audio.scan, 4450),
      setTimeout(audio.boot, 4950),
    ];
    return () => timers.forEach(clearTimeout);
  }, [scene, bootT != null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── clocks ───────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), scene === "focus" ? 1000 : 15000);
    return () => clearInterval(id);
  }, [scene]);

  // ── actions ─────────────────────────────────────────────────────
  const arcMinutes = useCallback(
    (id) => arcs.find((a) => a.event.id === id)?.from ?? 720,
    [arcs],
  );
  const toggle = useCallback(
    (id) => {
      dispatch({ type: "toggle", id });
      audio.ting();
      dialRef.current?.pulse(arcMinutes(id));
    },
    [arcMinutes],
  );
  const quickAdd = useCallback(
    (minutes) => {
      const start = localDate(day);
      start.setHours(0, 0, 0, 0);
      const s = new Date(+start + minutes * 60000);
      const e = new Date(+s + 3600000);
      dispatch({
        type: "add",
        event: { title: "新安排", tag: "other", start: s, end: e },
      });
      audio.tick();
      dialRef.current?.pulse(minutes);
      dialRef.current?.ripple(minutes, 1);
      showToast("已添加「新安排」", "Ctrl+Z 撤销");
    },
    [day, showToast],
  );
  const move = useCallback(
    (id, fromMinutes, length) => {
      const ev = events.find((e) => e.id === id);
      if (!ev) return;
      const base = localDate(day);
      base.setHours(0, 0, 0, 0);
      const s = new Date(+base + fromMinutes * 60000);
      const e = new Date(+s + Math.max(15, length) * 60000);
      dispatch({ type: "move", id, start: s, end: e });
      dialRef.current?.pulse(fromMinutes);
      showToast("已调整时间", "Ctrl+Z 撤销");
    },
    [events, day, showToast],
  );
  const remove = useCallback(
    (id) => {
      dispatch({ type: "remove", id });
      audio.thud();
      showToast("已删除", "Ctrl+Z 撤销");
    },
    [showToast],
  );
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const goFocus = useCallback(() => {
    if (scene === "focus") {
      dispatch({ type: "scene", scene: "today" });
      return;
    }
    if (scene !== "today") return;
    const cand = focusCandidate(events, day, new Date());
    dispatch({ type: "scene", scene: "focus", focusId: cand?.id ?? null });
  }, [scene, events, day]);
  const goWrap = useCallback(() => {
    if (scene === "wrap") return;
    if (scene === "today" || scene === "focus") {
      dispatch({ type: "scene", scene: "wrap" });
      // completed arcs glow one by one: pulses in time order
      arcs
        .filter((a) => a.event.completed)
        .sort((a, b) => a.from - b.from)
        .forEach((a, i) => setTimeout(() => {
          dialRef.current?.pulse(a.from);
          audio.ting();
        }, 300 + i * 260));
    }
  }, [scene, arcs]);
  const exitToToday = useCallback(() => {
    if (scene === "focus" || scene === "wrap") dispatch({ type: "scene", scene: "today" });
  }, [scene]);
  const replay = useCallback(() => {
    dispatch({ type: "scene", scene: "boot" });
    setBootT(0);
    audio.boot();
  }, []);

  const [wipeSeq, setWipeSeq] = useState(0);
  const selectDay = useCallback(
    (d) => {
      if (d === day) return;
      dispatch({ type: "day", day: d });
      setWipeSeq((s) => s + 1);
      audio.scan();
      dialRef.current?.ripple(0, 0.7);
    },
    [day],
  );

  // ── keyboard ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (bootT != null && freezeT == null) {
        skipBoot();
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "Escape") exitToToday();
      else if (key === "f") goFocus();
      else if (key === "w") goWrap();
      else if (key === "m") setSound((s) => !s);
      else if (key === "d") setTheme((t) => (t === "dark" ? "light" : "dark"));
      else if (key === "r") replay();
      else if (e.key === "ArrowLeft") selectDay(shiftDay(day, -1));
      else if (e.key === "ArrowRight") selectDay(shiftDay(day, 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bootT, freezeT, skipBoot, undo, redo, exitToToday, goFocus, goWrap, replay, selectDay, day]);

  useEffect(() => {
    const down = () => skipBoot();
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [skipBoot]);

  // ── callouts ─────────────────────────────────────────────────────
  const nextEvent = useMemo(() => {
    const timed = arcs.filter((a) => !a.event.completed && !a.event.allDay);
    return (
      timed.find((a) => isToday && a.from + a.length > nowMinutes) ??
      timed.find((a) => !isToday) ??
      null
    );
  }, [arcs, isToday, nowMinutes]);

  const hoverArc = hoverId ? arcs.find((a) => a.event.id === hoverId) : null;
  const bootVisible = bootT == null ? 1 : Math.min(1, Math.max(0, (bootT - 4.7) / 0.4));
  const calloutItems =
    bootVisible <= 0
      ? []
      : [
          {
            key: "load",
            minutes: 1290,
            side: -1,
            len: 52,
            lift: -8,
            label: (
              <>
                负荷 <RollingText text={bootVisible < 1 ? "0.00" : info.load.toFixed(2)} /> · {info.label}
              </>
            ),
          },
          {
            key: "busy",
            minutes: 90,
            side: 1,
            len: 52,
            lift: -10,
            label: `已占用 ${minutesToText(info.minutes)}`,
          },
          nextEvent && {
            key: "next",
            minutes: nextEvent.from,
            side: nextEvent.from > 720 ? -1 : 1,
            len: 60,
            label: `下一项 ${formatTime(nextEvent.event.start)} ${nextEvent.event.title}`,
          },
        ].filter(Boolean);
  const hoverCallout = hoverArc
    ? {
        minutes: hoverArc.from + hoverArc.length / 2,
        len: 66,
        label: `${formatTime(hoverArc.event.start)}–${formatTime(hoverArc.event.end)} · ${eventCognitiveInfo(hoverArc.event).level.short}`,
        title: hoverArc.event.title,
      }
    : null;

  const chromeIn = bootT == null ? 1 : Math.min(1, Math.max(0, (bootT - 4.7) / 0.6));
  const monthText = `${date.getMonth() + 1} 月 · 星期${WEEKDAYS[date.getDay()]}`;
  const overlapItems = useMemo(() => (surge ? overlappingItems(events, day) : []), [surge, events, day]);

  // one coral scan line sweeps the page when high tide is entered
  const [surgeScan, setSurgeScan] = useState(0);
  const prevSurgeRef = useRef(surge);
  useEffect(() => {
    if (surge && !prevSurgeRef.current) setSurgeScan((s) => s + 1);
    prevSurgeRef.current = surge;
  }, [surge]);

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="tide-app"
        data-theme={theme}
        data-scene={scene}
        data-boot={bootT != null || undefined}
      >
        <header className="mast" style={{ opacity: chromeIn }}>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <b>精力日历 · 潮汐观测</b>
            <span className="brand-sub mono">TIDE OBSERVATORY</span>
          </div>
          <nav className="mast-actions" aria-label="工具">
            <button type="button" onClick={() => setSound((s) => !s)} aria-pressed={sound} title="声音 (M)">
              {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
              <kbd>M</kbd>
            </button>
            <button type="button" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="明暗 (D)">
              {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
              <kbd>D</kbd>
            </button>
            <button type="button" onClick={replay} title="重播简报 (R)">
              <RotateCcw size={16} />
              <kbd>R</kbd>
            </button>
          </nav>
        </header>

        <main className="stage">
          <aside className="col col-left" style={{ opacity: chromeIn }}>
            <div className="day-num" aria-label={`${date.getDate()} 日`}>
              <RollingNumber value={date.getDate()} duration={460} />
            </div>
            <p className="day-meta">{monthText}</p>
            {surge && scene !== "wrap" ? (
              <AnimatePresence>
                <WarningPlate items={overlapItems} />
              </AnimatePresence>
            ) : (
              <AnimatePresence mode="wait">
                <motion.p
                  key={`${day}-${info.level}`}
                  className="mood"
                  initial={{ opacity: 0, y: reduced ? 0 : 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.3 }}
                >
                  {moodSentence(info.level)}
                </motion.p>
              </AnimatePresence>
            )}
          </aside>

          <div className="dial-zone" style={{ opacity: Math.max(bootT != null ? Math.min(1, Math.max(0, (bootT - 2.2) / 0.6)) : 1, 0) }}>
            <div className="dial-scale" data-focus={scene === "focus" || undefined}>
              <TideDial
                ref={dialRef}
                arcs={arcs}
                day={day}
                isToday={isToday}
                nowMinutes={nowMinutes}
                bootT={freezeT ?? bootT}
                targets={{
                  load: scene === "wrap" ? info.load * 0.25 : info.load,
                  energy: info.energy,
                  dark: theme === "dark" ? 1 : 0,
                  surge: surge && scene !== "wrap" ? 1 : 0,
                  focus: scene === "focus" ? 1 : 0,
                  focusRemain,
                  focusElapsed,
                  dayKey: day,
                }}
                reduced={reduced}
                focusEvent={focusEvent}
                hoverId={hoverId}
                onHover={setHoverId}
                onToggle={toggle}
                onDelete={remove}
                onQuickAdd={quickAdd}
                onMove={move}
                onPointerPage={(cue) => cue === "tick" && audio.tick()}
              />
              <Callouts items={calloutItems} hover={hoverCallout} />
            </div>
          </div>

          <aside className="col col-right" style={{ opacity: chromeIn * (scene === "focus" ? 0.08 : 1) }}>
            <AnimatePresence>{scene === "wrap" && <WrapCard summary={summary} />}</AnimatePresence>
            <Timeline
              events={events}
              day={day}
              now={now}
              hoverId={hoverId}
              onHover={setHoverId}
              onToggle={toggle}
              onDelete={remove}
              reduced={reduced}
            />
          </aside>
        </main>

        <footer className="dock" style={{ opacity: chromeIn * (scene === "focus" ? 0.08 : 1) }}>
          <WeekStrip days={week} loads={loads} selected={day} onSelect={selectDay} />
          <div className="scene-actions">
            <button type="button" onClick={goFocus} data-on={scene === "focus" || undefined}>
              专注 <kbd>F</kbd>
            </button>
            <button type="button" onClick={goWrap} data-on={scene === "wrap" || undefined}>
              收工 <kbd>W</kbd>
            </button>
          </div>
        </footer>

        <AnimatePresence>{scene === "focus" && <FocusHint />}</AnimatePresence>
        <HudFrame day={day} date={date} dayIndex={week.indexOf(day)} info={info} visible={chromeIn} frameIn={bootT == null ? 1 : Math.min(1, Math.max(0, (bootT - 2.2) / 0.8))} />
        <BootLayer bootT={freezeT ?? bootT} count={info.count} load={info.load} />
        {wipeSeq > 0 && <div key={wipeSeq} className="day-wipe" aria-hidden="true" />}
        {surgeScan > 0 && <div key={surgeScan} className="surge-scan" aria-hidden="true" />}
        <Toast toast={toast} />
      </div>
    </MotionConfig>
  );
}
