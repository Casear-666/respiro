import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React from "react";
import {
  dateKey,
  addDays,
  localDate,
  normalizeEvent,
  rowNeighbors,
  categoryOf,
} from "../../shared/domain.js";
import { energyForCount } from "../../shared/energy.js";
let dom, server, render, act, waitFor, cleanup, CalendarCanvas, ContextMenu;
before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://calendar.test/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "localStorage",
    "getComputedStyle",
    "MutationObserver",
  ])
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(
    dom.window,
  );
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(
    dom.window,
  );
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, act, waitFor, cleanup } = await import("@testing-library/react"));
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: "custom",
    plugins: [(await import("@vitejs/plugin-react")).default()],
  });
  ({ ContextMenu } = await server.ssrLoadModule("/src/planner/PlannerApp.jsx"));
  ({ default: CalendarCanvas } = await server.ssrLoadModule(
    "/src/planner/CalendarCanvas.jsx",
  ));
});
after(async () => {
  cleanup?.();
  await server?.close();
  dom?.window.close();
});
test("the actual calendar renders all-day workload colors and repaints cards and cells when overlaps change", async () => {
  const today = new Date(),
    start = dateKey(today),
    end = dateKey(addDays(today, 1));
  const moveDelta = today.getDay() === 0 ? -1 : 1;
  const source = ["a", "b", "c"].map((id, i) =>
    normalizeEvent({
      id,
      title: `繁忙着色 ${id}`,
      tag: i === 1 ? "personal" : "work",
      allDay: true,
      start,
      end,
    }),
  );
  const props = {
    ref: React.createRef(),
    events: source,
    allEvents: source,
    settings: {
      weekStart: 1,
      showWeekends: true,
      workStart: "08:00",
      workEnd: "22:00",
    },
    view: "timeGridWeek",
    selectedDay: today,
    onRange: () => {},
    onDate: () => {},
    onCreate: () => {},
    onEdit: () => {},
    onMove: () => {},
    onContext: () => {},
  };
  const mounted = render(React.createElement(CalendarCanvas, props));
  await waitFor(() =>
    assert.equal(mounted.container.querySelectorAll(".event-tile").length, 3),
  );
  for (const tile of mounted.container.querySelectorAll(".event-tile")) {
    assert.equal(tile.dataset.energyCount, "3");
    assert.equal(
      tile.style.getPropertyValue("--event-heat"),
      energyForCount(3).gradient,
    );
  }
  const day = () =>
    mounted.container.querySelector(`.fc-daygrid-day[data-date="${start}"]`);
  await waitFor(() => assert.equal(day().dataset.busyCount, "3"));
  assert.ok(day().style.getPropertyValue("--day-heat").includes("0.160"));
  // FullCalendar's public gesture callbacks must preview the same heat without committing data.
  await act(async () =>
    props.ref.current.getApi().getOption("eventDragStart")({}),
  );
  await act(async () =>
    props.ref.current.getApi().getOption("eventAllow")(
      {
        start: addDays(today, moveDelta),
        end: addDays(today, moveDelta + 1),
        allDay: true,
      },
      { id: "c" },
    ),
  );
  await waitFor(() =>
    assert.equal(
      mounted.container.querySelector('[data-event-id="a"]').dataset
        .energyCount,
      "2",
    ),
  );
  assert.equal(source[2].start, start);
  await act(async () =>
    props.ref.current.getApi().getOption("eventDragStop")({}),
  );
  await waitFor(() =>
    assert.equal(
      mounted.container.querySelector('[data-event-id="a"]').dataset
        .energyCount,
      "3",
    ),
  );
  const moved = [
    source[0],
    source[1],
    {
      ...source[2],
      start: dateKey(addDays(today, moveDelta)),
      end: dateKey(addDays(today, moveDelta + 1)),
    },
  ];
  await act(async () =>
    mounted.rerender(
      React.createElement(CalendarCanvas, {
        ...props,
        events: moved,
        allEvents: moved,
      }),
    ),
  );
  await waitFor(() =>
    assert.equal(
      mounted.container.querySelector('[data-event-id="a"]').dataset
        .energyCount,
      "2",
    ),
  );
  assert.equal(
    mounted.container.querySelector('[data-event-id="c"]').dataset.energyCount,
    "1",
  );
  await waitFor(() => assert.equal(day().dataset.busyCount, "2"));
  assert.equal(
    mounted.container
      .querySelector('[data-event-id="a"]')
      .style.getPropertyValue("--event-heat"),
    energyForCount(2).gradient,
  );
});
test("month view drops event rows and paints dots, spans and neighbor heat into the cells", async () => {
  globalThis.CSS ??= { escape: (value) => String(value) };
  const today = new Date(),
    start = dateKey(today),
    end = dateKey(addDays(today, 1));
  const { prev, next } = rowNeighbors(today, { firstDay: 1 });
  const mateKey = [prev, next].find(
    (key) => localDate(key).getMonth() === today.getMonth(),
  );
  const tags = ["work", "meeting", "personal", "urgent", "other"];
  const source = tags.map((tag, i) =>
    normalizeEvent({
      id: `m-${i}`,
      title: `格子 ${i}`,
      tag,
      allDay: true,
      start,
      end,
    }),
  );
  if (mateKey)
    source.push(
      normalizeEvent({
        id: "mate",
        title: "邻日",
        tag: "work",
        allDay: true,
        start: mateKey,
        end: dateKey(addDays(mateKey, 1)),
      }),
    );
  let rangeInfo = null;
  const props = {
    ref: React.createRef(),
    events: source,
    allEvents: source,
    settings: {
      weekStart: 1,
      showWeekends: true,
      workStart: "08:00",
      workEnd: "22:00",
    },
    view: "dayGridMonth",
    selectedDay: today,
    range: null,
    onRange: (info) => {
      rangeInfo = { start: info.startStr, end: info.endStr };
    },
    onDate: () => {},
    onCreate: () => {},
    onEdit: () => {},
    onMove: () => {},
    onContext: () => {},
  };
  const mounted = render(React.createElement(CalendarCanvas, props));
  const day = () =>
    mounted.container.querySelector(`.fc-daygrid-day[data-date="${start}"]`);
  await waitFor(() => assert.ok(rangeInfo && day()));
  await act(async () =>
    mounted.rerender(
      React.createElement(CalendarCanvas, { ...props, range: rangeInfo }),
    ),
  );
  assert.equal(mounted.container.querySelectorAll(".fc-event").length, 0);
  assert.equal(mounted.container.querySelectorAll(".event-tile").length, 0);
  await waitFor(() => assert.equal(day().dataset.busyCount, "5"));
  const dots = day().querySelectorAll(".day-dots > i");
  assert.equal(dots.length, 3);
  assert.deepEqual(
    [...dots].map((dot) => dot.style.getPropertyValue("--dot")),
    source.slice(0, 3).map((e) => categoryOf(e).color),
  );
  assert.equal(day().querySelector(".day-more").textContent, "+2");
  assert.equal(
    day().querySelector(".day-number").getAttribute("aria-label"),
    `查看 ${start} 的日程，5 项安排`,
  );
  if (mateKey) {
    const mate = mounted.container.querySelector(
      `.fc-daygrid-day[data-date="${mateKey}"]`,
    );
    const side = mateKey < start ? "--heat-next" : "--heat-prev";
    assert.equal(
      mate.style.getPropertyValue(side),
      day().style.getPropertyValue("--day-heat"),
    );
  }
  const otherCell = mounted.container.querySelector(".fc-day-other");
  if (otherCell) {
    assert.equal(otherCell.style.getPropertyValue("--heat-prev"), "transparent");
    assert.equal(otherCell.style.getPropertyValue("--heat-next"), "transparent");
  }
  const keys = [...mounted.container.querySelectorAll(".fc-daygrid-day")]
    .map((cell) => cell.dataset.date)
    .filter(Boolean);
  let spanStart,
    spanEnd;
  for (let i = 0; i + 1 < keys.length && !spanStart; i++) {
    const blocked = new Set([start, mateKey]);
    if (
      dateKey(addDays(keys[i], 1)) === keys[i + 1] &&
      !blocked.has(keys[i]) &&
      !blocked.has(keys[i + 1])
    ) {
      spanStart = keys[i];
      spanEnd = keys[i + 1];
    }
  }
  assert.ok(spanStart);
  const withSpan = [
    ...source,
    normalizeEvent({
      id: "stretch",
      title: "跨日",
      tag: "meeting",
      allDay: true,
      start: spanStart,
      end: dateKey(addDays(spanEnd, 1)),
    }),
  ];
  await act(async () =>
    mounted.rerender(
      React.createElement(CalendarCanvas, {
        ...props,
        range: rangeInfo,
        events: withSpan,
        allEvents: withSpan,
      }),
    ),
  );
  await waitFor(() =>
    assert.ok(
      mounted.container.querySelector(
        `.fc-daygrid-day[data-date="${spanStart}"] .day-span.is-start`,
      ),
    ),
  );
  assert.ok(
    mounted.container.querySelector(
      `.fc-daygrid-day[data-date="${spanEnd}"] .day-span.is-end`,
    ),
  );
  await act(async () =>
    mounted.rerender(
      React.createElement(CalendarCanvas, {
        ...props,
        range: rangeInfo,
        events: withSpan,
        allEvents: withSpan,
        flash: { id: "m-0", at: Date.now() },
      }),
    ),
  );
  await waitFor(() =>
    assert.ok(
      day().querySelector(".fc-daygrid-day-frame.flash-target"),
    ),
  );
});
const dwellProps = (events, extra = {}) => ({
  ref: React.createRef(),
  events,
  allEvents: events,
  settings: {
    weekStart: 1,
    showWeekends: true,
    workStart: "08:00",
    workEnd: "22:00",
  },
  view: "dayGridMonth",
  selectedDay: new Date(),
  range: null,
  onRange: () => {},
  onDate: () => {},
  onCreate: () => {},
  onEdit: () => {},
  onMove: () => {},
  onContext: () => {},
  ...extra,
});
const allday = (id, start, end, extra = {}) =>
  normalizeEvent({ id, title: `预览 ${id}`, tag: "work", allDay: true, start, end, ...extra });
