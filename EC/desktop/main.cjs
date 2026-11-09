const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
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
      handle("calendar:list", () => database.list());
      handle("calendar:apply", (changes) => database.apply(changes));
      handle("calendar:info", () => ({
        version: app.getVersion(),
        dataPath,
        desktop: true,
      }));
      handle("calendar:settings", () => database.getSettings());
      handle("calendar:set-settings", (settings) =>
        database.setSettings(settings),
      );
      handle("calendar:open-data", () => shell.openPath(dataPath));
      handle("calendar:export", async () => {
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          title: "备份日历",
          defaultPath: `精力日历-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: "日历备份", extensions: ["json"] }],
        });
        if (canceled) return { canceled: true };
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, database.export(), "utf8");
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
        const prepared = database.prepareImport(raw);
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
        fs.writeFileSync(
          path.join(dataPath, `before-import-${Date.now()}.json`),
          database.export(),
          "utf8",
        );
        return prepared.commit();
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
        await verifyIpc(window);
        // Reopen SQLite and reload the bundled application to rule out memory-only saves.
        database.close();
        database = openCalendarDatabase(path.join(dataPath, "calendar.sqlite"));
        await window.loadURL("calendar://app/index.html");
        const restored = await verifyHeat(window, true);
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
    database?.close();
    database = null;
  });
}
