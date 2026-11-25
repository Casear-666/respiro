import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { toast } from "sonner";
import { repository, isLocalApp, isMobile, isServer } from "./repository";
import {
  COGNITIVE_LEVELS,
  DEFAULT_SETTINGS,
  cognitiveLevelOf,
  normalizeSettings,
  normalizeEvent,
  sampleEvents,
} from "../../shared/domain.js";
const defaults = DEFAULT_SETTINGS;
const WEIGHT_OVERRIDES_KEY = "energy-calendar-weight-overrides-v1";
const AI_CONFIG_KEY = "energy-calendar-ai-config-v1";
const DEFAULT_AI_CONFIG = {
  mode: "shared",
  hasCustomKey: false,
  customKeyMask: "",
  customBaseUrl: "",
  sharedAvailable: false,
  enabled: false,
  models: {},
};
const DISABLED_AI = { enabled: false, capabilities: {}, models: {} };
const readAiConfig = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ...DEFAULT_AI_CONFIG };
    }
    return {
      ...DEFAULT_AI_CONFIG,
      ...raw,
      mode: raw.mode === "custom" ? "custom" : "shared",
    };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
};
const writeAiConfig = (cfg) => {
  try {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore storage errors */
  }
};
const readWeightOverrides = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(WEIGHT_OVERRIDES_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
};
const writeWeightOverrides = (map) => {
  try {
    localStorage.setItem(WEIGHT_OVERRIDES_KEY, JSON.stringify(map));
  } catch {
    /* ignore storage errors */
  }
};
const eventWeightKey = (event) => {
  const duration = event.allDay
    ? "allDay"
    : Math.max(0, Math.round((+new Date(event.end) - +new Date(event.start)) / 60000));
  return `${event.title || ""}\u0000${event.tag || "other"}\u0000${event.description || ""}\u0000${duration}`;
};
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
  const [aiStatus, setAiStatus] = useState(DISABLED_AI);
  const [aiConfig, setAiConfig] = useState(() => isMobile ? DEFAULT_AI_CONFIG : readAiConfig());
  const [serverWeights, setServerWeights] = useState({});
  const [weightOverrides, setWeightOverrides] = useState(() =>
    isMobile ? {} : readWeightOverrides(),
  );
  const [aiScoringIds, setAiScoringIds] = useState(() => new Set());
  const aiWeights = useMemo(
    () => ({ ...serverWeights, ...weightOverrides }),
    [serverWeights, weightOverrides],
  );
  const current = useRef([]),
    saved = useRef([]),
    queue = useRef(Promise.resolve()),
    sequence = useRef(0),
    loadSeq = useRef(0);
  const history = useRef({ past: [], future: [] }),
    refreshBlocked = useRef(false),
    refreshing = useRef(false),
    demoRef = useRef(false),
    failure = useRef(null),
    ready = useRef(false),
    aiStatusRef = useRef(aiStatus),
    weightOverridesRef = useRef(weightOverrides),
    scoredKeysRef = useRef(new Map()),
    inFlightWeightKeysRef = useRef(new Map()),
    failedWeightKeysRef = useRef(new Map());
  aiStatusRef.current = aiStatus;
  weightOverridesRef.current = weightOverrides;
  const historyChanged = () =>
    setHistoryState({
      undo: !!history.current.past.length,
      redo: !!history.current.future.length,
    });
  const loadAiState = useCallback(async (eventList, seq) => {
    const hasStatus = typeof repository.aiStatus === "function";
    const hasWeights = typeof repository.aiWeights === "function";
    const hasConfig = typeof repository.aiGetConfig === "function";
    if (!hasStatus && !hasWeights && !hasConfig) return;
    if (isServer) {
      const info = await repository.info().catch(() => null);
      if (seq !== loadSeq.current || (info && !Object.hasOwn(info, "aiEnabled"))) return;
    }
    const [statusRes, weightsRes, configRes] = await Promise.all([
      hasStatus ? repository.aiStatus().catch(() => null) : null,
      hasWeights ? repository.aiWeights().catch(() => null) : null,
      hasConfig ? repository.aiGetConfig().catch(() => null) : null,
    ]);
    if (seq !== loadSeq.current) return;
    if (configRes && typeof configRes === "object") {
      const nextConfig = {
        ...DEFAULT_AI_CONFIG,
        ...configRes,
        mode: configRes.mode === "custom" ? "custom" : "shared",
      };
      setAiConfig(nextConfig);
      if (!isMobile) writeAiConfig(nextConfig);
    }
    if (statusRes && typeof statusRes === "object") {
      const nextStatus = {
        enabled: Boolean(statusRes.enabled),
        capabilities: statusRes.capabilities || {},
        models: statusRes.models || {},
      };
      aiStatusRef.current = nextStatus;
      setAiStatus(nextStatus);
    } else {
      aiStatusRef.current = DISABLED_AI;
      setAiStatus(DISABLED_AI);
    }
    if (
      weightsRes &&
      weightsRes.weights &&
      typeof weightsRes.weights === "object"
    ) {
      const map = new Map(eventList.map((e) => [String(e.id), e]));
      const nextScored = new Map();
      for (const id of Object.keys(weightsRes.weights)) {
        const ev = map.get(id);
        if (ev) nextScored.set(id, eventWeightKey(ev));
      }
      scoredKeysRef.current = nextScored;
      failedWeightKeysRef.current.clear();
      setServerWeights(weightsRes.weights);
    }
  }, []);
  const load = useCallback(async () => {
    ++sequence.current;
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError("");
    ready.current = false;
    if (isMobile) {
      aiStatusRef.current = DISABLED_AI;
      setAiStatus(DISABLED_AI);
      setAiConfig(DEFAULT_AI_CONFIG);
      setServerWeights({});
      setAiScoringIds(new Set());
      inFlightWeightKeysRef.current.clear();
      failedWeightKeysRef.current.clear();
      scoredKeysRef.current.clear();
      weightOverridesRef.current = {};
      setWeightOverrides({});
    }
    try {
      const [list, preferences, overrides] = await Promise.all([
        repository.list(),
        repository.getSettings(),
        isMobile ? repository.getWeightOverrides() : null,
      ]);
      if (seq !== loadSeq.current) return;
      const normalized = list.map(normalizeEvent);
      current.current = normalized;
      saved.current = normalized;
      history.current = { past: [], future: [] };
      setHistoryState({ undo: false, redo: false });
      failure.current = null; setStatus("saved");
      setEvents(normalized);
      setSettings(normalizeSettings(preferences));
      if (overrides) {
        weightOverridesRef.current = overrides;
        setWeightOverrides(overrides);
      }
      ready.current = true;
      loadAiState(normalized, seq);
    } catch (error) {
      if (seq === loadSeq.current) setLoadError(error.message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [loadAiState]);
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
        if (changes.upserts.length > 0 || changes.deletes.length > 0) {
          const before = new Map(saved.current.map(e => [e.id, e]));
          changes.bases = [...changes.upserts.map(e => e.id), ...changes.deletes].map(id => ({ id, event: before.get(id) ?? null }));
          await repository.apply(changes);
        }
        saved.current = next;
        failure.current = null;
        if (seq === sequence.current) setStatus("saved");
      })
      .catch((error) => {
        failure.current = error;
        if (seq === sequence.current) {
          setStatus("error");
          toast.error(isServer ? "尚未保存到服务器" : "尚未保存到本机", {
            description: "数据仍在当前窗口中，请点击底部的“重试保存”。",
          });
        }
      });
  }, []);
  const flush = useCallback(async () => {
    await queue.current;
    if (failure.current) throw failure.current;
  }, []);
  const refresh = useCallback(async () => {
    if (!ready.current || refreshing.current || refreshBlocked.current || demoRef.current || failure.current || current.current !== saved.current) return;
    refreshing.current = true;
    const seq = sequence.current, before = saved.current;
    try {
      await queue.current;
      const snapshot = repository.readSnapshot ? await repository.readSnapshot() : { events: await repository.list() };
      if (seq !== sequence.current || before !== saved.current || refreshBlocked.current || demoRef.current) return;
      snapshot.accept?.();
      const next = snapshot.events.map(normalizeEvent);
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        current.current = saved.current = next; setEvents(next);
        history.current = { past: [], future: [] }; historyChanged();
      }
    } catch { /* Offline status is displayed separately; never replace unsaved state. */ }
    finally { refreshing.current = false; }
  }, []);
  useEffect(() => {
    if (!isLocalApp && !isServer) return;
    const timer = setInterval(refresh, 3000);
    const unsubscribe = repository.onChanged?.(refresh);
    const wake = () => {
      repository.syncNow?.().catch(() => {});
      refresh();
    };
    const appState = isMobile
      ? CapacitorApp.addListener("appStateChange", ({ isActive }) => { if (isActive) wake(); })
      : null;
    appState?.catch(() => {});
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => {
      clearInterval(timer);
      unsubscribe?.();
      appState?.then((handle) => handle.remove()).catch(() => {});
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
    };
  }, [refresh]);
  useEffect(() => {
    if (isMobile) return;
    const unsubscribe = repository.onClosing?.(async () => {
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
  const scoreEvents = useCallback(async (targetEvents, { force = false } = {}) => {
    if (
      typeof repository.aiCognitiveWeight !== "function" ||
      !aiStatusRef.current.enabled ||
      demoRef.current
    ) {
      return [];
    }
    const list = (
      Array.isArray(targetEvents) ? targetEvents : [targetEvents]
    ).filter((e) => e && e.id && e.title);
    if (!list.length) return [];
    const seq = loadSeq.current;
    const ids = list.map((e) => String(e.id));
    list.forEach((e) =>
      inFlightWeightKeysRef.current.set(String(e.id), eventWeightKey(e)),
    );
    setAiScoringIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    const collected = [];
    try {
      for (let i = 0; i < list.length; i += 50) {
        const batch = list.slice(i, i + 50);
        const res = await repository.aiCognitiveWeight({
          events: batch.map((e) => ({
            id: String(e.id),
            title: e.title,
            start: e.start,
            end: e.end,
            allDay: !!e.allDay,
            tag: e.tag,
            description: e.description || "",
          })),
          force,
        });
        if (isMobile && seq !== loadSeq.current) return [];
        const items = Array.isArray(res?.weights) ? res.weights : [];
        if (items.length) {
          collected.push(...items);
          setServerWeights((prev) => {
            const next = { ...prev };
            for (const w of items) {
              if (w?.id) next[String(w.id)] = w;
            }
            return next;
          });
          for (const e of batch) {
            const key = eventWeightKey(e);
            scoredKeysRef.current.set(String(e.id), key);
            failedWeightKeysRef.current.delete(String(e.id));
          }
        }
      }
      return collected;
    } catch (error) {
      if (isMobile && seq !== loadSeq.current) return [];
      for (const e of list) {
        failedWeightKeysRef.current.set(String(e.id), eventWeightKey(e));
      }
      throw error;
    } finally {
      if (!isMobile || seq === loadSeq.current) {
        ids.forEach((id) => inFlightWeightKeysRef.current.delete(id));
        setAiScoringIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }
    }
  }, []);
  useEffect(() => {
    if (
      !ready.current ||
      !aiStatus.enabled ||
      demo ||
      typeof repository.aiCognitiveWeight !== "function"
    ) {
      return;
    }
    const unscored = events.filter((e) => {
      const id = String(e.id);
      if (weightOverrides[id]) return false;
      const key = eventWeightKey(e);
      if (scoredKeysRef.current.get(id) === key) return false;
      if (inFlightWeightKeysRef.current.get(id) === key) return false;
      if (failedWeightKeysRef.current.get(id) === key) return false;
      return true;
    });
    if (!unscored.length) return;
    const ordered = [
      ...unscored.filter((e) => !e.completed),
      ...unscored.filter((e) => e.completed),
    ].slice(0, 50);
    const timer = setTimeout(() => {
      scoreEvents(ordered).catch(() => {});
    }, 450);
    return () => clearTimeout(timer);
  }, [events, aiStatus.enabled, demo, weightOverrides, scoreEvents]);
  const saveEvent = useCallback(
    (data) => {
      const event = normalizeEvent(data);
      const changed = commit((list) => {
        const index = list.findIndex((e) => e.id === event.id);
        if (index < 0) return [...list, event];
        if (JSON.stringify(list[index]) === JSON.stringify(event)) return list;
        return list.map((e) => (e.id === event.id ? event : e));
      }, "日程已保存");
      if (
        changed &&
        aiStatusRef.current.enabled &&
        !demoRef.current &&
        !weightOverridesRef.current[String(event.id)]
      ) {
        scoreEvents([event]).catch(() => {});
      }
      return changed;
    },
    [commit, scoreEvents],
  );
  const saveEventsBatch = useCallback(
    (drafts, label) => {
      const normalized = (Array.isArray(drafts) ? drafts : [])
        .map((d) => normalizeEvent(d))
        .filter(Boolean);
      if (!normalized.length) return false;
      const byId = new Map(normalized.map((e) => [e.id, e]));
      const changed = commit((list) => {
        const existingIds = new Set(list.map((e) => e.id));
        const updated = list.map((e) => (byId.has(e.id) ? byId.get(e.id) : e));
        const appended = normalized.filter((e) => !existingIds.has(e.id));
        return [...updated, ...appended];
      }, label || `已添加 ${normalized.length} 项日程`);
      if (changed && aiStatusRef.current.enabled && !demoRef.current) {
        const toScore = normalized.filter(
          (e) => !weightOverridesRef.current[String(e.id)],
        );
        if (toScore.length) scoreEvents(toScore).catch(() => {});
      }
      return changed;
    },
    [commit, scoreEvents],
  );
  const persistOverride = useCallback((id, record) => {
    const update = () => {
      const next = { ...weightOverridesRef.current };
      if (record) next[id] = record;
      else delete next[id];
      weightOverridesRef.current = next;
      setWeightOverrides(next);
      if (!isMobile) writeWeightOverrides(next);
    };
    if (!isMobile) {
      update();
      return Promise.resolve(true);
    }
    if (demoRef.current) return Promise.resolve(false);
    const seq = loadSeq.current;
    const task = queue.current.then(async () => {
      if (failure.current) throw failure.current;
      if (seq !== loadSeq.current) return false;
      await repository.setWeightOverride(id, record);
      if (seq !== loadSeq.current) return false;
      update();
      return true;
    }).catch((error) => {
      toast.error("认知负荷设置未能保存", { description: error.message });
      return false;
    });
    queue.current = task;
    return task;
  }, []);
  const setCognitiveOverride = useCallback(
    (eventId, score) => {
      if (!eventId) return;
      const id = String(eventId);
      const level = score == null ? null : cognitiveLevelOf(score);
      const record = level && {
        id,
        score: level.score,
        expectedScore: level.score,
        label: level.label,
        confidence: 1,
        manual: true,
        updatedAt: Date.now(),
      };
      return persistOverride(id, record).then((persisted) => {
        if (!persisted || record || !aiStatusRef.current.enabled || demoRef.current) return;
        const event = current.current.find((item) => String(item.id) === id);
        if (event) scoreEvents([event]).catch(() => {});
      });
    },
    [persistOverride, scoreEvents],
  );
  const rescoreEvent = useCallback(
    async (eventData) => {
      if (!eventData?.id) return null;
      const id = String(eventData.id);
      if (!(await persistOverride(id, null))) return null;
      const results = await scoreEvents([eventData], { force: true });
      return results[0] ?? null;
    },
    [persistOverride, scoreEvents],
  );
  const quickCapture = useCallback(async (payload, options) => {
    if (typeof repository.aiQuickCapture !== "function") {
      throw new Error("当前模式不支持 AI 快建");
    }
    return await repository.aiQuickCapture(payload, options);
  }, []);
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
    (idOrIds) => {
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
      const idSet = new Set(ids.filter((v) => v != null).map(String));
      if (!idSet.size) return false;
      let removedCount = 0;
      const changed = commit((list) => {
        const next = list.filter((e) => !idSet.has(String(e.id)));
        removedCount = list.length - next.length;
        return next;
      }, "");
      if (changed) {
        toast(
          removedCount > 1 ? `已删除 ${removedCount} 项日程` : "日程已删除",
          { action: { label: "撤销", onClick: undo } },
        );
      }
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
        const result = typeof repository.importBackup === "function"
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
      if (!result.canceled) toast.success(isMobile ? "已打开备份分享" : "日历备份已导出");
    } catch (error) {
      toast.error("导出失败", { description: error.message });
    }
  }, [flush]);
  const switchSpace = useCallback(async (operation) => {
    await flush();
    ready.current = false; setLoading(true); ++sequence.current;
    if (isMobile) ++loadSeq.current;
    try { return await operation(); }
    finally { await load(); }
  }, [flush, load]);
  const updateAiConfig = useCallback(
    async ({ mode, apiKey, baseUrl } = {}) => {
      if (typeof repository.aiSetConfig !== "function") {
        const nextMode = mode === "custom" ? "custom" : "shared";
        const nextConfig = {
          ...aiConfig,
          mode: nextMode,
          ...(baseUrl !== undefined
            ? { customBaseUrl: String(baseUrl || "").trim() }
            : {}),
        };
        setAiConfig(nextConfig);
        writeAiConfig(nextConfig);
        toast("本地已记录偏好；AI 能力需在网页服务端账号中启用");
        return nextConfig;
      }
      const payload = {};
      if (mode !== undefined) {
        payload.mode = mode === "custom" ? "custom" : "shared";
      }
      if (apiKey !== undefined) payload.apiKey = apiKey;
      if (baseUrl !== undefined) payload.baseUrl = baseUrl;
      const res = await repository.aiSetConfig(payload);
      const nextConfig = {
        ...DEFAULT_AI_CONFIG,
        ...res,
        mode: res?.mode === "custom" ? "custom" : "shared",
      };
      setAiConfig(nextConfig);
      if (!isMobile) writeAiConfig(nextConfig);
      const nextStatus = {
        enabled: Boolean(nextConfig.enabled),
        capabilities: {
          quickCapture: Boolean(nextConfig.enabled),
          voiceTranscribe: Boolean(nextConfig.enabled),
          cognitiveWeight: Boolean(nextConfig.enabled),
        },
        models: nextConfig.models || aiStatusRef.current.models || {},
      };
      aiStatusRef.current = nextStatus;
      setAiStatus(nextStatus);
      if (nextStatus.enabled) {
        failedWeightKeysRef.current.clear();
        if (typeof repository.aiStatus === "function") {
          repository
            .aiStatus()
            .then((fresh) => {
              if (!fresh || typeof fresh !== "object") return;
              const synced = {
                enabled: Boolean(fresh.enabled),
                capabilities: fresh.capabilities || {},
                models: fresh.models || {},
              };
              aiStatusRef.current = synced;
              setAiStatus(synced);
            })
            .catch(() => {});
        }
      }
      toast.success("AI API 设置已保存");
      return nextConfig;
    },
    [aiConfig],
  );
  return {
    events,
    loading,
    loadError,
    status,
    settings,
    demo,
    historyState,
    aiStatus,
    aiConfig,
    aiWeights,
    aiScoringIds,
    saveEvent,
    saveEventsBatch,
    setCognitiveOverride,
    rescoreEvent,
    quickCapture,
    updateAiConfig,
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
    flush,
    switchSpace,
    refreshRemote: refresh,
    blockRefresh: (value) => { refreshBlocked.current = value; },
  };
}
