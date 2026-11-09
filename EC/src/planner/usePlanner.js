import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { repository, isDesktop } from "./repository";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeEvent,
  sampleEvents,
} from "../../shared/domain.js";
const defaults = DEFAULT_SETTINGS;
// Transforms reuse the same object for untouched events, so identity is enough.
const diff = (before, after) => {
  const old = new Map(before.map((e) => [e.id, e])),
    next = new Set(after.map((e) => e.id));
  return {
    upserts: after.filter((e) => old.get(e.id) !== e),
    deletes: before.filter((e) => !next.has(e.id)).map((e) => e.id),
  };
};
export function usePlanner() {
  const [events, setEvents] = useState([]),
    [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("saved"),
    [loadError, setLoadError] = useState("");
  const [settings, setSettings] = useState(defaults),
    [demo, setDemo] = useState(false);
  const [historyState, setHistoryState] = useState({
    undo: false,
    redo: false,
  });
  const current = useRef([]),
    saved = useRef([]),
    queue = useRef(Promise.resolve()),
    sequence = useRef(0);
  const history = useRef({ past: [], future: [] }),
    demoRef = useRef(false),
    failure = useRef(null),
    ready = useRef(false);
  const historyChanged = () =>
    setHistoryState({
      undo: !!history.current.past.length,
      redo: !!history.current.future.length,
    });
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    ready.current = false;
    try {
      const [list, preferences] = await Promise.all([
        repository.list(),
        repository.getSettings(),
      ]);
      const normalized = list.map(normalizeEvent);
      current.current = normalized;
      saved.current = normalized;
      setEvents(normalized);
      setSettings(normalizeSettings(preferences));
      ready.current = true;
    } catch (error) {
      setLoadError(error.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const persist = useCallback((next) => {
    if (demoRef.current) return;
    const seq = ++sequence.current;
    setStatus("saving");
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        const changes = diff(saved.current, next);
        if (changes.upserts.length > 0 || changes.deletes.length > 0)
          await repository.apply(changes);
        saved.current = next;
        failure.current = null;
        if (seq === sequence.current) setStatus("saved");
      })
      .catch((error) => {
        failure.current = error;
        if (seq === sequence.current) {
          setStatus("error");
          toast.error("尚未保存到本机", {
            description: "数据仍在当前窗口中，请点击底部的“重试保存”。",
          });
        }
      });
  }, []);
  const flush = useCallback(async () => {
    await queue.current;
    if (failure.current) throw failure.current;
  }, []);
  useEffect(() => {
    const unsubscribe = window.energyCalendar?.onClosing(async () => {
      try {
        await flush();
      } catch (error) {
        toast.error("请先重试保存，再关闭日历");
        throw error;
      }
    });
    const beforeUnload = (event) => {
      if (
        !demoRef.current &&
        (failure.current || current.current !== saved.current)
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unsubscribe?.();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [flush]);
  const commit = useCallback(
    (transform, label = "日程已更新") => {
      if (!ready.current) return false;
      const before = current.current,
        after = transform(before);
      if (
        before === after ||
        (before.length === after.length &&
          before.every((event, i) => event === after[i]))
      )
        return false;
      history.current.past = [...history.current.past, { before, after }].slice(
        -30,
      );
      history.current.future = [];
      current.current = after;
      setEvents(after);
      historyChanged();
      persist(after);
      if (label) toast.success(label);
      return true;
    },
    [persist],
  );
  const undo = useCallback(() => {
    const command = history.current.past.pop();
    if (!command) return;
    history.current.future.push(command);
    current.current = command.before;
    setEvents(command.before);
    historyChanged();
    persist(command.before);
    toast("已撤销");
  }, [persist]);
  const redo = useCallback(() => {
    const command = history.current.future.pop();
    if (!command) return;
    history.current.past.push(command);
    current.current = command.after;
    setEvents(command.after);
    historyChanged();
    persist(command.after);
    toast("已重做");
  }, [persist]);
  const saveEvent = useCallback(
    (data) => {
      const event = normalizeEvent(data);
      return commit((list) => {
        const index = list.findIndex((e) => e.id === event.id);
        if (index < 0) return [...list, event];
        if (JSON.stringify(list[index]) === JSON.stringify(event)) return list;
        return list.map((e) => (e.id === event.id ? event : e));
      }, "日程已保存");
    },
    [commit],
  );
  const moveEvent = useCallback(
    (id, start, end, allDay) =>
      commit(
        (list) =>
          list.map((e) =>
            e.id === id ? normalizeEvent({ ...e, start, end, allDay }) : e,
          ),
        "",
      ),
    [commit],
  );
  const deleteEvent = useCallback(
    (id) => {
      const changed = commit(
        (list) => list.filter((e) => e.id !== id),
        "",
      );
      if (changed) toast("日程已删除", { action: { label: "撤销", onClick: undo } });
      return changed;
    },
    [commit, undo],
  );
  const toggleComplete = useCallback(
    (id) =>
      commit(
        (list) =>
          list.map((e) =>
            e.id === id ? { ...e, completed: !e.completed } : e,
          ),
        "",
      ),
    [commit],
  );
  const updateSettings = useCallback(
    async (patch) => {
      const next = { ...settings, ...patch };
      try {
        await repository.setSettings(next);
        setSettings(next);
      } catch {
        toast.error("偏好设置未能保存，请检查存储空间");
      }
    },
    [settings],
  );
  const setDemoMode = useCallback(
    async (value) => {
      try {
        await flush();
        const list = value ? sampleEvents() : await repository.list();
        demoRef.current = value;
        setDemo(value);
        current.current = list;
        if (!value) saved.current = list;
        setEvents(list);
        history.current = { past: [], future: [] };
        historyChanged();
      } catch {
        toast.error("请先保存当前更改");
      }
    },
    [flush],
  );
  const importBackup = useCallback(
    async (raw) => {
      try {
        await flush();
        const result = isDesktop
          ? await repository.importBackup()
          : await repository.importText(raw);
        if (result.canceled) return;
        await load();
        history.current = { past: [], future: [] };
        historyChanged();
        toast.success(`已导入 ${result.added} 项日程`, {
          description: result.skipped
            ? `跳过 ${result.skipped} 项重复日程`
            : "原有日程已保留",
        });
      } catch (error) {
        toast.error("导入失败", { description: error.message });
      }
    },
    [flush, load],
  );
  const exportBackup = useCallback(async () => {
    try {
      await flush();
      const result = await repository.exportBackup();
      if (!result.canceled) toast.success("日历备份已导出");
    } catch (error) {
      toast.error("导出失败", { description: error.message });
    }
  }, [flush]);
  return {
    events,
    loading,
    loadError,
    status,
    settings,
    demo,
    historyState,
    saveEvent,
    moveEvent,
    deleteEvent,
    toggleComplete,
    undo,
    redo,
    updateSettings,
    setDemoMode,
    importBackup,
    exportBackup,
    reload: load,
    retry: () => persist(current.current),
  };
}
