// These tests mount the actual React hook against a real JSDOM storage implementation.
// The legacy runner's component/hook substitutes are deliberately not used here.
import { before, after, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
let dom,
  server,
  renderHook,
  act,
  waitFor,
  cleanup,
  usePlanner,
  repository,
  originalApply;
const event = {
  id: "new-event",
  title: "保留选择的时间",
  start: "2026-10-20T13:15:00+08:00",
  end: "2026-10-20T14:45:00+08:00",
  tag: "work",
};
before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://calendar.test/",
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "localStorage",
    "getComputedStyle",
  ])
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ renderHook, act, waitFor, cleanup } =
    await import("@testing-library/react"));
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: "custom",
  });
  ({ usePlanner } = await server.ssrLoadModule("/src/planner/usePlanner.js"));
  ({ repository } = await server.ssrLoadModule("/src/planner/repository.js"));
  originalApply = repository.apply;
});
after(async () => {
  await server?.close();
  dom?.window.close();
});
beforeEach(() => {
  localStorage.clear();
  repository.apply = originalApply;
});
afterEach(() => cleanup());
const mount = async () => {
  const hook = renderHook(() => usePlanner());
  await waitFor(() => assert.equal(hook.result.current.loading, false));
  return hook;
};
test("real React state preserves exact timestamps through save, undo, redo and remount", async () => {
  const hook = await mount();
  await act(async () => {
    hook.result.current.saveEvent(event);
  });
  await waitFor(() => assert.equal(hook.result.current.status, "saved"));
  assert.equal(hook.result.current.events[0].start, "2026-10-20T05:15:00.000Z");
  await act(async () => {
    hook.result.current.undo();
  });
  assert.equal(hook.result.current.events.length, 0);
  await act(async () => {
    hook.result.current.redo();
  });
  assert.equal(hook.result.current.events.length, 1);
  await waitFor(() => assert.equal(hook.result.current.status, "saved"));
  hook.unmount();
  const reopened = await mount();
  assert.equal(
    reopened.result.current.events[0].end,
    "2026-10-20T06:45:00.000Z",
  );
});
test("a failed write is reported as unsaved; retry retains and persists the same event", async () => {
  const hook = await mount();
  repository.apply = async () => {
    throw new Error("磁盘已满");
  };
  await act(async () => {
    hook.result.current.saveEvent(event);
  });
  await waitFor(() => assert.equal(hook.result.current.status, "error"));
  assert.equal(hook.result.current.events.length, 1);
  assert.equal(localStorage.getItem("energy-calendar-v2"), null);
  repository.apply = originalApply;
  await act(async () => {
    hook.result.current.retry();
  });
  await waitFor(() => assert.equal(hook.result.current.status, "saved"));
  assert.equal(
    JSON.parse(localStorage.getItem("energy-calendar-v2")).events.length,
    1,
  );
});
test("serialized changes recover a failed earlier save without dropping subsequent edits", async () => {
  const hook = await mount();
  let calls = 0;
  repository.apply = async (changes) => {
    if (++calls === 1) throw new Error("temporary failure");
    await originalApply(changes);
  };
  await act(async () => {
    hook.result.current.saveEvent(event);
    hook.result.current.saveEvent({ ...event, id: "second", title: "第二项" });
  });
  await waitFor(() => assert.equal(hook.result.current.status, "saved"));
  assert.equal(
    JSON.parse(localStorage.getItem("energy-calendar-v2")).events.length,
    2,
  );
});
test("demo edits remain in memory and returning restores the personal calendar", async () => {
  const hook = await mount();
  await act(async () => {
    hook.result.current.saveEvent(event);
  });
  await waitFor(() => assert.equal(hook.result.current.status, "saved"));
  const personal = localStorage.getItem("energy-calendar-v2");
  await act(async () => {
    await hook.result.current.setDemoMode(true);
  });
  assert.equal(hook.result.current.demo, true);
  await act(async () => {
    hook.result.current.deleteEvent(hook.result.current.events[0].id);
  });
  assert.equal(localStorage.getItem("energy-calendar-v2"), personal);
  await act(async () => {
    await hook.result.current.setDemoMode(false);
  });
  assert.equal(hook.result.current.events.length, 1);
  assert.equal(hook.result.current.events[0].id, event.id);
});
test("a new edit after undo clears redo while keeping the earlier saved state consistent", async () => {
  const hook = await mount();
  await act(async () => {
    hook.result.current.saveEvent(event);
  });
  await act(async () => {
    hook.result.current.undo();
  });
  assert.equal(hook.result.current.historyState.redo, true);
  await act(async () => {
    hook.result.current.saveEvent({ ...event, id: "replacement" });
  });
  assert.equal(hook.result.current.historyState.redo, false);
  await waitFor(() => assert.equal(hook.result.current.status, "saved"));
  assert.deepEqual(
    JSON.parse(localStorage.getItem("energy-calendar-v2")).events.map(
      (e) => e.id,
    ),
    ["replacement"],
  );
});
test("damaged preferences cannot select an unknown calendar plugin or invalid theme", async () => {
  localStorage.setItem(
    "energy-calendar-settings-v2",
    JSON.stringify({
      theme: "broken",
      defaultView: "unknown-plugin",
      weekStart: 7,
      showWeekends: "false",
    }),
  );
  const hook = await mount();
  assert.equal(hook.result.current.settings.defaultView, "dayGridMonth");
  assert.equal(hook.result.current.settings.theme, "light");
  assert.equal(hook.result.current.settings.showWeekends, true);
});
test("retrying a saved calendar does not send an empty write", async () => {
  const hook = await mount();
  await act(async () => { hook.result.current.saveEvent(event); });
  await waitFor(() => assert.equal(hook.result.current.status, "saved"));
  let calls = 0;
  repository.apply = async (changes) => {
    calls++;
    return originalApply(changes);
  };
  await act(async () => { hook.result.current.retry(); });
  await waitFor(() => assert.equal(hook.result.current.status, "saved"));
  assert.equal(calls, 0);
  assert.equal(hook.result.current.events.length, 1);
  assert.equal(JSON.parse(localStorage.getItem("energy-calendar-v2")).events.length, 1);
});