const fire = (node, type, init = {}) =>
  node.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, button: 0, ...init }),
  );
const monthSetup = async (events, extra = {}) => {
  cleanup();
  let rangeInfo = null;
  const props = dwellProps(events, {
    ...extra,
    onRange: (info) => {
      rangeInfo = { start: info.startStr, end: info.endStr };
    },
  });
  const mounted = render(React.createElement(CalendarCanvas, props));
  const first = await waitFor(() => {
    const cell = mounted.container.querySelector(".fc-daygrid-day[data-date]");
    assert.ok(cell);
    return cell;
  });
  await act(async () =>
    mounted.rerender(
      React.createElement(CalendarCanvas, { ...props, range: rangeInfo }),
    ),
  );
  return { mounted, props, first };
};
const previewCard = () => document.querySelector(".day-preview-card");
test("moving through the preview and across adjacent dates keeps the last day's preview open", async () => {
  const today = new Date();
  const firstDay = dateKey(new Date(today.getFullYear(), today.getMonth(), 10));
  const secondDay = dateKey(addDays(firstDay, 1));
  const thirdDay = dateKey(addDays(firstDay, 2));
  const { mounted } = await monthSetup([
    allday("first", firstDay, secondDay),
    allday("second", secondDay, thirdDay),
  ]);
  const cell = (key) => mounted.container.querySelector(`.fc-daygrid-day[data-date="${key}"]`);
  const over = (target, from) => fire(target, "pointerover", { relatedTarget: from });
  const first = cell(firstDay);
  const second = cell(secondDay);
  const third = cell(thirdDay);
  await act(async () => over(first, null));
  await waitFor(() => assert.equal(previewCard()?.dataset.date, firstDay));
  const item = previewCard().querySelector(".day-preview-item");
  await act(async () => {
    fire(first, "pointerout", { relatedTarget: item });
    over(item, first);
    over(item.querySelector(".day-preview-title"), item);
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  assert.equal(previewCard()?.dataset.date, firstDay);
  await act(async () => {
    fire(item, "pointerout", { relatedTarget: second });
    over(second, item);
  });
  await waitFor(() => assert.equal(previewCard()?.dataset.date, second.dataset.date));
  assert.deepEqual([...previewCard().querySelectorAll(".day-preview-title")].map((el) => el.textContent), ["预览 second"]);
  const gap = mounted.container.querySelector(".fc-view-harness");
  await act(async () => {
    over(gap, second);
    over(gap.firstElementChild, gap);
    over(third, gap.firstElementChild);
  });
  await waitFor(() => assert.equal(previewCard()?.dataset.date, third.dataset.date));
  assert.match(previewCard().textContent, /留白时光/);
});
test("dwell lifts a busy month cell then opens a preview card", async () => {
  const today = dateKey(new Date());
  const events = [
    allday("a", today, dateKey(addDays(today, 1))),
    allday("b", today, dateKey(addDays(today, 1))),
  ];
  const { mounted } = await monthSetup(events);
  const cell = mounted.container.querySelector(
    `.fc-daygrid-day[data-date="${today}"]`,
  );
  const frame = cell.querySelector(".fc-daygrid-day-frame");
  await act(async () => {
    fire(cell, "pointerover", { pointerType: "mouse" });
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(frame.classList.contains("is-dwell"), false);
  await waitFor(() => assert.ok(frame.classList.contains("is-dwell")), {
    timeout: 500,
  });
  await waitFor(() => assert.ok(previewCard()), { timeout: 800 });
  assert.equal(previewCard().dataset.date, today);
  assert.equal(
    previewCard().querySelectorAll(".day-preview-item").length,
    2,
  );
  assert.match(previewCard().querySelector(".day-preview-summary").textContent, /2 项安排/);
  const idle = mounted.container.querySelector(".fc-view-harness");
  await act(async () =>
    fire(idle, "pointerover", { pointerType: "mouse" }),
  );
  await waitFor(
    () => {
      assert.ok(!previewCard());
      assert.equal(frame.classList.contains("is-dwell"), false);
    },
    { timeout: 700 },
  );
});
test("a fast sweep across cells never lifts or opens", async () => {
  const events = [allday("a", dateKey(new Date()), dateKey(addDays(new Date(), 1)))];
  const { mounted } = await monthSetup(events);
  const cells = [
    ...mounted.container.querySelectorAll(".fc-daygrid-day[data-date]"),
  ].slice(0, 4);
  for (const cell of cells) {
    await act(async () => fire(cell, "pointerover", { pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 40));
  }
  await act(async () =>
    fire(
      mounted.container.querySelector(".fc-view-harness"),
      "pointerover",
      { pointerType: "mouse" },
    ),
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!previewCard());
  assert.ok(!mounted.container.querySelector(".is-dwell"));
});
test("Escape closes the preview card", async () => {
  const events = [allday("a", dateKey(new Date()), dateKey(addDays(new Date(), 1)))];
  const { mounted } = await monthSetup(events);
  const cell = mounted.container.querySelector(".fc-daygrid-day[data-date]");
  await act(async () => fire(cell, "pointerover", { pointerType: "mouse" }));
  await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
  await act(async () => {
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    window.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await waitFor(() => assert.ok(!previewCard()), { timeout: 500 });
});
test("an empty cell previews as open space with the empty hint", async () => {
  const { mounted } = await monthSetup([
    allday("a", dateKey(new Date()), dateKey(addDays(new Date(), 1))),
  ]);
  const empty = [
    ...mounted.container.querySelectorAll(".fc-daygrid-day[data-date]"),
  ].find((cell) => cell.dataset.busyCount === "0");
  await act(async () => fire(empty, "pointerover", { pointerType: "mouse" }));
  await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
  assert.match(previewCard().textContent, /留白时光/);
  assert.ok(!previewCard().querySelector(".day-preview-item"));
  assert.match(previewCard().textContent, /点击格子即可新建/);
  assert.ok(previewCard().classList.contains("is-empty"));
});
test("back-to-back spans land on separate tracks on the shared day", async () => {
  const today = new Date();
  const key = dateKey(today);
  const { mounted } = await monthSetup([
    allday("a", dateKey(addDays(today, -1)), dateKey(addDays(today, 1))),
    allday("b", key, dateKey(addDays(today, 2))),
  ]);
  const shared = mounted.container.querySelector(
    `.fc-daygrid-day[data-date="${key}"]`,
  );
  const tracks = [...shared.querySelectorAll(".day-span")].map((el) =>
    el.style.getPropertyValue("--track"),
  );
  assert.deepEqual(tracks.sort(), ["0", "1"]);
});
test("dragging a preview row drops it on a new date with live heat preview", async () => {
  const today = new Date();
  const source = dateKey(today);
  const events = [
    allday("a", source, dateKey(addDays(today, 1))),
    allday("b", source, dateKey(addDays(today, 1))),
  ];
  const moves = [];
  const { mounted } = await monthSetup(events, {
    onMove: (...args) => moves.push(args),
  });
  const sourceCell = mounted.container.querySelector(
    `.fc-daygrid-day[data-date="${source}"]`,
  );
  const targetCell = [
    ...mounted.container.querySelectorAll(".fc-daygrid-day[data-date]"),
  ].find(
    (cell) => cell.dataset.date !== source && cell.dataset.busyCount === "0",
  );
  const targetKey = targetCell.dataset.date;
  const frame = targetCell.querySelector(".fc-daygrid-day-frame");
  await act(async () =>
    fire(sourceCell, "pointerover", { pointerType: "mouse" }),
  );
  await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
  const row = previewCard().querySelector(".day-preview-item");
  const realFromPoint = document.elementFromPoint;
  document.elementFromPoint = () => frame;
  try {
    await act(async () => {
      fire(row, "pointerdown", { clientX: 100, clientY: 100 });
      fire(document, "pointermove", { clientX: 104, clientY: 104 });
      fire(document, "pointermove", { clientX: 120, clientY: 120 });
    });
    await waitFor(() => assert.ok(document.querySelector(".drag-chip")), {
      timeout: 500,
    });
    await waitFor(
      () => {
        const transform =
          document.querySelector(".drag-chip")?.style.transform ?? "";
        assert.match(transform, /translateX\(120px\)/);
        assert.match(transform, /translateY\(120px\)/);
      },
      { timeout: 800 },
    );
    await waitFor(
      () => assert.ok(frame.classList.contains("is-drop-target")),
      { timeout: 800 },
    );
    await waitFor(
      () => assert.equal(targetCell.dataset.busyCount, "1"),
      { timeout: 800 },
    );
    await act(async () =>
      fire(document, "pointerup", { clientX: 120, clientY: 120 }),
    );
    const delta = Math.round(
      (localDate(targetKey) - localDate(source)) / 86400000,
    );
    const expected = {
      start: dateKey(addDays(source, delta)),
      end: dateKey(addDays(dateKey(addDays(today, 1)), delta)),
    };
    await waitFor(() =>
      assert.deepEqual(
        moves[0],
        ["a", expected.start, expected.end, true],
      ),
    );
    assert.ok(!document.querySelector(".is-drop-target"));
    assert.equal(
      document.documentElement.classList.contains("is-dragging-event"),
      false,
    );
  } finally {
    document.elementFromPoint = realFromPoint;
  }
});
test("Escape during a preview-row drag cancels without moving", async () => {
  const source = dateKey(new Date());
  const events = [allday("a", source, dateKey(addDays(new Date(), 1)))];
  const moves = [];
  const { mounted } = await monthSetup(events, {
    onMove: (...args) => moves.push(args),
  });
  const sourceCell = mounted.container.querySelector(
    `.fc-daygrid-day[data-date="${source}"]`,
  );
  const targetCell = [
    ...mounted.container.querySelectorAll(".fc-daygrid-day[data-date]"),
  ].find(
    (cell) => cell.dataset.date !== source && cell.dataset.busyCount === "0",
  );
  const frame = targetCell.querySelector(".fc-daygrid-day-frame");
  await act(async () =>
    fire(sourceCell, "pointerover", { pointerType: "mouse" }),
  );
  await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
  const row = previewCard().querySelector(".day-preview-item");
  const realFromPoint = document.elementFromPoint;
  document.elementFromPoint = () => frame;
  try {
    await act(async () => {
      fire(row, "pointerdown", { clientX: 100, clientY: 100 });
      fire(document, "pointermove", { clientX: 130, clientY: 130 });
    });
    await waitFor(() => assert.ok(document.querySelector(".drag-chip")), {
      timeout: 600,
    });
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(moves.length, 0);
    await waitFor(() => assert.equal(sourceCell.dataset.busyCount, "1"), {
      timeout: 500,
    });
    assert.ok(!document.querySelector(".is-drop-target"));
  } finally {
    document.elementFromPoint = realFromPoint;
  }
});
test("release hit-tests the pointer position, not the stale rAF target", async () => {
  const today = new Date();
  const source = dateKey(today);
  const events = [allday("a", source, dateKey(addDays(today, 1)))];
  const moves = [];
  const { mounted } = await monthSetup(events, {
    onMove: (...args) => moves.push(args),
  });
  const sourceCell = mounted.container.querySelector(
    `.fc-daygrid-day[data-date="${source}"]`,
  );
  const empties = [
    ...mounted.container.querySelectorAll(".fc-daygrid-day[data-date]"),
  ].filter(
    (cell) => cell.dataset.date !== source && cell.dataset.busyCount === "0",
  );
  const [aCell, bCell] = empties;
  const realFromPoint = document.elementFromPoint;
  let hit = aCell;
  document.elementFromPoint = () => hit;
  try {
    await act(async () =>
      fire(sourceCell, "pointerover", { pointerType: "mouse" }),
    );
    await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
    let row = previewCard().querySelector(".day-preview-item");
    await act(async () => {
      fire(row, "pointerdown", { clientX: 100, clientY: 100 });
      fire(document, "pointermove", { clientX: 120, clientY: 120 });
    });
    await waitFor(
      () =>
        assert.ok(
          aCell
            .querySelector(".fc-daygrid-day-frame")
            .classList.contains("is-drop-target"),
        ),
      { timeout: 800 },
    );
    hit = bCell;
    await act(async () =>
      fire(document, "pointerup", { clientX: 200, clientY: 200 }),
    );
    const delta = Math.round(
      (localDate(bCell.dataset.date) - localDate(source)) / 86400000,
    );
    await waitFor(() =>
      assert.deepEqual(moves[0], [
        "a",
        dateKey(addDays(source, delta)),
        dateKey(addDays(dateKey(addDays(today, 1)), delta)),
        true,
      ]),
    );

    await act(async () =>
      fire(sourceCell, "pointerover", { pointerType: "mouse" }),
    );
    await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
    row = previewCard().querySelector(".day-preview-item");
    hit = aCell;
    await act(async () => {
      fire(row, "pointerdown", { clientX: 100, clientY: 100 });
      fire(document, "pointermove", { clientX: 120, clientY: 120 });
    });
    await waitFor(
      () =>
        assert.ok(
          aCell
            .querySelector(".fc-daygrid-day-frame")
            .classList.contains("is-drop-target"),
        ),
      { timeout: 800 },
    );
    hit = null;
    const before = moves.length;
    await act(async () =>
      fire(document, "pointerup", { clientX: 400, clientY: 400 }),
    );
    assert.equal(moves.length, before);
    assert.ok(!document.querySelector(".is-drop-target"));
    assert.equal(
      document.documentElement.classList.contains("is-dragging-event"),
      false,
    );
  } finally {
    document.elementFromPoint = realFromPoint;
  }
});
test("clicking a preview row without moving opens the editor", async () => {
  const events = [
    allday("a", dateKey(new Date()), dateKey(addDays(new Date(), 1))),
    allday("b", dateKey(new Date()), dateKey(addDays(new Date(), 1))),
  ];
  const edits = [];
  const { mounted } = await monthSetup(events, {
    onEdit: (id, rect) => edits.push(id),
  });
  const cell = mounted.container.querySelector(
    `.fc-daygrid-day[data-date="${dateKey(new Date())}"]`,
  );
  await act(async () => fire(cell, "pointerover", { pointerType: "mouse" }));
  await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
  const rows = previewCard().querySelectorAll(".day-preview-item");
  await act(async () =>
    fire(rows[0], "pointerdown", { clientX: 100, clientY: 100 }),
  );
  await act(async () =>
    fire(document, "pointerup", { clientX: 100, clientY: 100 }),
  );
  assert.ok(previewCard());
  await act(async () =>
    rows[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
  );
  assert.deepEqual(edits, ["a"]);
  await act(async () => fire(cell, "pointerover", { pointerType: "mouse" }));
  await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
  const second = previewCard().querySelectorAll(".day-preview-item")[1];
  await act(async () => {
    fire(second, "pointerdown", { clientX: 100, clientY: 100 });
    fire(document, "pointerup", { clientX: 100, clientY: 100 });
  });
  await act(async () =>
    second.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
  );
  assert.deepEqual(edits, ["a", "b"]);
});
test("a reopened preview anchors at the new cell immediately", async () => {
  const events = [allday("a", dateKey(new Date()), dateKey(addDays(new Date(), 1)))];
  const { mounted } = await monthSetup(events);
  const cells = [
    ...mounted.container.querySelectorAll(".fc-daygrid-day[data-date]"),
  ].slice(8, 10);
  cells[0].getBoundingClientRect = () => ({
    left: 200, top: 200, right: 280, bottom: 240, width: 80, height: 40,
  });
  cells[1].getBoundingClientRect = () => ({
    left: 400, top: 300, right: 480, bottom: 340, width: 80, height: 40,
  });
  const firstLayout = new Map();
  const observer = new MutationObserver(() => {
    const card = previewCard();
    if (!card || firstLayout.has(card.dataset.date)) return;
    const { left, top, visibility } = card.parentElement.style;
    firstLayout.set(card.dataset.date, [left, top, visibility]);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributeFilter: ["data-date"] });
  try {
    await act(async () => fire(cells[0], "pointerover", { pointerType: "mouse" }));
    await waitFor(() => assert.deepEqual(firstLayout.get(cells[0].dataset.date), ["240px", "192px", "visible"]));
    await act(async () =>
      fire(mounted.container.querySelector(".fc-view-harness"), "pointerover", { pointerType: "mouse" }),
    );
    await waitFor(() => assert.ok(!previewCard()), { timeout: 700 });
    await act(async () => fire(cells[1], "pointerover", { pointerType: "mouse" }));
    await waitFor(() => assert.deepEqual(firstLayout.get(cells[1].dataset.date), ["440px", "292px", "visible"]));
  } finally {
    observer.disconnect();
  }
});
test("hovering a week header cell previews that day", async () => {
  const events = [
    allday("a", dateKey(new Date()), dateKey(addDays(new Date(), 1))),
  ];
  const { mounted } = await monthSetup(events, { view: "timeGridWeek" });
  const header = await waitFor(() => {
    const cell = mounted.container.querySelector(
      `.fc-col-header-cell[data-date="${dateKey(new Date())}"]`,
    );
    assert.ok(cell);
    return cell;
  });
  await act(async () =>
    fire(header, "pointerover", { pointerType: "mouse" }),
  );
  await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
  assert.equal(previewCard().dataset.date, header.dataset.date);
  assert.match(previewCard().textContent, /1 项安排/);
});

test("the dial renders overlapping bookings, opens the editor, and steps by day", async () => {
  const today = dateKey(new Date());
  const events = [["a", "09", "11"], ["b", "10", "12"]].map(([id, from, to]) =>
    normalizeEvent({ id, title: id, start: today + "T" + from + ":00", end: today + "T" + to + ":00" }),
  );
  const ref = React.createRef();
  let edited;
  const mounted = render(React.createElement(CalendarCanvas, {
    ref, events, allEvents: events, view: "energyDial", selectedDay: new Date(),
    settings: { weekStart: 1, showWeekends: true }, onRange() {},
    onEdit(id) { edited = id; },
  }));
  try {
    await waitFor(() => assert.equal(mounted.container.querySelectorAll(".dial-arc").length, 2));
    assert.equal(mounted.container.querySelector(".dial-center strong").textContent, "3时0分");
    assert.equal(mounted.container.querySelectorAll(".dial-track").length, 2);
    const widths = [...mounted.container.querySelectorAll(".dial-arc")].map((p) => p.getAttribute("stroke-width"));
    assert.equal(new Set(widths).size, 1);
    assert.ok([...mounted.container.querySelectorAll(".dial-arc")].every((p) => p.getAttribute("stroke-linecap") === "round"));
    mounted.container.querySelector(".dial-agenda button").click();
    assert.equal(edited, "a");
    await act(async () => ref.current.getApi().next());
    await waitFor(() => assert.equal(mounted.container.querySelectorAll(".dial-arc").length, 0));
    assert.equal(dateKey(ref.current.getApi().getDate()), dateKey(addDays(today, 1)));
  } finally {
    mounted.unmount();
  }
});

test("right-clicking events across week view, month preview, and day dial triggers onDelete directly", async () => {
  const today = dateKey(new Date());
  const events = [
    normalizeEvent({
      id: "rc-1",
      title: "周视图右键删除",
      start: `${today}T09:00:00`,
      end: `${today}T10:00:00`,
    }),
    normalizeEvent({
      id: "rc-2",
      title: "表盘与预览右键删除",
      start: `${today}T14:00:00`,
      end: `${today}T15:00:00`,
    }),
  ];
  const deleted = [];
  const contexts = [];
  // 1. Week view .fc-event
  const weekMount = render(
    React.createElement(CalendarCanvas, {
      ref: React.createRef(),
      events,
      allEvents: events,
      settings: { weekStart: 1, showWeekends: true, workStart: "08:00", workEnd: "22:00" },
      view: "timeGridWeek",
      selectedDay: new Date(),
      onRange: () => {},
      onDate: () => {},
      onCreate: () => {},
      onEdit: () => {},
      onMove: () => {},
      onDelete: (id) => deleted.push(["week", id]),
      onContext: (ctx) => contexts.push(ctx),
    }),
  );
  try {
    const fcEvent = await waitFor(() => {
      const node = weekMount.container.querySelector('[data-event-id="rc-1"]')?.closest(".fc-event");
      assert.ok(node);
      return node;
    });
    const ev = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    await act(async () => fcEvent.dispatchEvent(ev));
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual(deleted, [["week", "rc-1"]]);
    assert.equal(contexts.length, 0);
  } finally {
    weekMount.unmount();
  }

  // 2. Month view DayPreview item
  const { mounted: monthMount } = await monthSetup(events, {
    onDelete: (id) => deleted.push(["preview", id]),
  });
  try {
    const cell = monthMount.container.querySelector(`.fc-daygrid-day[data-date="${today}"]`);
    await act(async () => fire(cell, "pointerover", { pointerType: "mouse" }));
    await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
    const item = previewCard().querySelector('.day-preview-item[data-event-id="rc-2"]');
    assert.ok(item);
    const ev = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    await act(async () => item.dispatchEvent(ev));
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual(deleted.at(-1), ["preview", "rc-2"]);
  } finally {
    monthMount.unmount();
  }

  // 3. DayDial arc and agenda entry
  const dialMount = render(
    React.createElement(CalendarCanvas, {
      ref: React.createRef(),
      events,
      allEvents: events,
      view: "energyDial",
      selectedDay: new Date(),
      settings: { weekStart: 1, showWeekends: true },
      onRange: () => {},
      onDelete: (id) => deleted.push(["dial", id]),
    }),
  );
  try {
    await waitFor(() => assert.equal(dialMount.container.querySelectorAll(".dial-arc").length, 2));
    const entry = dialMount.container.querySelector(".dial-entry");
    const entryEv = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    await act(async () => entry.dispatchEvent(entryEv));
    assert.equal(entryEv.defaultPrevented, true);
    assert.deepEqual(deleted.at(-1), ["dial", "rc-1"]);

    const arc = dialMount.container.querySelectorAll(".dial-arc")[1];
    const arcEv = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    await act(async () => arc.dispatchEvent(arcEv));
    assert.equal(arcEv.defaultPrevented, true);
    assert.deepEqual(deleted.at(-1), ["dial", "rc-2"]);
  } finally {
    dialMount.unmount();
  }
});

test("right-clicking a dial event removes it from both the dial face and agenda list and updates total duration", async () => {
  const today = dateKey(new Date());
  const initial = [
    normalizeEvent({ id: "d1", title: "早会", start: `${today}T09:00:00`, end: `${today}T10:00:00` }),
    normalizeEvent({ id: "d2", title: "下午专注", start: `${today}T14:00:00`, end: `${today}T16:00:00` }),
  ];
  function StatefulDial() {
    const ref = React.useRef(null);
    const [list, setList] = React.useState(initial);
    return React.createElement(CalendarCanvas, {
      ref,
      events: list,
      allEvents: list,
      view: "energyDial",
      selectedDay: new Date(),
      settings: { weekStart: 1, showWeekends: true },
      onRange: () => {},
      onDelete: (id) => setList((prev) => prev.filter((e) => e.id !== id)),
    });
  }
  const mounted = render(React.createElement(StatefulDial));
  try {
    await waitFor(() => assert.equal(mounted.container.querySelectorAll(".dial-arc").length, 2));
    assert.equal(mounted.container.querySelector(".dial-center strong").textContent, "3时0分");
    await act(async () =>
      mounted.container.querySelector(".dial-arc").dispatchEvent(
        new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      ),
    );
    await waitFor(() => assert.equal(mounted.container.querySelectorAll(".dial-entry").length, 1));
    await waitFor(() => assert.equal(mounted.container.querySelector(".dial-center strong").textContent, "2时0分"));
    assert.match(mounted.container.querySelector(".dial-entry").textContent, /下午专注/);

    await act(async () =>
      mounted.container.querySelector(".dial-entry").dispatchEvent(
        new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      ),
    );
    await waitFor(() => assert.equal(mounted.container.querySelectorAll(".dial-entry").length, 0));
    assert.equal(mounted.container.querySelector(".dial-center strong").textContent, "0时0分");
  } finally {
    mounted.unmount();
  }
});

test("right-clicking a month cell opens context menu with per-event and batch delete actions", async () => {
  const today = dateKey(new Date());
  const nextDay = dateKey(addDays(today, 1));
  const events = [
    normalizeEvent({
      id: "m-2",
      title: "方案评审",
      tag: "meeting",
      allDay: false,
      start: `${today}T14:00:00`,
      end: `${today}T15:30:00`,
    }),
    normalizeEvent({
      id: "m-1",
      title: "晨间规划",
      tag: "work",
      allDay: true,
      start: today,
      end: nextDay,
    }),
  ];
  const contexts = [];
  const { mounted } = await monthSetup(events, {
    onContext: (ctx) => contexts.push(ctx),
  });
  try {
    const emptyCell = [...mounted.container.querySelectorAll(".fc-daygrid-day[data-date]")].find(
      (el) => el.dataset.busyCount === "0",
    );
    assert.ok(emptyCell);
    const emptyEv = new window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 80,
      clientY: 90,
    });
    await act(async () => emptyCell.dispatchEvent(emptyEv));
    assert.equal(emptyEv.defaultPrevented, true);
    assert.equal(contexts.at(-1).date, emptyCell.dataset.date);
    assert.deepEqual(contexts.at(-1).events, []);

    const busyCell = mounted.container.querySelector(`.fc-daygrid-day[data-date="${today}"]`);
    assert.ok(busyCell);
    const busyEv = new window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 120,
      clientY: 160,
    });
    await act(async () => busyCell.dispatchEvent(busyEv));
    assert.equal(busyEv.defaultPrevented, true);
    const ctx = contexts.at(-1);
    assert.equal(ctx.date, today);
    assert.equal(ctx.allDay, true);
    assert.deepEqual(
      ctx.events.map((e) => e.id),
      ["m-1", "m-2"],
    );

    const deletedSingle = [];
    const deletedBatch = [];
    let closedCount = 0;
    const menuMount = render(
      React.createElement(ContextMenu, {
        context: ctx,
        event: null,
        dayEvents: ctx.events,
        canPaste: false,
        onClose: () => {
          closedCount += 1;
        },
        onCreateHere: () => {},
        onPasteHere: () => {},
        onDeleteEvent: (id) => deletedSingle.push(id),
        onDeleteDayEvents: (ids) => deletedBatch.push(ids),
      }),
    );
    try {
      const menu = menuMount.container.querySelector(".context-menu");
      assert.ok(menu);
      assert.match(menu.textContent, /在此新建日程/);
      assert.match(menu.textContent, /粘贴到这一天/);
      const itemDeletes = [...menu.querySelectorAll(".context-menu-event-delete")];
      assert.deepEqual(
        itemDeletes.map((btn) => btn.dataset.eventId),
        ["m-1", "m-2"],
      );
      assert.match(itemDeletes[0].textContent, /删除「晨间规划」/);
      assert.match(itemDeletes[1].textContent, /删除「方案评审」/);
      const deleteAll = menu.querySelector(".context-menu-delete-all");
      assert.ok(deleteAll);
      assert.match(deleteAll.textContent, /删除当日全部日程（2 项）/);

      await act(async () => itemDeletes[0].click());
      assert.deepEqual(deletedSingle, ["m-1"]);
      assert.equal(closedCount, 1);

      await act(async () => deleteAll.click());
      assert.deepEqual(deletedBatch, [["m-1", "m-2"]]);
      assert.equal(closedCount, 2);
    } finally {
      menuMount.unmount();
    }
  } finally {
    mounted.unmount();
  }
});
