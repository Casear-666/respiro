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
  let hit = heatCache.get(count);
  if (!hit) {
    hit = energyForCount(count);
    heatCache.set(count, hit);
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
    onMove,
    onRange,
    onContext,
  },
  ref,
) {
  const [gesture, setGesture] = useState("");
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
  const loadMap = useMemo(() => {
    if (!gridDays) return null;
    return rangeLoads(heatEvents, localDate(range.start), gridDays);
  }, [heatEvents, range, gridDays]);
  const loads = useCallback(
    (key) => loadMap?.get(key) ?? dayLoad(heatEvents, key),
    [loadMap, heatEvents],
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
        heat = heatFor(load.count);
      const viewType = ref.current?.getApi()?.view.type ?? view;
      const { prev, next } = rowNeighbors(date, {
        firstDay: settings.weekStart,
        showWeekends: settings.showWeekends,
        single: viewType === "timeGridDay",
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
        const count = loads(neighbor).count;
        return count ? heatFor(count).cell : "transparent";
      };
      setVar(element, "--day-heat", load.count ? heat.cell : "transparent");
      setVar(element, "--day-heat-ink", heat.ink);
      setVar(element, "--heat-prev", bleed(prev));
      setVar(element, "--heat-next", bleed(next));
      element.dataset.busyCount = String(load.count);
    },
    [loads, settings.weekStart, settings.showWeekends, view, ref],
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
        header.style.setProperty(
          "--day-heat-ink",
          heatFor(loads(key).count).ink,
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
    [ref, loads],
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
    }),
    [dayCells, visibleEvents, loads, levels],
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
  const renderEvent = (info) => {
    const event = info.event,
      category = categoryOf(event.extendedProps),
      level = levels.get(event.id) || 1;
    const heat = energyForCount(level);
    return (
      <div
        className={`event-tile ${event.extendedProps.completed ? "is-complete" : ""}`}
        data-energy-count={level}
        data-event-id={event.id}
        title={`${event.title} · ${level} 项同时重叠 · ${heat.label}`}
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
    if (e.target.closest(".fc-event")) return;
    const cell = e.target.closest("[data-date]");
    if (!cell) return;
    e.preventDefault();
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
    onContext({
      x: e.clientX,
      y: e.clientY,
      date: cell.dataset.date,
      minutes,
      allDay: minutes == null,
    });
  };
  return (
    <div
      className={`time-canvas ${gesture ? "is-interacting" : ""}`}
      data-heat-tween={HEAT_TWEEN ? "" : undefined}
      onContextMenu={openSlotMenu}
      onPointerOver={overPreview}
      onPointerLeave={() => dwell.leave()}
      onFocus={focusPreview}
      onBlur={blurPreview}
      onKeyDown={keyPreview}
    >
      {gesture && (
        <div className="gesture-hint" role="status">
          {gesture}
          <kbd>Esc 取消</kbd>
        </div>
      )}
      <FullCalendar
        ref={ref}
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
        locale={zhCn}
        initialView={view}
        headerToolbar={false}
        height="100%"
        firstDay={settings.weekStart}
        weekends={settings.showWeekends}
        editable
        selectable
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
        dayHeaderContent={(info) => (
          <span className="weekday-heading">
            <span>
              {
                ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
                  info.date.getDay()
                ]
              }
            </span>
            {info.view.type !== "dayGridMonth" && (
              <strong className={info.isToday ? "is-today" : ""}>
                {info.date.getDate()}
              </strong>
            )}
          </span>
        )}
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
                  onDate(info.date);
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
          info.el.title = `${info.event.title} · 点击编辑，拖动改期`;
          info.el.tabIndex = 0;
          info.el.setAttribute("role", "button");
          info.el.setAttribute(
            "aria-label",
            `${info.event.title}，回车编辑，右键打开操作菜单`,
          );
          info.el.oncontextmenu = (e) => {
            e.preventDefault();
            onContext({ id: info.event.id, x: e.clientX, y: e.clientY });
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
        onRowPointerDown={view === "dayGridMonth" ? startRowDrag : undefined}
        hidden={Boolean(chip)}
        emptyHint={
          view === "dayGridMonth" ? "点击格子即可新建" : "点击时间轴即可新建"
        }
      />
      <DragChip drag={chip} pointerX={chipX} pointerY={chipY} />
    </div>
  );
});
export default CalendarCanvas;
