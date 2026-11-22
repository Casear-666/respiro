import { before, after, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React from "react";

let dom,
  server,
  render,
  act,
  waitFor,
  fireEvent,
  cleanup,
  PlannerApp,
  repository;

const setBaseGlobals = () => {
  dom.window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
};

before(async () => {
  dom = new JSDOM(
    '<!doctype html><html><head><meta name="color-scheme" content="light dark" /></head><body></body></html>',
    {
      url: "http://calendar.test/",
      pretendToBeVisual: true,
    },
  );
  setBaseGlobals();
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "SVGElement",
    "Event",
    "CustomEvent",
    "KeyboardEvent",
    "localStorage",
    "getComputedStyle",
    "MutationObserver",
  ]) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  }
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(
    dom.window,
  );
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(
    dom.window,
  );
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ render, act, waitFor, fireEvent, cleanup } =
    await import("@testing-library/react"));
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: "custom",
    plugins: [(await import("@vitejs/plugin-react")).default()],
  });
  ({ repository } = await server.ssrLoadModule("/src/planner/repository.js"));
  ({ default: PlannerApp } = await server.ssrLoadModule(
    "/src/planner/PlannerApp.jsx",
  ));
});

after(async () => {
  cleanup?.();
  await server?.close();
  dom?.window.close();
});

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-planner-theme");
  document.documentElement.style.cssText = "";
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute("content", "light dark");
  delete document.startViewTransition;
});

afterEach(() => {
  cleanup();
  delete document.startViewTransition;
});

const flushMicrotasks = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
};

const mountApp = async () => {
  const mounted = render(React.createElement(PlannerApp));
  await waitFor(() => {
    assert.ok(mounted.container.querySelector(".save-indicator.saved"));
    assert.ok(mounted.container.querySelector(".time-canvas"));
  });
  return mounted;
};

test("Option 1 removes permanent sidebar, renders unified topbar + popovers, and keeps .storage-card settings trigger", async () => {
  const { container } = await mountApp();

  assert.equal(container.querySelector(".planner-sidebar"), null);
  assert.ok(container.querySelector(".topbar-brand"));
  const dateTrigger = container.querySelector(".date-picker-trigger");
  const filterTrigger = container.querySelector(".filter-trigger");
  const createBtn = container.querySelector(".topbar-create");
  const miniPopover = container.querySelector(".mini-calendar-popover[popover]");
  const filterPopover = container.querySelector(".filter-popover[popover]");
  const storageBtn = container.querySelector(".calendar-footer .storage-card");

  assert.ok(dateTrigger);
  assert.ok(filterTrigger);
  assert.ok(createBtn);
  assert.ok(miniPopover);
  assert.ok(filterPopover);
  assert.ok(storageBtn);
  assert.equal(dateTrigger.getAttribute("aria-haspopup"), null);
  assert.equal(filterTrigger.getAttribute("aria-haspopup"), null);
  assert.equal(
    dateTrigger.getAttribute("popovertarget"),
    miniPopover.getAttribute("id"),
  );
  assert.equal(
    filterTrigger.getAttribute("popovertarget"),
    filterPopover.getAttribute("id"),
  );

  // Clicking .storage-card in the footer must still open SettingsDialog (smoke.cjs contract).
  await act(async () => {
    fireEvent.click(storageBtn);
  });
  await waitFor(() => {
    assert.ok(container.querySelector(".settings-dialog"));
  });
  const settingsDialog = container.querySelector(".settings-dialog");
  assert.match(settingsDialog.textContent, /AI 智能与 API/);
  assert.match(settingsDialog.textContent, /使用自己的 API/);
  assert.match(settingsDialog.textContent, /使用默认提供的 API/);
});

