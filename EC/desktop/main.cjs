const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
  safeStorage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const os = require("node:os");

app.setName("Energy Calendar");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "calendar",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const smoke = process.argv.includes("--smoke-test");
if (smoke)
  app.setPath(
    "userData",
    fs.mkdtempSync(path.join(os.tmpdir(), "energy-calendar-smoke-")),
  );
const profileArg = process.argv.find((arg) => arg.startsWith("--profile="));
if (profileArg && !app.isPackaged)
  app.setPath("userData", path.resolve(profileArg.slice(10)));
let database,
  accounts,
  quitReady = false,
  window,
  closing = false,
  closeTimer;
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    const { openCalendarDatabase } = await import("./database.js");
    const dataPath = app.getPath("userData");
    try {
      database = openCalendarDatabase(path.join(dataPath, "calendar.sqlite"));
      database.backup(path.join(dataPath, "backups"));
      if (smoke) {
        const { smokeFixtures } = require("./smoke.cjs");
        database.apply({ upserts: smokeFixtures().events });
      }
      const startAccounts = async () => {
        const { createDesktopAccounts } = await import("./accounts.js");
        accounts = createDesktopAccounts({ dataPath, localDatabase: database, safeStorage,
          onChange: (state) => { if (window && !window.isDestroyed()) window.webContents.send("calendar:sync-changed", state); } });
        await accounts.restore();
      };
      await startAccounts();
      const storage = () => accounts?.database() ?? database;
      const distPath = path.resolve(__dirname, "../dist");
      protocol.handle("calendar", (request) => {
        const url = new URL(request.url);
        const relative =
          decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
        const filename = path.resolve(distPath, relative);
        if (
          url.host !== "app" ||
          !filename.startsWith(`${distPath}${path.sep}`)
        )
          return new Response("Forbidden", { status: 403 });
        return net.fetch(pathToFileURL(filename).href);
      });
      window = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 900,
        minHeight: 650,
        title: "精力日历",
        backgroundColor: "#faf9f6",
        show: false,
        autoHideMenuBar: true,
        icon: path.join(__dirname, "assets/icon.ico"),
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: !smoke,
          offscreen: smoke,
        },
      });
      const devURL = !app.isPackaged && process.env.CALENDAR_DEV_URL;
      const trusted = (url) =>
        devURL
          ? url.startsWith(`${new URL(devURL).origin}/`)
          : url.startsWith("calendar://app/");
      const handle = (name, callback) =>
        ipcMain.handle(name, (event, ...args) => {
          if (
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            !trusted(event.senderFrame.url)
          )
            throw new Error("无效的应用请求");
          return callback(...args);
        });
      handle("calendar:list", () => storage().list());
      handle("calendar:apply", (changes) => { const result = storage().apply(changes); accounts?.changed(); return result; });
      handle("calendar:sync-info", () => accounts?.info() ?? { phase: "local", conflicts: [] });
      handle("calendar:sync-now", () => accounts?.run());
      handle("calendar:login", (input) => accounts.login(input));
      handle("calendar:register", (input) => accounts.register(input));
      handle("calendar:auth-options", (input) => accounts.authOptions(input));
      handle("calendar:logout", () => accounts.logout());
      handle("calendar:resolve", (input) => accounts.resolve(input));
      handle("calendar:info", () => ({
        version: app.getVersion(),
        dataPath: accounts?.info().dataPath ?? dataPath,
        desktop: true,
      }));
      handle("calendar:settings", () => storage().getSettings());
      handle("calendar:set-settings", (settings) =>
        storage().setSettings(settings),
      );
      handle("calendar:open-data", () => shell.openPath(accounts?.info().dataPath ?? dataPath));
      handle("calendar:export", async () => {
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          title: "备份日历",
          defaultPath: `精力日历-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: "日历备份", extensions: ["json"] }],
        });
        if (canceled) return { canceled: true };
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, storage().export(), "utf8");
        fs.renameSync(tmp, filePath);
        return { ok: true };
      });
      handle("calendar:import", async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(window, {
          title: "导入日历（兼容旧版 events.json）",
          filters: [{ name: "日历备份", extensions: ["json"] }],
          properties: ["openFile"],
        });
        if (canceled) return { canceled: true };
        if (fs.statSync(filePaths[0]).size > 20 * 1024 * 1024)
          throw new Error("文件超过 20 MB");
        // The file is completely validated before any transaction is committed.
        const raw = fs.readFileSync(filePaths[0], "utf8");
        const target = storage();
        const prepared = target.prepareImport(raw);
        const { response } = await dialog.showMessageBox(window, {
          type: "question",
          title: "导入日历",
          message: `将合并 ${prepared.count} 项日程`,
          detail:
            "保留现有日程，自动跳过完全相同的记录。导入前会保存一份备份。",
          buttons: ["导入", "取消"],
          defaultId: 0,
          cancelId: 1,
        });
        if (response !== 0) return { canceled: true };
        if (target !== storage()) throw new Error("账号已改变，请重新导入");
        fs.writeFileSync(
          path.join(accounts?.info().dataPath ?? dataPath, `before-import-${Date.now()}.json`),
          target.export(),
          "utf8",
        );
        if (target !== storage()) throw new Error("账号已改变，请重新导入");
        const result = prepared.commit(); accounts?.changed(); return result;
      });
      ipcMain.on("calendar:close-ready", (event) => {
        if (event.sender !== window.webContents) return;
        clearTimeout(closeTimer);
        closing = true;
        window.close();
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (!trusted(url)) event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      window.once("ready-to-show", () => {
        if (!smoke) window.show();
      });
      window.on("focus", () => accounts?.run());
      window.on("close", (event) => {
        if (closing) return;
        event.preventDefault();
        window.webContents.send("calendar:closing");
        closeTimer = setTimeout(() => {
          dialog.showMessageBox(window, {
            type: "warning",
            message: "日程尚未保存完成",
            detail: "请等待保存完成后再关闭。",
            buttons: ["返回日历"],
          });
        }, 5000);
      });
      await window.loadURL(devURL || "calendar://app/index.html");
      if (smoke) {
        const { verifyHeat, verifyIpc } = require("./smoke.cjs");
        const initial = await verifyHeat(window, false);
        if (process.env.CALENDAR_SMOKE_LIGHT_SCREENSHOT) fs.writeFileSync(process.env.CALENDAR_SMOKE_LIGHT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        await verifyIpc(window);
        // Reopen SQLite and reload the bundled application to rule out memory-only saves.
        await accounts.close();
        database.close();
        database = openCalendarDatabase(path.join(dataPath, "calendar.sqlite"));
        await startAccounts();
        await window.loadURL("calendar://app/index.html");
        const restored = await verifyHeat(window, true);
        const { verifySyncUi, verifyCloud } = require("./smoke.cjs");
        await verifySyncUi(window);
        if (process.env.CALENDAR_SMOKE_SCREENSHOT) fs.writeFileSync(process.env.CALENDAR_SMOKE_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        if (process.env.CALENDAR_SMOKE_SERVER_ORIGIN) {
          const { prepareRegistration, finishDesktopRegistration, finishWebRegistration } = require("./smoke.cjs");
          await prepareRegistration(window, process.env.CALENDAR_SMOKE_SERVER_ORIGIN, process.env.CALENDAR_SMOKE_PASSWORD);
          if (process.env.CALENDAR_SMOKE_REGISTRATION_SCREENSHOT) fs.writeFileSync(process.env.CALENDAR_SMOKE_REGISTRATION_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
          await finishDesktopRegistration(window);
          const webWindow = new BrowserWindow({ show: false, width: 1000, height: 850,
            webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
          try {
            await webWindow.loadURL(process.env.CALENDAR_SMOKE_SERVER_ORIGIN);
            await prepareRegistration(webWindow, process.env.CALENDAR_SMOKE_SERVER_ORIGIN, process.env.CALENDAR_SMOKE_PASSWORD, false);
            await finishWebRegistration(webWindow);
          } finally { webWindow.destroy(); }
          console.log("REGISTRATION_SMOKE_OK", JSON.stringify({ desktopForm: true, webForm: true, autoLogin: true, isolatedCalendar: true, cloudWrite: true }));
          await verifyCloud(window, process.env.CALENDAR_SMOKE_SERVER_ORIGIN, process.env.CALENDAR_SMOKE_PASSWORD);
          const stored = JSON.parse(fs.readFileSync(path.join(dataPath, "sync-session.json"), "utf8"));
          if (JSON.stringify(stored).includes("calendar_session=")) throw new Error("Session persisted without encryption");
          await accounts.close(); await startAccounts(); await accounts.run();
          if (accounts.info().phase !== "synced" || accounts.database().list().length !== 1) throw new Error("Account session did not restore");
          await accounts.logout();
          if (accounts.database().list().length !== 3) throw new Error("Local account isolation failed");
          console.log("DESKTOP_SYNC_SMOKE_OK", JSON.stringify({ encryptedSession: Boolean(stored.encryptedCookie), restoredProfile: true, cloudRoundTrip: true, logoutIsolation: true }));
        }
        console.log(
          "DESKTOP_SMOKE_OK",
          JSON.stringify({
            ...restored,
            calendar: true,
            initialHeat: initial.heat,
            restoredHeat: restored.heat,
            ipcCrud: true,
            sqliteReopened: true,
            themePersisted: true,
            electron: process.versions.electron,
            node: process.versions.node,
          }),
        );
        closing = true;
        app.quit();
      }
    } catch (error) {
      console.error(error);
      if (smoke) app.exit(1);
      else {
        dialog.showErrorBox(
          "无法打开精力日历",
          `${error.message}\n\n你的数据文件已保留，请检查数据目录的读写权限。`,
        );
        closing = true;
        app.quit();
      }
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (window && !window.isDestroyed() && !closing) {
      event.preventDefault();
      window.close();
      return;
    }
    clearTimeout(closeTimer);
    if (accounts && !quitReady) {
      event.preventDefault();
      accounts.close().finally(() => { quitReady = true; app.quit(); });
      return;
    }
    database?.close();
    database = null;
  });
}
