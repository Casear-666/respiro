import {
  normalizeEvent,
  parseBackup,
  mergeEvents,
  createBackup,
} from "../../shared/domain.js";
import { version } from "../../package.json";
import { createServerRepository } from "./serverRepository.js";
const EVENTS_KEY = "energy-calendar-v2",
  SETTINGS_KEY = "energy-calendar-settings-v2";
export const isDesktop = Boolean(window.energyCalendar);
export const isServer =
  !isDesktop &&
  (window.__CALENDAR_SERVER__ === true ||
    import.meta.env.VITE_CALENDAR_SERVER === "true");
const readEvents = () => {
  const current = localStorage.getItem(EVENTS_KEY);
  if (current !== null) return parseBackup(current);
  const legacy = localStorage.getItem("ec-local-events");
  if (legacy) {
    const migrated = parseBackup(legacy);
    localStorage.setItem(EVENTS_KEY, createBackup(migrated));
    return migrated;
  }
  return [];
};
const browserRepository = {
  async list() {
    return readEvents();
  },
  async apply({ upserts = [], deletes = [] }) {
    const map = new Map(readEvents().map((e) => [e.id, e]));
    deletes.forEach((id) => map.delete(String(id)));
    upserts.map(normalizeEvent).forEach((e) => map.set(e.id, e));
    localStorage.setItem(EVENTS_KEY, createBackup([...map.values()]));
  },
  async getSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    } catch {
      return {};
    }
  },
  async setSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  },
  async info() {
    return { version, desktop: false };
  },
  async importText(raw) {
    const current = readEvents(),
      merged = mergeEvents(current, parseBackup(raw));
    localStorage.setItem(
      "energy-calendar-before-import",
      createBackup(current),
    );
    localStorage.setItem(EVENTS_KEY, createBackup(merged.events));
    return { added: merged.added, skipped: merged.skipped };
  },
  async exportBackup() {
    const url = URL.createObjectURL(
      new Blob([createBackup(readEvents())], {
        type: "application/json;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `精力日历-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true };
  },
};
export const repository = isDesktop
  ? window.energyCalendar
  : isServer
    ? createServerRepository({
        onUnauthorized: () =>
          window.dispatchEvent(new Event("calendar:unauthorized")),
      })
    : browserRepository;
