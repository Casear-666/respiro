import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CornerDownLeft,
  ImagePlus,
  LoaderCircle,
  Mic,
  Plus,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  CATEGORIES,
  addDays,
  categoryOf,
  dateKey,
  formatTime,
  localDate,
  normalizeEvent,
} from "../../shared/domain";
import Dialog from "./Dialog";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_SECONDS = 120;
const weekNames = ["日", "一", "二", "三", "四", "五", "六"];
const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || "");
const MOD = isMac ? "⌘" : "Ctrl";

const shortDate = (value) => {
  const d = localDate(value);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekNames[d.getDay()]}`;
};

const toDatetimeInput = (value) => {
  const d = localDate(value);
  return `${dateKey(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const formatTimer = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function getClientTimeContext(settings) {
  const now = new Date();
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const utcOffset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const pad = (n) => String(n).padStart(2, "0");
  const referenceDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${utcOffset}`;
  return {
    referenceDate,
    timezone,
    utcOffset,
    workStart: settings?.workStart || "08:00",
    workEnd: settings?.workEnd || "22:00",
    languageCodes: ["cmn-Hans-CN", "en-US"],
  };
}

function toReviewDraft(draft, index) {
  const allDay = Boolean(draft.allDay);
  const startInput = allDay
    ? dateKey(localDate(draft.start))
    : toDatetimeInput(draft.start);
  const endInput = allDay
    ? dateKey(addDays(draft.end, -1))
    : toDatetimeInput(draft.end);
  return {
    _key: `${draft.id || "draft"}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    id: draft.id,
    title: draft.title || "",
    tag: CATEGORIES.some((c) => c.id === draft.tag) ? draft.tag : "other",
    allDay,
    startInput,
    endInput,
    description: draft.description || "",
    selected: true,
  };
}

function reviewDraftToEvent(item) {
  return normalizeEvent({
    id: item.id,
    title: item.title,
    description: item.description,
    tag: item.tag,
    allDay: item.allDay,
    start: item.allDay ? item.startInput : localDate(item.startInput),
    end: item.allDay
      ? dateKey(addDays(item.endInput, 1))
      : localDate(item.endInput),
    completed: false,
  });
}

function findConflicts(item, existingEvents) {
  if (item.allDay) return [];
  const s = +localDate(item.startInput);
  const e = +localDate(item.endInput);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return [];
  return existingEvents.filter((ev) => {
    if (ev.completed || ev.allDay) return false;
    const es = +localDate(ev.start);
    const ee = +localDate(ev.end);
    return es < e && ee > s;
  });
}

function Keys({ value }) {
  return (
    <span className="kbd-group">
      {value.split(" ").map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}

function Highlight({ text, query }) {
  if (!query) return text;
  const index = text.toLocaleLowerCase().indexOf(query);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

export default function SearchDialog({
  events,
  actions,
  aiEnabled = false,
  settings,
  initialCapture = null,
  onQuickCapture,
  onCommitDrafts,
  onClose,
  onChoose,
  onCreate,
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [image, setImage] = useState(() => initialCapture?.image || null);
  const [audio, setAudio] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [capturePhase, setCapturePhase] = useState("");
  const [error, setError] = useState("");
  const [review, setReview] = useState(null);

  const listRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const recordChunksRef = useRef([]);
  const recordTimerRef = useRef(null);
  const recordCancelRef = useRef(false);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      clearInterval(recordTimerRef.current);
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        recordCancelRef.current = true;
        try {
          mediaRecorderRef.current.stop();
        } catch {}
      }
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const hasMedia = Boolean(image || audio);
  const canRunAi = Boolean(aiEnabled && onQuickCapture && (query.trim() || hasMedia));

  const runQuickCapture = useCallback(
    async ({ textOverride, imageOverride, audioOverride } = {}) => {
      if (!aiEnabled || !onQuickCapture || capturing) return;
      const textVal = (textOverride ?? query).trim();
      const imgVal = imageOverride !== undefined ? imageOverride : image;
      const audVal = audioOverride !== undefined ? audioOverride : audio;
      if (!textVal && !imgVal && !audVal) {
        setError("请输入文字、粘贴截图或录制语音");
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setError("");
      setCapturing(true);
      setCapturePhase(
        audVal
          ? "正在转写语音并提取日程…"
          : imgVal
            ? "正在从截图中识别时间与事项…"
            : "正在解析日程安排…",
      );
      try {
        const payload = {
          ...(textVal ? { text: textVal } : {}),
          ...(imgVal ? { image: { data: imgVal.data, mimeType: imgVal.mimeType } } : {}),
          ...(audVal ? { audio: { data: audVal.data, mimeType: audVal.mimeType } } : {}),
          ...getClientTimeContext(settings),
        };
        const result = await onQuickCapture(payload, { signal: controller.signal });
        if (!mountedRef.current || controller.signal.aborted) return;
        const drafts = Array.isArray(result?.drafts)
          ? result.drafts.map(toReviewDraft)
          : [];
        const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
        const transcript =
          typeof result?.transcript === "string" ? result.transcript.trim() : "";
        setReview({
          transcript,
          warnings,
          drafts,
        });
      } catch (err) {
        if (!mountedRef.current || err?.canceled || err?.name === "AbortError") {
          return;
        }
        setError(err?.message || "AI 解析失败，请重试");
      } finally {
        if (mountedRef.current) {
          setCapturing(false);
          setCapturePhase("");
        }
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [aiEnabled, onQuickCapture, capturing, query, image, audio, settings],
  );

  const attachImageFile = useCallback(
    async (file) => {
      if (!aiEnabled || !file) return;
      if (!String(file.type || "").startsWith("image/")) {
        setError("仅支持图片文件（PNG / JPG / WebP 等）");
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError("图片体积超过 10 MB 上限");
        return;
      }
      try {
        const data = await readAsDataUrl(file);
        if (!mountedRef.current) return;
        setError("");
        setImage({
          data,
          mimeType: file.type || "image/png",
          name: file.name || "剪贴板截图",
        });
      } catch (err) {
        setError(err?.message || "无法读取图片");
      }
    },
    [aiEnabled],
  );

  const stopRecording = useCallback((cancel = false) => {
    recordCancelRef.current = cancel;
    clearInterval(recordTimerRef.current);
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    } else {
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      setRecording(false);
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!aiEnabled || recording || capturing) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("当前浏览器不支持麦克风录音");
      return;
    }
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const preferredMime = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((m) => MediaRecorder.isTypeSupported?.(m));
      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordChunksRef.current = [];
      recordCancelRef.current = false;
      setRecordSeconds(0);
      setRecording(true);

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        clearInterval(recordTimerRef.current);
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        if (!mountedRef.current) return;
        setRecording(false);
        if (recordCancelRef.current) {
          recordChunksRef.current = [];
          return;
        }
        const mimeType = recorder.mimeType || preferredMime || "audio/webm";
        const blob = new Blob(recordChunksRef.current, { type: mimeType });
        recordChunksRef.current = [];
        if (!blob.size) {
          setError("未能录到有效语音，请重试");
          return;
        }
        if (blob.size > 12 * 1024 * 1024) {
          setError("语音超过 12 MB 上限，请缩短录音时长");
          return;
        }
        try {
          const data = await readAsDataUrl(blob);
          if (!mountedRef.current) return;
          const recordedAudio = { data, mimeType };
          setAudio(recordedAudio);
          runQuickCapture({ audioOverride: recordedAudio });
        } catch (err) {
          setError(err?.message || "处理语音失败");
        }
      };

      recorder.start(250);
      recordTimerRef.current = setInterval(() => {
        setRecordSeconds((s) => {
          if (s + 1 >= MAX_RECORD_SECONDS) {
            stopRecording(false);
          }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      setRecording(false);
      if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
        setError("未授予麦克风权限，请在浏览器设置中允许后重试");
      } else if (err?.name === "NotFoundError") {
        setError("未检测到可用的麦克风设备");
      } else {
        setError(err?.message || "无法启动录音");
      }
    }
  }, [aiEnabled, recording, capturing, runQuickCapture, stopRecording]);

  const q = query.trim().toLocaleLowerCase();
  const groups = useMemo(() => {
    const byStart = (a, b) => +localDate(a.start) - +localDate(b.start);
    const matchedEvents = q
      ? events
          .filter((e) =>
            `${e.title} ${e.description}`.toLocaleLowerCase().includes(q),
          )
          .sort(byStart)
          .slice(0, 30)
      : events
          .filter((e) => !e.completed && +localDate(e.end) >= Date.now())
          .sort(byStart)
          .slice(0, 6);

    const aiAction =
      aiEnabled && (q || hasMedia)
        ? {
            id: "ai-quick-capture",
            label: hasMedia
              ? q
                ? `AI 提取日程（结合附件 +「${query.trim()}」）`
                : "AI 识别附件中的日程"
              : `AI 智能提取日程：「${query.trim()}」`,
            keywords: "ai capture quick",
            icon: <Sparkles size={15} />,
            shortcut: hasMedia ? "Enter" : `${MOD} Enter`,
            isAi: true,
            run: () => runQuickCapture(),
          }
        : null;

    const createAction = q
      ? {
          id: "create-event",
          label: `新建日程「${query.trim()}」`,
          keywords: "",
          icon: <Plus size={15} />,
          run: () => onCreate(query.trim()),
        }
      : null;

    const filteredActions = actions.filter(
      (a) =>
        !q ||
        `${a.label} ${a.keywords || ""}`.toLocaleLowerCase().includes(q),
    );

    const matchedActions = [
      ...(aiAction && hasMedia ? [aiAction] : []),
      ...(createAction ? [createAction] : []),
      ...(aiAction && !hasMedia ? [aiAction] : []),
      ...filteredActions,
    ];

    const eventGroup = matchedEvents.length && {
      label: q ? "日程" : "即将到来",
      items: matchedEvents.map((event) => ({ kind: "event", event })),
    };
    const actionGroup = matchedActions.length && {
      label: q || hasMedia ? "操作" : "快捷操作",
      items: matchedActions.map((action) => ({ kind: "action", action })),
    };
    return (q && !hasMedia
      ? [eventGroup, actionGroup]
      : [actionGroup, eventGroup]
    ).filter(Boolean);
  }, [events, actions, q, query, onCreate, aiEnabled, hasMedia, runQuickCapture]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  useEffect(() => setActive(0), [q, hasMedia]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (item) => {
    if (!item) return;
    if (item.kind === "event") onChoose(item.event);
    else if (item.action.isAi) {
      item.action.run();
    } else {
      onClose();
      item.action.run();
    }
  };

  // Draft review helpers
  const updateDraft = (key, patch) => {
    setReview((prev) =>
      prev
        ? {
            ...prev,
            drafts: prev.drafts.map((d) =>
              d._key === key ? { ...d, ...patch } : d,
            ),
          }
        : prev,
    );
  };

  const toggleDraftAllDay = (item, allDay) => {
    if (allDay) {
      updateDraft(item._key, {
        allDay: true,
        startInput: item.startInput.slice(0, 10),
        endInput: item.endInput.slice(0, 10),
      });
    } else {
      updateDraft(item._key, {
        allDay: false,
        startInput: `${item.startInput.slice(0, 10)}T09:00`,
        endInput: `${item.endInput.slice(0, 10)}T10:00`,
      });
    }
  };

  const evaluatedDrafts = useMemo(() => {
    if (!review) return [];
    return review.drafts.map((item) => {
      let validationError = "";
      try {
        reviewDraftToEvent(item);
      } catch (err) {
        validationError = err?.message || "时间格式无效";
      }
      const conflicts = validationError ? [] : findConflicts(item, events);
      return { item, validationError, conflicts };
    });
  }, [review, events]);

  const selectedDrafts = evaluatedDrafts.filter((d) => d.item.selected);
  const invalidSelected = selectedDrafts.some((d) => Boolean(d.validationError));

  const commitSelectedDrafts = () => {
    if (!selectedDrafts.length || invalidSelected) return;
    const normalized = selectedDrafts.map(({ item }) => reviewDraftToEvent(item));
    onCommitDrafts(normalized);
  };

  if (review) {
    return (
      <Dialog
        label="确认 AI 提取的日程"
        onClose={onClose}
        className="search-dialog search-dialog-review"
      >
        <div className="review-header">
          <button
            type="button"
            className="icon-button sm"
            aria-label="返回修改输入"
            onClick={() => {
              setReview(null);
              setError("");
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            <ArrowLeft size={16} />
          </button>
          <div className="review-heading">
            <strong>
              <Sparkles size={14} aria-hidden="true" />
              提取到 {review.drafts.length} 项日程草稿
            </strong>
            <span>确认前可直接修改标题、时间、分类或取消勾选</span>
          </div>
          <button
            type="button"
            className="icon-button sm"
            aria-label="关闭窗口"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div
          className="review-body"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              commitSelectedDrafts();
            }
          }}
        >
          {review.transcript && (
            <div className="review-transcript">
              <Mic size={14} aria-hidden="true" />
              <span>“{review.transcript}”</span>
            </div>
          )}

          {review.warnings.length > 0 && (
            <div className="review-warnings" role="status">
              {review.warnings.map((w, i) => (
                <p key={i}>
                  <AlertTriangle size={13} aria-hidden="true" />
                  <span>{w}</span>
                </p>
              ))}
            </div>
          )}

          {review.drafts.length === 0 ? (
            <div className="review-empty">
              <p>未识别出可添加的日程时间信息。</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setReview(null);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                返回补充说明
              </button>
            </div>
          ) : (
            <div className="review-list">
              {evaluatedDrafts.map(({ item, validationError, conflicts }) => {
                const cat = categoryOf(item);
                return (
                  <div
                    key={item._key}
                    className={`draft-card${item.selected ? "" : " is-unchecked"}${validationError ? " has-error" : ""}`}
                    style={{ "--category": cat.color }}
                  >
                    <div className="draft-card-top">
                      <label className="draft-check">
                        <input
                          type="checkbox"
                          checked={item.selected}
                          aria-label={`选择 ${item.title || "日程"}`}
                          onChange={(e) =>
                            updateDraft(item._key, { selected: e.target.checked })
                          }
                        />
                      </label>
                      <span
                        className="draft-cat-dot"
                        style={{ background: cat.color }}
                        aria-hidden="true"
                      />
                      <select
                        className="draft-tag-select"
                        aria-label="日程分类"
                        value={item.tag}
                        onChange={(e) =>
                          updateDraft(item._key, { tag: e.target.value })
                        }
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        className="draft-title-input"
                        aria-label="日程标题"
                        value={item.title}
                        maxLength={200}
                        placeholder="日程标题"
                        onChange={(e) =>
                          updateDraft(item._key, { title: e.target.value })
                        }
                      />
                      <label className="draft-allday">
                        <input
                          type="checkbox"
                          checked={item.allDay}
                          onChange={(e) =>
                            toggleDraftAllDay(item, e.target.checked)
                          }
                        />
                        全天
                      </label>
                    </div>

                    <div className="draft-card-times">
                      <input
                        type={item.allDay ? "date" : "datetime-local"}
                        aria-label="开始时间"
                        value={item.startInput}
                        onChange={(e) =>
                          updateDraft(item._key, { startInput: e.target.value })
                        }
                      />
                      <span className="draft-time-sep" aria-hidden="true">
                        →
                      </span>
                      <input
                        type={item.allDay ? "date" : "datetime-local"}
                        aria-label="结束时间"
                        value={item.endInput}
                        onChange={(e) =>
                          updateDraft(item._key, { endInput: e.target.value })
                        }
                      />
                    </div>

                    <input
                      type="text"
                      className="draft-desc-input"
                      aria-label="备注"
                      value={item.description}
                      maxLength={5000}
                      placeholder="补充备注、地点或准备事项（可选）"
                      onChange={(e) =>
                        updateDraft(item._key, { description: e.target.value })
                      }
                    />

                    {(validationError || conflicts.length > 0) && (
                      <div className="draft-alerts">
                        {validationError && (
                          <span className="draft-alert is-error">
                            {validationError}
                          </span>
                        )}
                        {conflicts.length > 0 && (
                          <span className="draft-alert is-conflict">
                            <AlertTriangle size={12} aria-hidden="true" />
                            与「{conflicts[0].title}」
                            {conflicts.length > 1
                              ? `等 ${conflicts.length} 项`
                              : ""}
                            时间重叠（{formatTime(conflicts[0].start)}–
                            {formatTime(conflicts[0].end)}）
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="review-footer">
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setReview(null);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            返回修改
          </button>
          <div className="review-footer-actions">
            <span className="review-count">
              已选 {selectedDrafts.length} / {review.drafts.length} 项
            </span>
            <button
              type="button"
              className="primary-button"
              disabled={!selectedDrafts.length || invalidSelected}
              onClick={commitSelectedDrafts}
            >
              <Check size={15} />
              确认添加 {selectedDrafts.length} 项日程
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  let index = -1;
  return (
    <Dialog
      label="搜索日程与 AI 快建"
      onClose={onClose}
      className="search-dialog"
    >
      <div
        className="search-dialog-dropzone"
        onDragOver={(e) => {
          if (aiEnabled && e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => {
          if (!aiEnabled) return;
          const file = [...(e.dataTransfer?.files || [])].find((f) =>
            f.type.startsWith("image/"),
          );
          if (file) {
            e.preventDefault();
            attachImageFile(file);
          }
        }}
      >
        <div className="search-dialog-input">
          <Search size={19} />
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={flat.length ? `palette-${active}` : undefined}
            aria-label="搜索日程或输入自然语言快建"
            placeholder={
              initialCapture?.focusAi || aiEnabled
                ? "搜索日程，或输入安排 / 粘贴截图 / 语音快建…"
                : "搜索日程，或输入一个操作…"
            }
            value={query}
            disabled={capturing}
            onChange={(e) => {
              setQuery(e.target.value);
              setError("");
            }}
            onPaste={(e) => {
              if (!aiEnabled) return;
              const items = [...(e.clipboardData?.items || [])];
              const imgItem = items.find((item) =>
                item.type.startsWith("image/"),
              );
              const file =
                imgItem?.getAsFile?.() ||
                [...(e.clipboardData?.files || [])].find((f) =>
                  f.type.startsWith("image/"),
                );
              if (file) {
                e.preventDefault();
                attachImageFile(file);
              }
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                (e.ctrlKey || e.metaKey) &&
                canRunAi &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                runQuickCapture();
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!flat.length) return;
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setActive((i) => (i + delta + flat.length) % flat.length);
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (hasMedia && aiEnabled) {
                  runQuickCapture();
                } else {
                  run(flat[active]);
                }
              }
            }}
          />
          {aiEnabled && (
            <div className="palette-ai-tools">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="visually-hidden"
                aria-label="上传日程截图"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) attachImageFile(file);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className={`icon-button sm${image ? " is-active" : ""}`}
                aria-label="添加图片或截图"
                title="添加图片或截图（也可直接 Ctrl+V 粘贴）"
                disabled={capturing || recording}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus size={16} />
              </button>
              <button
                type="button"
                className={`icon-button sm${recording ? " is-recording" : ""}`}
                aria-label={recording ? "完成录音并解析" : "语音快建日程"}
                title={recording ? "停止录音并识别日程" : "语音录入日程"}
                disabled={capturing}
                onClick={() => (recording ? stopRecording(false) : startRecording())}
              >
                {recording ? <Square size={14} /> : <Mic size={16} />}
              </button>
              {canRunAi && !recording && (
                <button
                  type="button"
                  className="palette-ai-submit"
                  disabled={capturing}
                  onClick={() => runQuickCapture()}
                  title={`AI 提取日程（${MOD} Enter）`}
                >
                  <Sparkles size={13} />
                  <span>提取</span>
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className="icon-button sm"
            aria-label="关闭搜索"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {recording && (
          <div className="palette-recording-bar" role="status">
            <span className="recording-dot" aria-hidden="true" />
            <span>正在聆听… {formatTimer(recordSeconds)}</span>
            <div className="recording-actions">
              <button
                type="button"
                className="ghost-button sm"
                onClick={() => stopRecording(true)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button sm"
                onClick={() => stopRecording(false)}
              >
                完成并提取
              </button>
            </div>
          </div>
        )}

        {(image || audio) && !recording && (
          <div className="palette-attachments">
            {image && (
              <div className="attachment-pill">
                <img src={image.data} alt="待识别截图" />
                <span>{image.name || "截图附件"}</span>
                <button
                  type="button"
                  aria-label="移除截图"
                  disabled={capturing}
                  onClick={() => setImage(null)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )}
            {audio && (
              <div className="attachment-pill">
                <Mic size={14} aria-hidden="true" />
                <span>已录制语音片段</span>
                <button
                  type="button"
                  aria-label="移除语音"
                  disabled={capturing}
                  onClick={() => setAudio(null)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="palette-error" role="alert">
            <span>{error}</span>
          </div>
        )}

        {capturing ? (
          <div className="palette-loading" role="status">
            <LoaderCircle size={22} className="spin" />
            <div>
              <strong>{capturePhase}</strong>
              <span>支持文字、聊天截图、课表与语音多模态提取</span>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                abortRef.current?.abort();
                setCapturing(false);
                setCapturePhase("");
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <div
            className="search-results"
            id="palette-list"
            role="listbox"
            ref={listRef}
          >
            {groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label}>
                <div className="palette-group-label">{group.label}</div>
                {group.items.map((item) => {
                  index += 1;
                  const i = index;
                  const selected = i === active;
                  if (item.kind === "event") {
                    const e = item.event;
                    return (
                      <button
                        type="button"
                        tabIndex={-1}
                        role="option"
                        id={`palette-${i}`}
                        data-index={i}
                        aria-selected={selected}
                        className="palette-item"
                        key={`e-${e.id}`}
                        onMouseMove={() => !selected && setActive(i)}
                        onClick={() => run(item)}
                      >
                        <span
                          className="search-result-dot"
                          style={{ background: categoryOf(e).color }}
                        />
                        <span className="palette-text">
                          <strong>
                            <Highlight text={e.title} query={q} />
                          </strong>
                          <small>
                            {shortDate(e.start)} ·{" "}
                            {e.allDay ? "全天" : formatTime(e.start)}
                            {e.completed ? " · 已完成" : ""}
                          </small>
                        </span>
                        <CornerDownLeft size={14} className="palette-enter" />
                      </button>
                    );
                  }
                  const a = item.action;
                  return (
                    <button
                      type="button"
                      tabIndex={-1}
                      role="option"
                      id={`palette-${i}`}
                      data-index={i}
                      aria-selected={selected}
                      className={`palette-item${a.isAi ? " is-ai-action" : ""}`}
                      key={`a-${a.id}`}
                      onMouseMove={() => !selected && setActive(i)}
                      onClick={() => run(item)}
                    >
                      <span className="palette-icon">{a.icon}</span>
                      <span className="palette-text">
                        <strong>
                          <Highlight text={a.label} query={q} />
                        </strong>
                      </span>
                      {a.shortcut && <Keys value={a.shortcut} />}
                    </button>
                  );
                })}
              </div>
            ))}
            {!flat.length && (
              <p className="search-empty">
                {q
                  ? "没有找到，试试另一个关键词。"
                  : "输入日程名称或备注，快速回到那一天。"}
              </p>
            )}
          </div>
        )}
        <div className="palette-footer" aria-hidden="true">
          <span>
            <Keys value="↑ ↓" /> 选择
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>
            打开
          </span>
          {aiEnabled && (
            <span>
              <Keys value={`${MOD} V`} /> 粘贴截图
            </span>
          )}
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </Dialog>
  );
}
