const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "energyCalendar",
  Object.freeze({
    list: () => ipcRenderer.invoke("calendar:list"),
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
