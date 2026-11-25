import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMotionValue } from "framer-motion";
import { DialContext, dialViews } from "./DayDial";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import zhCn from "@fullcalendar/core/locales/zh-cn";
import {
  addDays,
  categoryOf,
  dateKey,
  dayLoad,
  eventCognitiveInfo,
  eventCognitiveUnits,
  eventOnDay,
  eventsByDay,
  localDate,
  overlapLevels,
  rangeLoads,
  rowNeighbors,
  shiftByDays,
} from "../../shared/domain";
import { energyForCount } from "../../shared/energy";
import {
  DRAG,
  DayPreview,
  DragChip,
  useDwell,
  useKeyboardModality,
} from "./DayPreview";

const HEAT_TWEEN =
  typeof CSS !== "undefined" && typeof CSS.registerProperty === "function";
const heatCache = new Map();
const heatFor = (count) => {
  const key = Number(count).toFixed(1);
  let hit = heatCache.get(key);
  if (!hit) {
    hit = energyForCount(Number(key));
    heatCache.set(key, hit);
  }
  return hit;
};
const byDayOrder = (a, b) =>
  Number(b.allDay) - Number(a.allDay) || +localDate(a.start) - +localDate(b.start);
const setVar = (element, name, value) => {
  if (element.style.getPropertyValue(name) !== value)
    element.style.setProperty(name, value);
};