test("dark-mode View Transition keeps old theme until update() runs, flushes icon synchronously, and guards rapid toggles", async () => {
  const transitions = [];
  document.startViewTransition = (arg) => {
    const updateFn = typeof arg === "function" ? arg : arg.update;
    let resolveFinished, resolveReady, resolveUpdate;
    const finished = new Promise((r) => {
      resolveFinished = r;
    });
    const ready = new Promise((r) => {
      resolveReady = r;
    });
    const updateCallbackDone = new Promise((r) => {
      resolveUpdate = r;
    });
    const entry = {
      types: typeof arg === "object" ? arg.types : [],
      runUpdate: async () => {
        await updateFn();
        resolveUpdate();
      },
      resolveReady,
      resolveFinished,
      finished,
      ready,
      updateCallbackDone,
    };
    transitions.push(entry);
    return entry;
  };

  const { container } = await mountApp();
  const themeBtn = container.querySelector('button[aria-label="切换明暗主题"]');
  assert.ok(themeBtn);
  themeBtn.getBoundingClientRect = () => ({
    left: 1180,
    top: 16,
    width: 32,
    height: 32,
    right: 1212,
    bottom: 48,
  });

  assert.equal(
    document.documentElement.getAttribute("data-planner-theme"),
    "light",
  );
  assert.ok(themeBtn.querySelector(".lucide-moon"));

  await act(async () => {
    fireEvent.click(themeBtn);
  });
  // Allow repository.setSettings microtasks to settle before the browser runs update().
  await flushMicrotasks();

  assert.equal(transitions.length, 1);
  // Critical regression check: before update() runs, OLD snapshot must still be light.
  assert.equal(
    document.documentElement.getAttribute("data-planner-theme"),
    "light",
  );
  assert.equal(
    document.documentElement.classList.contains("vt-type-theme"),
    true,
  );
  assert.equal(
    document.documentElement.classList.contains("theme-switching"),
    true,
  );
  assert.equal(
    document.documentElement.style.getPropertyValue("--vt-x"),
    "1196px",
  );
  assert.equal(
    document.documentElement.style.getPropertyValue("--vt-y"),
    "32px",
  );
  assert.ok(document.documentElement.style.getPropertyValue("--vt-r"));

  // Run the View Transition update callback: theme, meta, and React icon must update inside it.
  await act(async () => {
    await transitions[0].runUpdate();
  });
  assert.equal(
    document.documentElement.getAttribute("data-planner-theme"),
    "dark",
  );
  assert.equal(
    document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
    "dark",
  );
  assert.ok(themeBtn.querySelector(".lucide-sun"));
  assert.equal(
    document.documentElement.classList.contains("vt-type-theme"),
    true,
  );
  assert.equal(
    document.documentElement.classList.contains("theme-switching"),
    true,
  );

  // Trigger a second rapid toggle before the first transition finishes.
  await act(async () => {
    fireEvent.click(themeBtn);
  });
  await flushMicrotasks();
  assert.equal(transitions.length, 2);
  assert.equal(
    document.documentElement.getAttribute("data-planner-theme"),
    "dark",
  );

  await act(async () => {
    await transitions[1].runUpdate();
  });
  assert.equal(
    document.documentElement.getAttribute("data-planner-theme"),
    "light",
  );

  // Resolving the first (superseded) transition must NOT clear classes from the active second transition.
  await act(async () => {
    transitions[0].resolveFinished();
    await flushMicrotasks();
  });
  assert.equal(
    document.documentElement.classList.contains("vt-type-theme"),
    true,
  );
  assert.equal(
    document.documentElement.classList.contains("theme-switching"),
    true,
  );

  // Resolving the latest transition cleans up the root classes.
  await act(async () => {
    transitions[1].resolveFinished();
    await flushMicrotasks();
  });
  assert.equal(
    document.documentElement.classList.contains("vt-type-theme"),
    false,
  );
  assert.equal(
    document.documentElement.classList.contains("theme-switching"),
    false,
  );
});

test("category filter popover toggles filtered state and resets with 全部显示", async () => {
  const { container } = await mountApp();
  const filterTrigger = container.querySelector(".filter-trigger");
  const filterPopover = container.querySelector(".filter-popover");
  assert.equal(filterTrigger.classList.contains("is-filtered"), false);

  const workFilterBtn = filterPopover.querySelector(".category-filter");
  assert.ok(workFilterBtn);
  await act(async () => {
    fireEvent.click(workFilterBtn);
  });
  assert.equal(filterTrigger.classList.contains("is-filtered"), true);

  const showAllBtn = [...filterPopover.querySelectorAll("button")].find((b) =>
    b.textContent.includes("全部显示"),
  );
  assert.ok(showAllBtn);
  await act(async () => {
    fireEvent.click(showAllBtn);
  });
  assert.equal(filterTrigger.classList.contains("is-filtered"), false);
});

test("mini-calendar popover browses months independently without DayPreview and exposes 回到今天", async () => {
  const { container } = await mountApp();
  const miniPopover = container.querySelector(".mini-calendar-popover");
  const mainTitle = container.querySelector(".date-picker-trigger h1");
  const initialMainTitle = mainTitle.textContent;
  const miniHeader = miniPopover.querySelector(".mini-month > span");
  const initialMiniHeader = miniHeader.textContent;

  const nextMonthBtn = miniPopover.querySelector(
    'button[aria-label="下一月（小日历）"]',
  );
  assert.ok(nextMonthBtn);
  await act(async () => {
    fireEvent.click(nextMonthBtn);
  });

  assert.notEqual(miniHeader.textContent, initialMiniHeader);
  assert.equal(mainTitle.textContent, initialMainTitle);
  assert.equal(document.querySelector(".day-preview"), null);
  assert.ok(miniPopover.querySelector(".mini-today-button"));
});
