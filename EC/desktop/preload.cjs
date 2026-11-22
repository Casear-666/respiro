const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "energyCalendar",
  Object.freeze({
    list: () => ipcRenderer.invoke("calendar:list"),
    syncInfo: () => ipcRenderer.invoke("calendar:sync-info"),
    syncNow: () => ipcRenderer.invoke("calendar:sync-now"),
    login: (input) => ipcRenderer.invoke("calendar:login", input),
    register: (input) => ipcRenderer.invoke("calendar:register", input),
    authOptions: (input) => ipcRenderer.invoke("calendar:auth-options", input),
    logout: () => ipcRenderer.invoke("calendar:logout"),
    resolveConflict: (input) => ipcRenderer.invoke("calendar:resolve", input),
    onChanged: (callback) => {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("calendar:sync-changed", handler);
      return () => ipcRenderer.removeListener("calendar:sync-changed", handler);
    },
    apply: (changes) => ipcRenderer.invoke("calendar:apply", changes),
    importBackup: () => ipcRenderer.invoke("calendar:import"),
    exportBackup: () => ipcRenderer.invoke("calendar:export"),
    info: () => ipcRenderer.invoke("calendar:info"),
    getSettings: () => ipcRenderer.invoke("calendar:settings"),
    setSettings: (settings) =>
      ipcRenderer.invoke("calendar:set-settings", settings),
    openDataFolder: () => ipcRenderer.invoke("calendar:open-data"),
    onClosing: (callback) => {
      const handler = () => {
        Promise.resolve()
          .then(callback)
          .then(() => ipcRenderer.send("calendar:close-ready"))
          .catch(() => {});
      };
      ipcRenderer.on("calendar:closing", handler);
      return () => ipcRenderer.removeListener("calendar:closing", handler);
    },
  }),
);
