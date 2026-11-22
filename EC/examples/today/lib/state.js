// Explicit state machine for the page: boot → today ⇄ focus · today ⇄ wrap,
// plus the event store with undo/redo. Pure and dependency-free.
import { addDays, dateKey, eventOnDay, localDate, normalizeEvent } from "../../../shared/domain.js";

export const SCENES = ["boot", "today", "focus", "wrap"];

const HISTORY_LIMIT = 30;

export function initState({ events, day }) {
  return {
    scene: "boot",
    day,
    events,
    past: [],
    future: [],
    focusId: null,
  };
}

const pushHistory = (state) => ({
  ...state,
  past: [...state.past, state.events].slice(-HISTORY_LIMIT),
  future: [],
});

export function reducer(state, action) {
  switch (action.type) {
    case "scene": {
      const next = action.scene;
      if (!SCENES.includes(next)) return state;
      const legal =
        state.scene === next ||
        next === "boot" || // replay re-enters the briefing from anywhere
        (state.scene === "boot" && next === "today") ||
        (state.scene === "today" && (next === "focus" || next === "wrap")) ||
        ((state.scene === "focus" || state.scene === "wrap") && next === "today") ||
        (state.scene === "focus" && next === "wrap") ||
        (state.scene === "wrap" && next === "focus");
      if (!legal) return state;
      return { ...state, scene: next, focusId: action.focusId ?? state.focusId };
    }
    case "day":
      return { ...state, day: dateKey(localDate(action.day)) };
    case "toggle": {
      const next = state.events.map((e) =>
        e.id === action.id ? { ...e, completed: !e.completed } : e,
      );
      return { ...pushHistory(state), events: next };
    }
    case "add": {
      const event = normalizeEvent(action.event);
      return { ...pushHistory(state), events: [...state.events, event] };
    }
    case "move": {
      const next = state.events.map((e) =>
        e.id === action.id
          ? { ...e, start: new Date(action.start).toISOString(), end: new Date(action.end).toISOString() }
          : e,
      );
      return { ...pushHistory(state), events: next };
    }
    case "remove":
      return { ...pushHistory(state), events: state.events.filter((e) => e.id !== action.id) };
    case "undo": {
      const prev = state.past.at(-1);
      if (!prev) return state;
      return { ...state, events: prev, past: state.past.slice(0, -1), future: [...state.future, state.events] };
    }
    case "redo": {
      const next = state.future.at(-1);
      if (!next) return state;
      return { ...state, events: next, future: state.future.slice(0, -1), past: [...state.past, state.events].slice(-HISTORY_LIMIT) };
    }
    default:
      return state;
  }
}

// Next day / previous day helpers.
export const shiftDay = (day, delta) => dateKey(addDays(localDate(day), delta));

// Pick the event focus mode should run on: the one containing `now`, else the
// next upcoming, else the first timed event of the day.
export function focusCandidate(events, day, now = new Date()) {
  const start = localDate(day);
  start.setHours(0, 0, 0, 0);
  const timedAll = events
    .filter((e) => !e.allDay && eventOnDay(e, start))
    .sort((a, b) => +localDate(a.start) - +localDate(b.start));
  const timed = timedAll.filter((e) => !e.completed);
  return (
    timed.find((e) => +localDate(e.start) <= +now && +localDate(e.end) > +now) ??
    timed.find((e) => +localDate(e.start) > +now) ??
    timed[0] ??
    timedAll[0] ??
    null
  );
}
