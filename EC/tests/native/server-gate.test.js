// Mounts the real ServerGate against a stubbed repository selected through
// the same __CALENDAR_SERVER__ runtime flag the production server injects.
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
  cleanup,
  ServerGate,
  useServerSession,
  repository;
const user = { id: "u1", username: "alice" };
const rejected = (status) => {
  const error = new Error(status === 401 ? "需要登录" : "网络错误");
  error.status = status;
  return error;
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
  window.__CALENDAR_SERVER__ = true;
  ({ render, act, waitFor, cleanup } =
    await import("@testing-library/react"));
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: "custom",
    plugins: [(await import("@vitejs/plugin-react")).default()],
  });
  ({ repository } = await server.ssrLoadModule("/src/planner/repository.js"));
  ({ default: ServerGate, useServerSession } = await server.ssrLoadModule(
    "/src/planner/ServerGate.jsx",
  ));
});
after(async () => {
  delete window.__CALENDAR_SERVER__;
  await server?.close();
  dom?.window.close();
});
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => cleanup());
const setValue = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};
const mountProbe = () => {
  const probe = { ctx: null, mounts: 0 };
  const Child = () => {
    probe.ctx = useServerSession();
    React.useEffect(() => {
      probe.mounts++;
    }, []);
    return React.createElement("output", { className: "probe-child" }, "child");
  };
  const view = render(
    React.createElement(ServerGate, null, React.createElement(Child)),
  );
  return { probe, view };
};
test("a 401 session probe shows the login form and success mounts children", async () => {
  repository.session = async () => {
    throw rejected(401);
  };
  repository.login = async () => ({ user });
  const { probe, view } = mountProbe();
  await waitFor(() =>
    assert.ok(
      view.container.querySelector('input[autocomplete="username"]'),
    ),
  );
  assert.ok(view.container.querySelector('input[type="password"]'));
  assert.match(view.container.textContent, /登录你的日历/);
  assert.match(view.container.textContent, /使用管理员创建的账号登录/);
  const name = view.container.querySelector('input[autocomplete="username"]');
  const pass = view.container.querySelector('input[type="password"]');
  await act(async () => {
    setValue(name, "alice");
    setValue(pass, "p".repeat(12));
  });
  await act(async () => {
    view.container.querySelector('button[type="submit"]').click();
  });
  await waitFor(() => assert.ok(view.container.querySelector(".probe-child")));
  assert.equal(probe.ctx.user.username, "alice");
  assert.equal(probe.mounts, 1);
});
test("a network failure offers retry instead of a misleading form", async () => {
  let calls = 0;
  repository.session = async () => {
    calls++;
    if (calls === 1) throw new Error("无法连接服务器");
    return { user };
  };
  const { view } = mountProbe();
  await waitFor(() =>
    assert.match(view.container.textContent, /暂时无法连接服务器/),
  );
  assert.equal(
    view.container.querySelector('input[type="password"]'),
    null,
  );
  await act(async () => {
    [...view.container.querySelectorAll("button")]
      .find((b) => b.textContent === "重试")
      .click();
  });
  await waitFor(() => assert.ok(view.container.querySelector(".probe-child")));
});
test("reauth overlay keeps the planner mounted and locks the username", async () => {
  repository.session = async () => ({ user });
  repository.login = async () => ({ user });
  const { probe, view } = mountProbe();
  await waitFor(() => assert.ok(view.container.querySelector(".probe-child")));
  await act(async () => {
    window.dispatchEvent(new dom.window.Event("calendar:unauthorized"));
  });
  await waitFor(() =>
    assert.ok(
      view.container.querySelector('.server-gate-overlay [role="dialog"], .server-gate-overlay'),
    ),
  );
  assert.ok(view.container.querySelector(".probe-child"));
  assert.equal(probe.mounts, 1);
  const locked = view.container.querySelector('input[readonly]');
  assert.ok(locked);
  assert.equal(locked.value, "alice");
  repository.login = async () => {
    throw rejected(401);
  };
  const pass = view.container.querySelector(
    '.server-gate-overlay input[type="password"]',
  );
  await act(async () => {
    setValue(pass, "p".repeat(12));
  });
  await act(async () => {
    view.container
      .querySelector('.server-gate-overlay button[type="submit"]')
      .click();
  });
  await waitFor(() =>
    assert.match(view.container.textContent, /需要登录/),
  );
  repository.login = async () => ({ user });
  await act(async () => {
    view.container
      .querySelector('.server-gate-overlay button[type="submit"]')
      .click();
  });
  await waitFor(() =>
    assert.equal(view.container.querySelector(".server-gate-overlay"), null),
  );
  assert.ok(view.container.querySelector(".probe-child"));
  assert.equal(probe.mounts, 1);
});
test("a failed logout keeps the calendar mounted", async () => {
  repository.session = async () => ({ user });
  repository.logout = async () => {
    throw new Error("服务器请求失败");
  };
  const { probe, view } = mountProbe();
  await waitFor(() => assert.ok(view.container.querySelector(".probe-child")));
  await act(async () => {
    await assert.rejects(() => probe.ctx.logout(), /服务器请求失败/);
  });
  assert.ok(view.container.querySelector(".probe-child"));
  assert.equal(probe.mounts, 1);
  repository.logout = async () => ({}); 
  await act(async () => {
    await probe.ctx.logout();
  });
  await waitFor(() =>
    assert.ok(
      view.container.querySelector('input[autocomplete="username"]'),
    ),
  );
});
