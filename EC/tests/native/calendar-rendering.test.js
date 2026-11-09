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
let dom, server, render, act, waitFor, cleanup, CalendarCanvas;
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
  assert.ok(day().style.getPropertyValue("--day-heat").includes("0.206"));
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
  await act(async () => fire(cells[0], "pointerover", { pointerType: "mouse" }));
  await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
  await act(async () =>
    fire(
      mounted.container.querySelector(".fc-view-harness"),
      "pointerover",
      { pointerType: "mouse" },
    ),
  );
  await waitFor(() => assert.ok(!previewCard()), { timeout: 700 });
  await act(async () => fire(cells[1], "pointerover", { pointerType: "mouse" }));
  await waitFor(() => assert.ok(previewCard()), { timeout: 900 });
  const transform = document.querySelector(".day-preview").style.transform;
  assert.match(transform, /translateX\(440px\)/);
  assert.match(transform, /translateY\(292px\)/);
  assert.doesNotMatch(transform, /240px|192px/);
});
test("hovering a week header cell previews that day", async () => {
  const events = [
    allday("a", dateKey(new Date()), dateKey(addDays(new Date(), 1))),
  ];
  const { mounted } = await monthSetup(events, { view: "timeGridWeek" });
  const header = await waitFor(() => {
    const cell = mounted.container.querySelector(
      ".fc-col-header-cell[data-date]",
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