const CalendarCanvas = forwardRef(function CalendarCanvas(
  {
    events,
    allEvents,
    settings,
    view,
    selectedDay,
    range,
    flash,
    onDate,
    onCreate,
    onEdit,
    onDelete,
    onMove,
    onRange,
    onContext,
    onShowDay,
    onEventActions,
    onPaste,
    aiWeights = null,
    energyMode = "density",
  },
  ref,
) {
  const onDeleteRef = useRef(onDelete);
  const onContextRef = useRef(onContext);
  onDeleteRef.current = onDelete;
  onContextRef.current = onContext;
  const [gesture, setGesture] = useState("");
  const canvas = useRef(null);
  const touchPress = useRef(null),
    pressedDate = useRef(null);
  const cancelTouchPress = useCallback(() => {
    clearTimeout(touchPress.current?.timer);
    touchPress.current = null;
  }, []);
  useEffect(() => cancelTouchPress, [cancelTouchPress, view]);
  const lastSelection = useRef(null);
  const selectedKey = dateKey(selectedDay);
  const monthStart = range?.currentStart;
  useLayoutEffect(() => {
    const previous = lastSelection.current;
    lastSelection.current = { view, selectedKey, monthStart };
    if (view !== "dayGridMonth" || previous?.view !== view ||
        !monthStart || !previous.monthStart ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const frame = requestAnimationFrame(() => {
      if (previous.monthStart !== monthStart) {
        const offset = Math.sign(monthStart - previous.monthStart) * 32;
        canvas.current?.querySelector(".fc-daygrid-body")?.animate?.(
          [{ opacity: 0.35, transform: `translateX(${offset}px)` }, { opacity: 1, transform: "none" }],
          { duration: 290, easing: "cubic-bezier(.2,.72,.2,1)" },
        );
        return;
      }
      if (previous.selectedKey === selectedKey) return;
      const findFrame = (key) => canvas.current?.querySelector(
        `.fc-daygrid-day[data-date="${key}"] .fc-daygrid-day-frame`,
      );
      const source = findFrame(previous.selectedKey);
      const target = findFrame(selectedKey);
      if (!source || !target) return;
      const from = source.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      target.animate?.(
        [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: "none" }],
        { pseudoElement: "::after", duration: 310, easing: "cubic-bezier(.2,.72,.2,1)" },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [view, selectedKey, monthStart]);
  const cancelled = useRef(false);
  const [preview, setPreview] = useState(null);
  const previewFrame = useRef(null),
    gestureActive = useRef(false);
  const visibleEvents = useMemo(
    () =>
      preview
        ? events.map((e) =>
            String(e.id) === preview.id ? { ...e, ...preview } : e,
          )
        : events,
    [events, preview],
  );
  const heatEvents = useMemo(
    () =>
      preview
        ? allEvents.map((e) =>
            String(e.id) === preview.id ? { ...e, ...preview } : e,
          )
        : allEvents,
    [allEvents, preview],
  );
  const levels = useMemo(() => overlapLevels(heatEvents), [heatEvents]);
  const gridDays = useMemo(() => {
    if (!range?.start) return 0;
    return Math.max(
      1,
      Math.min(
        90,
        Math.round((localDate(range.end) - localDate(range.start)) / 86400000),
      ),
    );
  }, [range]);
  const loadOptions = useMemo(
    () =>
      energyMode === "cognitive"
        ? { weightsMap: aiWeights, energyMode }
        : undefined,
    [aiWeights, energyMode],
  );
  const loadMap = useMemo(() => {
    if (!gridDays) return null;
    return rangeLoads(heatEvents, localDate(range.start), gridDays, loadOptions);
  }, [heatEvents, range, gridDays, loadOptions]);
  const loads = useCallback(
    (key) => loadMap?.get(key) ?? dayLoad(heatEvents, key, loadOptions),
    [loadMap, heatEvents, loadOptions],
  );
  const dayCells = useMemo(() => {
    if (!gridDays) return null;
    const first = localDate(range.start);
    const lists = eventsByDay(visibleEvents, first, gridDays);
    const spans = new Map();
    const trackEnd = [];
    const multi = visibleEvents
      .filter((e) =>
        e.allDay
          ? +localDate(e.end) - +localDate(e.start) > 86400000
          : dateKey(localDate(e.start)) !==
            dateKey(new Date(+localDate(e.end) - 1)),
      )
      .sort(
        (a, b) =>
          +localDate(a.start) - +localDate(b.start) ||
          String(a.id).localeCompare(String(b.id)),
      );
    for (const e of multi) {
      const firstDay = dateKey(localDate(e.start)),
        lastDay = dateKey(new Date(+localDate(e.end) - 1));
      let segStart = localDate(e.start),
        segEnd = localDate(lastDay);
      if (+segStart < +first) segStart = first;
      const last = addDays(first, gridDays - 1);
      if (+segEnd > +last) segEnd = last;
      if (+segEnd < +segStart) continue;
      let track = trackEnd.findIndex((end) => end < +segStart);
      if (track < 0) track = trackEnd.length;
      trackEnd[track] = +segEnd;
      for (let d = segStart; track < 2 && +d <= +segEnd; d = addDays(d, 1)) {
        const key = dateKey(d);
        if (!spans.has(key)) spans.set(key, []);
        spans.get(key).push({
          id: e.id,
          track,
          isStart: key === firstDay,
          isEnd: key === lastDay,
          completed: e.completed,
          color: categoryOf(e).color,
        });
      }
    }
    return { lists, spans };
  }, [visibleEvents, range, gridDays]);
  const styleDay = useCallback(
    (element, date) => {
      const load = loads(dateKey(date)),
        heatVal = energyMode === "cognitive" ? load.effectiveCount : load.count,
        heat = heatFor(heatVal || 1);
      const viewType = ref.current?.getApi()?.view.type ?? view;
      const { prev, next } = rowNeighbors(date, {
        firstDay: settings.weekStart,
        showWeekends: settings.showWeekends,
      });
      const other = element.classList.contains("fc-day-other"),
        selfMonth = localDate(date).getMonth();
      const bleed = (neighbor) => {
        if (!neighbor || other) return "transparent";
        if (
          viewType === "dayGridMonth" &&
          localDate(neighbor).getMonth() !== selfMonth
        )
          return "transparent";
        const neighborLoad = loads(neighbor);
        const count =
          energyMode === "cognitive"
            ? neighborLoad.effectiveCount
            : neighborLoad.count;
        return count ? heatFor(count).cell : "transparent";
      };
      setVar(element, "--day-heat", heatVal ? heat.cell : "transparent");
      setVar(element, "--day-heat-ink", heat.ink);
      setVar(element, "--heat-prev", bleed(prev));
      setVar(element, "--heat-next", bleed(next));
      element.dataset.busyCount = String(load.count);
    },
    [loads, settings.weekStart, settings.showWeekends, view, ref, energyMode],
  );
  const syncDayHeat = useCallback(() => {
    const root = ref.current?.getApi()?.el;
    root
      ?.querySelectorAll(
        ".fc-daygrid-day[data-date], .fc-timegrid-col[data-date]",
      )
      .forEach((element) => styleDay(element, localDate(element.dataset.date)));
  }, [ref, styleDay]);
  const keyboardModality = useKeyboardModality();
  const dragRef = useRef(null);
  const [chip, setChip] = useState(null);
  const chipX = useMotionValue(0),
    chipY = useMotionValue(0);
  const lifted = useRef({ key: null, els: [] });
  const liftCell = useCallback(
    (key) => {
      lifted.current.els.forEach((el) => {
        el.classList.remove("is-dwell");
        el.style.removeProperty("--day-heat-ink");
      });
      lifted.current = { key, els: [] };
      const root = ref.current?.getApi()?.el;
      if (!key || !root) return;
      const targets = [];
      const frame = root.querySelector(
        `.fc-daygrid-day[data-date="${key}"] > .fc-daygrid-day-frame`,
      );
      if (frame) targets.push(frame);
      const header = root.querySelector(
        `.fc-col-header-cell[data-date="${key}"] .fc-scrollgrid-sync-inner`,
      );
      if (header) {
        const headerLoad = loads(key);
        const headerVal =
          energyMode === "cognitive"
            ? headerLoad.effectiveCount
            : headerLoad.count;
        header.style.setProperty(
          "--day-heat-ink",
          heatFor(headerVal || 1).ink,
        );
        targets.push(header);
      }
      const col = root.querySelector(
        `.fc-timegrid-col[data-date="${key}"] .fc-timegrid-col-frame`,
      );
      if (col) targets.push(col);
      targets.forEach((el) => el.classList.add("is-dwell"));
      lifted.current = { key, els: targets };
    },
    [ref, loads, energyMode],
  );
  const dwell = useDwell({ onLift: liftCell });
  useEffect(() => {
    syncDayHeat();
  }, [syncDayHeat]);
  useEffect(() => {
    dwell.close();
  }, [view]);
  useLayoutEffect(() => {
    if (lifted.current.key) liftCell(lifted.current.key);
  });
  const resolve = useCallback(
    (key) => ({
      date: localDate(key),
      events:
        dayCells?.lists.get(key) ??
        visibleEvents.filter((e) => eventOnDay(e, key)).sort(byDayOrder),
      load: loads(key),
      levels,
      today: key === dateKey(new Date()),
      weightsMap: aiWeights,
      energyMode,
    }),
    [dayCells, visibleEvents, loads, levels, aiWeights, energyMode],
  );
  const startRowDrag = (event, e) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const source = dwell.open?.key;
    if (!source) return;
    const from = e.currentTarget.getBoundingClientRect();
    const origin = { x: e.clientX, y: e.clientY };
    let moving = false,
      targetEl = null,
      moveFrame = null;
    const hitCell = (cx, cy) => {
      const root = ref.current?.getApi()?.el;
      const cell = document
        .elementFromPoint(cx, cy)
        ?.closest(".fc-daygrid-day[data-date]");
      return cell && root?.contains(cell) ? cell : null;
    };
    const clearTarget = () => {
      targetEl
        ?.querySelector(".fc-daygrid-day-frame")
        ?.classList.remove("is-drop-target");
      targetEl = null;
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc, true);
    };
    const cleanup = (result, dropRect) => {
      detach();
      cancelAnimationFrame(moveFrame);
      clearTarget();
      document.documentElement.classList.remove("is-dragging-event");
      setPreview(null);
      setGesture("");
      dragRef.current = null;
      dwell.close();
      const swallow = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      document.addEventListener("click", swallow, true);
      setTimeout(() => document.removeEventListener("click", swallow, true), 0);
      setChip((c) => (c ? { ...c, result, target: dropRect } : c));
      setTimeout(() => setChip(null), result === "drop" ? 220 : 520);
    };
    const esc = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        cancel();
      }
    };
    const cancel = () => {
      if (!moving) return detach();
      cleanup("cancel", null);
    };
    const move = (ev) => {
      if (!moving) {
        if (
          Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) <
          DRAG.threshold
        )
          return;
        moving = true;
        dragRef.current = { id: event.id };
        chipX.set(ev.clientX);
        chipY.set(ev.clientY);
        setChip({ event, x: chipX, y: chipY, from, result: null, target: null });
        setGesture("移到想去的日期，松手即可");
        document.documentElement.classList.add("is-dragging-event");
        liftCell(null);
      }
      chipX.set(ev.clientX);
      chipY.set(ev.clientY);
      if (moveFrame) return;
      moveFrame = requestAnimationFrame(() => {
        moveFrame = null;
        const cell = hitCell(ev.clientX, ev.clientY);
        if (cell) {
          if (cell !== targetEl) {
            clearTarget();
            targetEl = cell;
            targetEl
              .querySelector(".fc-daygrid-day-frame")
              ?.classList.add("is-drop-target");
          }
          const delta = Math.round(
            (localDate(cell.dataset.date) - localDate(source)) / 86400000,
          );
          const candidate = delta
            ? {
                id: event.id,
                ...shiftByDays(event, delta),
                allDay: event.allDay,
              }
            : null;
          setPreview((previous) =>
            previous?.id === candidate?.id &&
            previous?.start === candidate?.start &&
            previous?.end === candidate?.end &&
            previous?.allDay === candidate?.allDay
              ? previous
              : candidate,
          );
        } else {
          clearTarget();
          setPreview(null);
        }
      });
    };
    const up = (ev) => {
      if (!moving) return detach();
      const cell = hitCell(ev.clientX, ev.clientY);
      const delta = cell
        ? Math.round(
            (localDate(cell.dataset.date) - localDate(source)) / 86400000,
          )
        : 0;
      const dropRect = cell?.getBoundingClientRect() ?? null;
      cleanup(delta ? "drop" : "cancel", dropRect);
      if (delta) {
        try {
          const shifted = shiftByDays(event, delta);
          onMove(event.id, shifted.start, shifted.end, event.allDay);
        } catch {}
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc, true);
  };
  const dwellTrigger = (target) => {
    const type = ref.current?.getApi()?.view.type ?? view;
    if (type === "dayGridMonth")
      return target.closest?.(".fc-daygrid-day[data-date]");
    return target.closest?.(".fc-col-header-cell[data-date]");
  };
  const overPreview = (e) => {
    if (
      e.pointerType === "touch" ||
      e.buttons ||
      gestureActive.current ||
      dragRef.current
    )
      return;
    const trigger = dwellTrigger(e.target);
    if (trigger) dwell.enter(trigger.dataset.date, trigger);
    else dwell.leave();
  };
  const focusPreview = (e) => {
    if (!keyboardModality.current || !e.target.closest?.(".day-number")) return;
    const cell = e.target.closest(".fc-daygrid-day[data-date]");
    if (cell) dwell.enter(cell.dataset.date, cell, "keyboard");
  };
  const blurPreview = (e) => {
    const next = e.relatedTarget;
    if (
      next &&
      (dwell.cardRef.current?.contains(next) ||
        e.target.closest(".fc-daygrid-day")?.contains(next))
    )
      return;
    dwell.leave();
  };
  const keyPreview = (e) => {
    if (
      e.key === "ArrowDown" &&
      dwell.open &&
      e.target.closest?.(".day-number")
    ) {
      e.preventDefault();
      dwell.cardRef.current?.querySelector(".day-preview-item")?.focus();
    }
  };
  useEffect(() => () => cancelAnimationFrame(previewFrame.current), []);
  const allowPreview = useCallback((drop, event) => {
    if (!gestureActive.current || !event || cancelled.current) return true;
    const candidate = {
      id: String(event.id),
      start: drop.allDay ? dateKey(drop.start) : drop.start.toISOString(),
      end: drop.allDay ? dateKey(drop.end) : drop.end.toISOString(),
      allDay: drop.allDay,
    };
    cancelAnimationFrame(previewFrame.current);
    previewFrame.current = requestAnimationFrame(() =>
      setPreview((previous) =>
        previous?.id === candidate.id &&
        previous.start === candidate.start &&
        previous.end === candidate.end &&
        previous.allDay === candidate.allDay
          ? previous
          : candidate,
      ),
    );
    return true;
  }, []);
  const endGesture = useCallback(() => {
    gestureActive.current = false;
    cancelAnimationFrame(previewFrame.current);
    setPreview(null);
    setGesture("");
  }, []);
  useEffect(() => {
    const keydown = (e) => {
      if (e.key === "Escape") {
        cancelled.current = true;
        dwell.close();
        ref.current?.getApi().unselect();
        setGesture("");
        cancelAnimationFrame(previewFrame.current);
        setPreview(null);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [ref]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const api = ref.current?.getApi();
      if (api && api.view.type !== view) api.changeView(view, selectedDay);
    });
    return () => cancelAnimationFrame(frame);
  }, [view, ref]);
  // Briefly outline an event after navigation (e.g. jumping from search).
  useEffect(() => {
    if (!flash) return;
    let node,
      retry,
      cleanup;
    const apply = () => {
      const api = ref.current?.getApi();
      if (api?.view.type === "dayGridMonth") {
        const event = allEvents.find((e) => String(e.id) === String(flash.id));
        node =
          event &&
          api.el?.querySelector(
            `.fc-daygrid-day[data-date="${dateKey(localDate(event.start))}"] .fc-daygrid-day-frame`,
          );
      } else {
        node = api?.el
          ?.querySelector(`[data-event-id="${CSS.escape(flash.id)}"]`)
          ?.closest(".fc-event");
      }
      if (!node) {
        retry = setTimeout(apply, 380);
        return;
      }
      node.classList.add("flash-target");
      cleanup = setTimeout(() => node?.classList.remove("flash-target"), 1700);
    };
    const frame = requestAnimationFrame(apply);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(retry);
      clearTimeout(cleanup);
      node?.classList.remove("flash-target");
    };
  }, [flash, ref, allEvents]);
  const move = useCallback(
    (info) => {
      if (cancelled.current) {
        info.revert();
        return;
      }
      const { event } = info;
      if (!event.start || !event.end) {
        info.revert();
        return;
      }
      try {
        onMove(
          event.id,
          event.allDay ? dateKey(event.start) : event.start.toISOString(),
          event.allDay ? dateKey(event.end) : event.end.toISOString(),
          event.allDay,
        );
      } catch {
        info.revert();
      }
    },
    [onMove],
  );
  const eventMap = useMemo(
    () => new Map(allEvents.map((e) => [String(e.id), e])),
    [allEvents],
  );
  const renderEvent = (info) => {
    const event = info.event,
      category = categoryOf(event.extendedProps),
      level = levels.get(event.id) || 1;
    const rawEvent = eventMap.get(String(event.id)) ?? {
      id: event.id,
      title: event.title,
      tag: event.extendedProps.tag,
      description: event.extendedProps.description || "",
      allDay: event.allDay,
      start: event.startStr || event.start,
      end: event.endStr || event.end,
    };
    const isCognitive = energyMode === "cognitive";
    const cog = isCognitive ? eventCognitiveInfo(rawEvent, aiWeights) : null;
    const cogUnits = isCognitive ? eventCognitiveUnits(rawEvent, aiWeights) : 0;
    const tileHeat = isCognitive
      ? Math.max(
          level,
          Math.min(8, Number((cogUnits * 1.1 + (cog.score - 1) * 0.45).toFixed(1))),
        )
      : level;
    const heat = energyForCount(tileHeat);
    return (
      <div
        className={`event-tile ${event.extendedProps.completed ? "is-complete" : ""}`}
        data-energy-count={level}
        data-cognitive-score={cog ? cog.score : undefined}
        data-event-id={event.id}
        title={
          cog
            ? `${event.title} · ${cog.label} (Lv.${cog.score})${level > 1 ? ` · ${level} 项重叠` : ""}`
            : `${event.title} · ${level} 项同时重叠 · ${heat.label}`
        }
        style={{
          "--event-ink": heat.text,
          "--event-heat": heat.gradient,
          "--event-heat-ink": heat.ink,
          "--category-color": category.color,
        }}
      >
        {info.timeText && !event.allDay && (
          <span className="event-time">{info.timeText}</span>
        )}
        <span className="event-name">{event.title}</span>
        {cog && cog.score >= 4 && (
          <span
            className="event-cog-badge"
            data-score={cog.score}
            title={`认知耗能：${cog.label} (Lv.${cog.score})`}
          >
            {cog.level.short}
          </span>
        )}
        <span
          className="event-category-dot"
          title={`分类：${category.label}`}
        />
        {level > 1 && (
          <span
            className="event-conflict"
            title={`${level} 项日程重叠`}
            aria-label={`${level} 项日程重叠`}
          >
            {level}
          </span>
        )}
      </div>
    );
  };
  const openSlotMenu = (e) => {
    if (onShowDay) {
      e.preventDefault();
      return;
    }
    if (e.target.closest(".fc-event")) return;
    const cell = e.target.closest("[data-date]");
    if (!cell) return;
    e.preventDefault();
    dwell.close();
    let minutes = null;
    if (cell.classList.contains("fc-timegrid-col")) {
      const rect = cell.getBoundingClientRect();
      const [sh, sm] = String(settings.workStart).split(":").map(Number);
      const [eh, em] = String(settings.workEnd).split(":").map(Number);
      const startMin = (sh || 0) * 60 + (sm || 0),
        endMin = (eh || 24) * 60 + (em || 0);
      const raw = startMin + ((e.clientY - rect.top) / rect.height) * (endMin - startMin);
      minutes = Math.max(startMin, Math.min(endMin, Math.round(raw / 15) * 15));
    }
    const date = cell.dataset.date;
    const isDayCell = !cell.classList.contains("fc-timegrid-col");
    const dayEvents = isDayCell
      ? (dayCells?.lists.get(date) ??
        visibleEvents.filter((ev) => eventOnDay(ev, date)).sort(byDayOrder))
      : [];
    onContext({
      x: e.clientX,
      y: e.clientY,
      date,
      minutes,
      allDay: minutes == null,
      events: dayEvents,
    });
  };
  const beginTouchPress = (e) => {
    if (!onShowDay || view !== "dayGridMonth" || e.pointerType !== "touch" || !e.isPrimary) return;
    const cell = e.target.closest?.(".fc-daygrid-day[data-date]");
    if (!cell) return;
    const date = cell.dataset.date;
    cancelTouchPress();
    pressedDate.current = null;
    touchPress.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        pressedDate.current = { date, until: Date.now() + 1000 };
        onDate(localDate(date));
        onContext?.({ date, allDay: true, mobile: true });
      }, 500),
    };
  };
  const trackTouchPress = (e) => {
    const press = touchPress.current;
    if (press?.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) {
      cancelTouchPress();
    }
  };
  const isPressedDate = (date) => pressedDate.current?.date === date && Date.now() < pressedDate.current.until;
  const dialContextValue = useMemo(
    () => ({ events, onEdit, onCreate, onDelete, onEventActions, onPaste, aiWeights, energyMode }),
    [events, onEdit, onCreate, onDelete, onEventActions, onPaste, aiWeights, energyMode],
  );
  globalThis.__EC_DIAL_STATE__ = dialContextValue;
  const calendar = (
    <div
      className={`time-canvas ${gesture ? "is-interacting" : ""}`}
      ref={canvas}
      data-heat-tween={HEAT_TWEEN ? "" : undefined}
      onContextMenu={openSlotMenu}
      onPointerDown={beginTouchPress}
      onPointerMove={trackTouchPress}
      onPointerUp={cancelTouchPress}
      onPointerCancel={cancelTouchPress}
      onPointerOver={overPreview}
      onPointerLeave={() => dwell.leave()}
      onFocus={focusPreview}
      onBlur={blurPreview}
      onKeyDown={keyPreview}
    >
      {gesture && (
        <div className="gesture-hint" role="status">
          {gesture}
          {!onShowDay && <kbd>Esc 取消</kbd>}
        </div>
      )}
      <DialContext.Provider value={dialContextValue}>
      <FullCalendar
        ref={ref}
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
        locale={zhCn}
        initialView={view}
        views={dialViews}
        headerToolbar={false}
        height="100%"
        firstDay={settings.weekStart}
        weekends={settings.showWeekends}
        editable
        selectable={!onShowDay || view === "timeGridWeek"}
        selectMirror
        selectMinDistance={5}
        eventDragMinDistance={6}
        longPressDelay={350}
        eventResizableFromStart
        eventAllow={allowPreview}
        eventDisplay={view === "dayGridMonth" ? "none" : "block"}
        dayMaxEvents
        fixedWeekCount={false}
        nowIndicator
        slotMinTime={`${settings.workStart}:00`}
        slotMaxTime={`${settings.workEnd}:00`}
        scrollTime="09:00:00"
        slotDuration="00:30:00"
        snapDuration="00:15:00"
        allDayText="全天"
        expandRows
        stickyHeaderDates
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        events={events}
        datesSet={(info) => {
          onRange(info);
          dwell.close();
          requestAnimationFrame(syncDayHeat);
        }}
        dayCellDidMount={(info) => styleDay(info.el, info.date)}
        dayHeaderContent={(info) => {
          const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][info.date.getDay()];
          const showNumber = info.view.type !== "dayGridMonth";
          const heading = (
            <>
              <span>{weekday}</span>
              {showNumber && (
                <strong className={info.isToday ? "is-today" : ""}>{info.date.getDate()}</strong>
              )}
            </>
          );
          return onShowDay && showNumber ? (
            <button
              type="button"
              className="weekday-heading touch-day-heading"
              aria-label={`查看 ${dateKey(info.date)} 的日程`}
              onClick={(e) => { e.stopPropagation(); onShowDay(info.date); }}
            >
              {heading}
            </button>
          ) : <span className="weekday-heading">{heading}</span>;
        }}
        dayCellClassNames={(info) => [
          dateKey(info.date) === dateKey(selectedDay) ? "day-selected" : "",
          `energy-${loads(dateKey(info.date)).level}`,
          loads(dateKey(info.date)).count ? "has-workload" : "",
        ]}
        dayCellContent={(info) => {
          if (info.view.type !== "dayGridMonth") return null;
          const key = dateKey(info.date);
          const list =
            dayCells?.lists.get(key) ??
            events.filter((e) => eventOnDay(e, key)).sort(byDayOrder);
          const spans = dayCells?.spans.get(key) ?? [],
            n = list.length;
          return (
            <div className="day-label">
              <button
                type="button"
                aria-label={`查看 ${key} 的日程${n ? `，${n} 项安排` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isPressedDate(key)) return;
                  (onShowDay || onDate)(info.date);
                }}
                className="day-number"
              >
                {info.dayNumberText.replace("日", "")}
              </button>
              {n > 0 && (
                <span className="day-dots" aria-hidden="true">
                  {list.slice(0, 3).map((e) => (
                    <i
                      key={e.id}
                      style={{ "--dot": categoryOf(e).color }}
                      className={e.completed ? "is-complete" : ""}
                    />
                  ))}
                  {n > 3 && <b className="day-more">+{n - 3}</b>}
                </span>
              )}
              {spans.map((s) => (
                <i
                  key={s.id}
                  className={`day-span${s.isStart ? " is-start" : ""}${s.isEnd ? " is-end" : ""}${s.completed ? " is-complete" : ""}`}
                  style={{ "--dot": s.color, "--track": s.track }}
                />
              ))}
            </div>
          );
        }}
        dateClick={(info) => {
          if (onShowDay && info.view.type === "dayGridMonth") {
            if (!isPressedDate(dateKey(info.date))) onShowDay(info.date);
            return;
          }
          onDate(info.date);
          onCreate({
            start: info.date,
            end: null,
            allDay: info.allDay,
            rect: info.dayEl.getBoundingClientRect(),
          });
        }}
        select={(info) => {
          dwell.close();
          onDate(info.start);
          onCreate({
            start: info.start,
            end: info.end,
            allDay: info.allDay,
            rect: null,
          });
          ref.current?.getApi().unselect();
        }}
        eventClick={(info) => {
          onDate(localDate(info.event.start));
          onEdit(info.event.id, info.el.getBoundingClientRect());
        }}
        eventDrop={move}
        eventResize={move}
        eventContent={renderEvent}
        eventDragStart={() => {
          dwell.close();
          cancelled.current = false;
          gestureActive.current = true;
          setGesture("移到想去的时间，松手即可");
        }}
        eventDragStop={endGesture}
        eventResizeStart={() => {
          dwell.close();
          cancelled.current = false;
          gestureActive.current = true;
          setGesture("调整时长，松手确认");
        }}
        eventResizeStop={endGesture}
        eventDidMount={(info) => {
          info.el.title = onShowDay
            ? `${info.event.title} · 点按编辑，长按拖动改期`
            : `${info.event.title} · 点击编辑，右键删除，拖动改期`;
          info.el.tabIndex = 0;
          info.el.setAttribute("role", "button");
          info.el.setAttribute(
            "aria-label",
            `${info.event.title}，${onShowDay ? "点按编辑" : "回车编辑，右键删除"}`,
          );
          info.el.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onShowDay) return;
            if (onDeleteRef.current) onDeleteRef.current(info.event.id);
            else onContextRef.current?.({ id: info.event.id, x: e.clientX, y: e.clientY });
          };
          info.el.onkeydown = (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onDate(localDate(info.event.start));
              onEdit(info.event.id, info.el.getBoundingClientRect());
            }
          };
        }}
        eventWillUnmount={(info) => {
          info.el.oncontextmenu = null;
          info.el.onkeydown = null;
        }}
        moreLinkContent={(arg) => `+${arg.num} 项`}
      />
      </DialContext.Provider>
    </div>
  );
  return (
    <>
      {calendar}
      <DayPreview
        open={dwell.open}
        cardRef={dwell.cardRef}
        onHold={dwell.hold}
        onRelease={dwell.release}
        onClose={dwell.close}
        placement="top"
        resolve={resolve}
        onEdit={(event, rect) => {
          onDate(localDate(dwell.open?.key ?? event.start));
          onEdit(event.id, rect);
          dwell.close();
        }}
        onDelete={onDelete}
        onRowPointerDown={view === "dayGridMonth" ? startRowDrag : undefined}
        hidden={Boolean(chip)}
        emptyHint={
          view === "dayGridMonth" ? "点击格子即可新建" : "点击时间轴即可新建"
        }
      />
      <DragChip drag={chip} pointerX={chipX} pointerY={chipY} />
    </>
  );
});
export default CalendarCanvas;
