import {
  normalizeEvent,
  CATEGORIES,
  dateKey,
  localDate,
  addDays,
} from "../shared/domain.js";
import {
  createGeminiClient,
  DEFAULT_CAPTURE_MODEL,
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_DECISION_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
} from "./gemini.js";
import {
  eventDurationMinutes,
  maskApiKey,
  weightFingerprint,
} from "./ai-store.js";

const MAX_TEXT_LENGTH = 10_000;
const MAX_CAPTURE_EVENTS = 20;
const MAX_WEIGHT_BATCH = 50;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const UTC_OFFSET_RE = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/bmp",
]);
const IMAGE_MIME_ALIASES = {
  "image/jpg": "image/jpeg",
};

const ALLOWED_AUDIO_MIMES = new Set([
  "audio/wav",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/mpeg",
  "audio/m4a",
  "audio/l16",
  "audio/opus",
  "audio/alaw",
  "audio/mulaw",
  "audio/webm",
]);
const AUDIO_MIME_ALIASES = {
  "audio/mp4": "audio/m4a",
  "audio/x-m4a": "audio/m4a",
  "audio/x-wav": "audio/wav",
};

export const COGNITIVE_LEVELS = [
  {
    score: 1,
    label: "恢复放松",
    criteria:
      "0: Restorative or leisure activity with minimal mental load (rest, break, walk, lunch, coffee, casual personal hangout, sleep).",
  },
  {
    score: 2,
    label: "轻量事务",
    criteria:
      "1: Light routine errands, quick check-ins, simple logistics, or short administrative tasks under 30 minutes.",
  },
  {
    score: 3,
    label: "常规协作",
    criteria:
      "2: Moderate cognitive effort such as standard meetings, status syncs, ordinary operational work, or routine reviews.",
  },
  {
    score: 4,
    label: "深度专注",
    criteria:
      "3: Sustained deep focus or analytical/creative work such as coding, writing, system design, study blocks, or 1.5–4 hour concentration.",
  },
  {
    score: 5,
    label: "高压攻坚",
    criteria:
      "4: Peak cognitive exertion, high-stakes presentations, critical deadlines, complex problem-solving, exams, or marathon 4+ hour deep work.",
  },
];

const QUICK_CAPTURE_SCHEMA = {
  type: "object",
  properties: {
    transcript: {
      type: "string",
      description: "当输入包含语音时，先给出简明中文/原文转写",
    },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "简洁明确的日程标题（不超过 200 字）" },
          start: {
            type: "string",
            description:
              "开始时间。定时日程为带时区偏移的 ISO 8601（例如 2026-11-20T14:00:00+08:00），全天日程为 YYYY-MM-DD",
          },
          end: {
            type: "string",
            description:
              "结束时间。定时日程为带时区偏移的 ISO 8601，全天日程为排他结束日期 YYYY-MM-DD（至少晚于 start 1 天）",
          },
          allDay: { type: "boolean", description: "是否为全天日程" },
          tag: {
            type: "string",
            enum: CATEGORIES.map((c) => c.id),
            description: "日程分类标签 ID",
          },
          description: {
            type: "string",
            description: "备注细节，例如地点、参会人、准备事项或原始上下文",
          },
        },
        required: ["title", "start", "end", "allDay", "tag"],
      },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "当日期模糊、时间缺省或内容无法识别时给用户的简短中文提示",
    },
  },
  required: ["events", "warnings"],
};

const COGNITIVE_WEIGHT_SCHEMA = {
  type: "object",
  properties: {
    weights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          score: { type: "integer", minimum: 1, maximum: 5 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["index", "score", "confidence"],
      },
    },
  },
  required: ["weights"],
};

const CAPTURE_SYSTEM_INSTRUCTION = `你是“精力日历（Energy Calendar）”的日程提取助手。你的任务是从用户提供的文字、聊天截图、邮件、课表或语音转写中，准确提取 0 到 ${MAX_CAPTURE_EVENTS} 项结构化日程草稿。

规则要求：
1. 根据给定的参考时间（referenceDate）、时区（timezone / utcOffset）推算相对日期（如“今天”“明天”“下周三”“本周五下午”）。
2. 定时日程（allDay=false）：start 和 end 必须使用包含 utcOffset 的 ISO 8601 格式（例如 2026-11-21T14:00:00+08:00），且 end 必须严格晚于 start。若仅提到开始时刻未提结束时间，默认持续 60 分钟（短暂提醒/打卡默认 30 分钟）；若仅提到“上午/下午/晚上”等模糊时段，结合用户工作时间合理安排，并在 warnings 中提示用户核对。
3. 全天日程（allDay=true）：start 和 end 必须为 YYYY-MM-DD 格式，且 end 为排他边界（单日全天日程 end 必须为 start 的下一天）。
4. tag 只能从以下枚举中选择：${CATEGORIES.map((c) => `${c.id}(${c.label})`).join("、")}。
5. 若输入完全不包含任何可安排的日程或待办时间信息，返回空 events 数组，并在 warnings 中简要说明原因。
6. 严格输出符合指定 JSON Schema 的 JSON，不要添加多余解释。`;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Validates and normalizes an optional custom Gemini API base URL.
 */
export function validateCustomBaseUrl(rawBaseUrl) {
  if (rawBaseUrl === undefined || rawBaseUrl === null) return "";
  if (typeof rawBaseUrl !== "string") {
    throw badRequest("接口地址须为字符串");
  }
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) return "";
  if (trimmed.length > 256) {
    throw badRequest("接口地址不能超过 256 个字符");
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw badRequest("接口地址须为有效的 HTTPS 地址（或本机 HTTP 地址）");
  }
  const isLoopbackHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !isLoopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw badRequest("接口地址须为有效的 HTTPS 地址（或本机 HTTP 地址），且不能包含账号信息或查询参数");
  }
  return trimmed.replace(/\/+$/, "");
}

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizeMimeType(rawMime, aliases) {
  const base = String(rawMime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return aliases[base] || base;
}

function normalizeMediaInput(
  media,
  { kindLabel, allowedMimes, aliases, maxBytes },
) {
  if (!isPlainObject(media)) {
    throw badRequest(`${kindLabel}参数格式不正确`);
  }
  if (typeof media.data !== "string") {
    throw badRequest(`缺少有效的${kindLabel}数据`);
  }

  let rawData = media.data.trim();
  let embeddedMime = "";
  const dataUrlMatch = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is.exec(rawData);
  if (dataUrlMatch) {
    embeddedMime = dataUrlMatch[1];
    rawData = dataUrlMatch[2];
  }

  const mimeSource =
    typeof media.mimeType === "string" && media.mimeType.trim()
      ? media.mimeType
      : embeddedMime;
  const mimeType = normalizeMimeType(mimeSource, aliases);
  if (!mimeType || !allowedMimes.has(mimeType)) {
    throw badRequest(`不支持的${kindLabel}格式：${mimeType || "未知"}`);
  }

  const cleanBase64 = rawData.replace(/\s+/g, "");
  if (
    !cleanBase64 ||
    cleanBase64.length % 4 !== 0 ||
    !BASE64_RE.test(cleanBase64)
  ) {
    throw badRequest(`${kindLabel} Base64 编码无效`);
  }

  const decoded = Buffer.from(cleanBase64, "base64");
  if (decoded.length === 0) {
    throw badRequest(`${kindLabel}内容不能为空`);
  }
  if (decoded.length > maxBytes) {
    const limitMb = Math.round(maxBytes / (1024 * 1024));
    throw Object.assign(
      new Error(`${kindLabel}体积超过上限（最大 ${limitMb} MB）`),
      { status: 413 },
    );
  }

  return { data: cleanBase64, mimeType };
}

function stripJsonFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeCaptureOptions(payload, userSettings, now) {
  let text = "";
  if (payload.text !== undefined && payload.text !== null) {
    if (typeof payload.text !== "string") {
      throw badRequest("text 参数必须为字符串");
    }
    text = payload.text.trim();
    if (text.length > MAX_TEXT_LENGTH) {
      throw badRequest(`输入文本不能超过 ${MAX_TEXT_LENGTH} 字`);
    }
  }

  const image =
    payload.image !== undefined && payload.image !== null
      ? normalizeMediaInput(payload.image, {
          kindLabel: "图片",
          allowedMimes: ALLOWED_IMAGE_MIMES,
          aliases: IMAGE_MIME_ALIASES,
          maxBytes: MAX_IMAGE_BYTES,
        })
      : null;

  const audio =
    payload.audio !== undefined && payload.audio !== null
      ? normalizeMediaInput(payload.audio, {
          kindLabel: "语音",
          allowedMimes: ALLOWED_AUDIO_MIMES,
          aliases: AUDIO_MIME_ALIASES,
          maxBytes: MAX_AUDIO_BYTES,
        })
      : null;

  if (!text && !image && !audio) {
    throw badRequest("请至少提供文字、图片或语音之一");
  }

  let referenceDate = new Date(now()).toISOString();
  if (payload.referenceDate !== undefined && payload.referenceDate !== null) {
    if (typeof payload.referenceDate !== "string" || !payload.referenceDate.trim()) {
      throw badRequest("referenceDate 格式无效");
    }
    const parsedRef = new Date(payload.referenceDate.trim());
    if (!Number.isFinite(+parsedRef)) {
      throw badRequest("referenceDate 无法解析为有效日期");
    }
    referenceDate = payload.referenceDate.trim();
  }

  let timezone = "Asia/Shanghai";
  if (payload.timezone !== undefined && payload.timezone !== null) {
    if (
      typeof payload.timezone !== "string" ||
      !payload.timezone.trim() ||
      payload.timezone.trim().length > 64
    ) {
      throw badRequest("timezone 参数无效");
    }
    timezone = payload.timezone.trim();
  }

  let utcOffset = "+08:00";
  if (payload.utcOffset !== undefined && payload.utcOffset !== null) {
    if (
      typeof payload.utcOffset !== "string" ||
      !UTC_OFFSET_RE.test(payload.utcOffset.trim())
    ) {
      throw badRequest("utcOffset 须为 ±HH:MM 格式");
    }
    utcOffset = payload.utcOffset.trim();
  }

  const defaultWorkStart =
    typeof userSettings?.workStart === "string" && HHMM.test(userSettings.workStart)
      ? userSettings.workStart
      : "08:00";
  const defaultWorkEnd =
    typeof userSettings?.workEnd === "string" &&
    (HHMM.test(userSettings.workEnd) || userSettings.workEnd === "24:00")
      ? userSettings.workEnd
      : "22:00";

  let workStart = defaultWorkStart;
  if (payload.workStart !== undefined && payload.workStart !== null) {
    if (typeof payload.workStart !== "string" || !HHMM.test(payload.workStart)) {
      throw badRequest("workStart 须为 HH:MM 格式");
    }
    workStart = payload.workStart;
  }

  let workEnd = defaultWorkEnd;
  if (payload.workEnd !== undefined && payload.workEnd !== null) {
    if (
      typeof payload.workEnd !== "string" ||
      (!HHMM.test(payload.workEnd) && payload.workEnd !== "24:00")
    ) {
      throw badRequest("workEnd 须为 HH:MM 或 24:00");
    }
    workEnd = payload.workEnd;
  }

  let languageCodes = [];
  if (payload.languageCodes !== undefined && payload.languageCodes !== null) {
    if (!Array.isArray(payload.languageCodes) || payload.languageCodes.length > 5) {
      throw badRequest("languageCodes 须为最多 5 项的语言代码数组");
    }
    languageCodes = payload.languageCodes.map((code) => {
      if (typeof code !== "string" || !code.trim() || code.trim().length > 20) {
        throw badRequest("languageCodes 包含无效语言代码");
      }
      return code.trim();
    });
  }

  return {
    text,
    image,
    audio,
    referenceDate,
    timezone,
    utcOffset,
    workStart,
    workEnd,
    languageCodes,
  };
}

function buildCapturePrompt({
  referenceDate,
  timezone,
  utcOffset,
  workStart,
  workEnd,
  text,
  transcript,
  hasImage,
  useInlineAudio,
}) {
  const sections = [
    `参考时间（referenceDate）：${referenceDate}`,
    `用户时区：${timezone}（UTC 偏移：${utcOffset}）`,
    `常用工作时段：${workStart} - ${workEnd}`,
  ];
  if (text) sections.push(`用户输入文本：\n${text}`);
  if (transcript) sections.push(`语音转写文本：\n${transcript}`);
  if (useInlineAudio) {
    sections.push("同时请先在 transcript 字段转写附带语音内容，再结合全部上下文提取日程。");
  }
  if (hasImage) {
    sections.push("同时请结合附带图片中的时间、事项、会议或课表信息进行提取。");
  }
  return sections.join("\n\n");
}

function normalizeDraftEvents(parsed) {
  const rawEvents = Array.isArray(parsed?.events)
    ? parsed.events.slice(0, MAX_CAPTURE_EVENTS)
    : [];
  const warnings = Array.isArray(parsed?.warnings)
    ? parsed.warnings
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim())
    : [];

  const drafts = [];
  for (const raw of rawEvents) {
    if (!isPlainObject(raw)) {
      warnings.push("已跳过一条格式异常的日程草稿");
      continue;
    }
    const allDay = raw.allDay === true;
    let end = raw.end;
    if (
      allDay &&
      typeof raw.start === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(raw.start) &&
      raw.start === raw.end &&
      dateKey(localDate(raw.start)) === raw.start
    ) {
      end = dateKey(addDays(localDate(raw.start), 1));
    }
    try {
      drafts.push(
        normalizeEvent({
          title: raw.title,
          start: raw.start,
          end,
          allDay,
          tag: raw.tag,
          description:
            typeof raw.description === "string" ? raw.description : "",
          completed: false,
        }),
      );
    } catch (error) {
      warnings.push(`已跳过无效日程草稿：${error.message}`);
    }
  }

  return { drafts, warnings };
}

function resolveScoreTargets(payload, calendar) {
  const dedupe = (items) => {
    const seen = new Set();
    const result = [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
    return result;
  };

  if (payload.events !== undefined) {
    if (!Array.isArray(payload.events) || payload.events.length === 0) {
      throw badRequest("请提供至少 1 项日程");
    }
    if (payload.events.length > MAX_WEIGHT_BATCH) {
      throw badRequest(`单次最多评估 ${MAX_WEIGHT_BATCH} 项日程`);
    }
    const sanitized = payload.events.map((raw) => {
      if (!isPlainObject(raw)) throw badRequest("日程数据格式不正确");
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!id || id.length > 120) throw badRequest("日程编号无效");
      const title = typeof raw.title === "string" ? raw.title.trim() : "";
      if (!title || title.length > 200) throw badRequest("日程名称无效");
      return {
        id,
        title,
        tag: CATEGORIES.some((c) => c.id === raw.tag) ? raw.tag : "other",
        description:
          typeof raw.description === "string" ? raw.description.trim() : "",
        allDay: raw.allDay === true,
        start: raw.start,
        end: raw.end,
      };
    });
    return dedupe(sanitized);
  }

  if (payload.eventIds !== undefined) {
    if (!Array.isArray(payload.eventIds) || payload.eventIds.length === 0) {
      throw badRequest("请提供至少 1 项日程编号");
    }
    if (payload.eventIds.length > MAX_WEIGHT_BATCH) {
      throw badRequest(`单次最多评估 ${MAX_WEIGHT_BATCH} 项日程`);
    }
    const ids = [];
    const seenIds = new Set();
    for (const rawId of payload.eventIds) {
      if (typeof rawId !== "string" || !rawId.trim() || rawId.trim().length > 120) {
        throw badRequest("eventIds 包含无效的日程编号");
      }
      const id = rawId.trim();
      if (!seenIds.has(id)) {
        seenIds.add(id);
        ids.push(id);
      }
    }
    const byId = new Map(calendar.list().map((event) => [String(event.id), event]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  throw badRequest("请提供 events 或 eventIds 参数");
}

function formatDurationLabel(event) {
  if (event.allDay) return "全天事项";
  const minutes = eventDurationMinutes(event);
  if (minutes === null) return "未指定时长";
  if (minutes >= 60) {
    const hours = (minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1);
    return `${hours}小时（${minutes}分钟）`;
  }
  return `${minutes}分钟`;
}

function buildDecisionPayload(misses) {
  const categoryLabel = (tag) =>
    CATEGORIES.find((c) => c.id === tag)?.label || "其他";
  const criteria = COGNITIVE_LEVELS.map((level) => level.criteria);
  const lines = [
    "Evaluate the cognitive energy load of each calendar event below.",
    "Distinguish brief low-load errands from sustained deep-focus work or high-stakes marathon sessions.",
    "",
  ];
  const questions = {};
  misses.forEach(({ event }, index) => {
    const note = String(event.description || "").trim().slice(0, 500) || "无";
    lines.push(
      `[E${index}] 标题：${event.title} | 分类：${categoryLabel(event.tag)} | 时长：${formatDurationLabel(event)} | 备注：${note}`,
    );
    questions[`e_${index}`] = {
      type: "score",
      instructions: `Rate the cognitive energy demand (0 = lowest/restorative, 4 = highest/marathon deep exertion) of calendar event [E${index}] "${event.title}", considering its title, category, duration, and notes.`,
      criteria,
    };
  });
  return { input: lines.join("\n"), questions };
}

function extractProbabilities(answer) {
  let rawList = null;
  if (Array.isArray(answer?.probabilities) && answer.probabilities.length >= 5) {
    rawList = answer.probabilities.slice(0, 5);
  } else if (
    answer?.probabilities &&
    typeof answer.probabilities === "object"
  ) {
    const candidate = ["0", "1", "2", "3", "4"].map((k) => answer.probabilities[k]);
    if (candidate.some((v) => Number.isFinite(Number(v)))) {
      rawList = candidate;
    }
  }
  if (!rawList) return null;
  const clamped = rawList.map((v) => Math.max(0, Number(v) || 0));
  const sum = clamped.reduce((acc, v) => acc + v, 0);
  if (sum <= 0) return null;
  return clamped.map((v) => Number((v / sum).toFixed(4)));
}

function parseDecisionAnswer(answer, fallbackIndex = 2) {
  if (!answer || typeof answer !== "object") {
    throw Object.assign(new Error("AI 认知负荷评分返回缺失"), { status: 502 });
  }
  let probabilities = extractProbabilities(answer);
  let expectedZeroBased;
  if (probabilities) {
    expectedZeroBased = probabilities.reduce((acc, p, idx) => acc + idx * p, 0);
  } else {
    const numericScore = Number(answer.expected_score ?? answer.score);
    expectedZeroBased = Number.isFinite(numericScore)
      ? Math.min(4, Math.max(0, numericScore))
      : fallbackIndex;
    const nearest = Math.min(4, Math.max(0, Math.round(expectedZeroBased)));
    probabilities = [0, 0, 0, 0, 0];
    probabilities[nearest] = 1;
  }

  const expectedScore = Number(
    Math.min(5, Math.max(1, expectedZeroBased + 1)).toFixed(2),
  );
  const score = Math.min(5, Math.max(1, Math.round(expectedScore)));
  const label = COGNITIVE_LEVELS[score - 1].label;
  const confidence = Number(
    Math.min(1, Math.max(0, Number(answer.confidence) || 0)).toFixed(3),
  );
  return { score, expectedScore, label, confidence, probabilities };
}

function buildInteractionWeightPrompt(misses) {
  const categoryLabel = (tag) =>
    CATEGORIES.find((c) => c.id === tag)?.label || "其他";
  const levelGuide = COGNITIVE_LEVELS.map(
    (level) => `${level.score}（${level.label}）：${level.criteria}`,
  ).join("\n");
  const lines = [
    "请为以下每项日程评估认知耗能等级（1–5 整数）与置信度（0–1）：",
    levelGuide,
    "",
    "待评估日程：",
  ];
  misses.forEach(({ event }, index) => {
    const note = String(event.description || "").trim().slice(0, 500) || "无";
    lines.push(
      `[${index}] 标题：${event.title} | 分类：${categoryLabel(event.tag)} | 时长：${formatDurationLabel(event)} | 备注：${note}`,
    );
  });
  return lines.join("\n");
}

function parseInteractionWeights(rawText, count) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(rawText));
  } catch {
    throw Object.assign(new Error("AI 返回的认知负荷格式无法解析，请重试"), {
      status: 502,
    });
  }
  const byIndex = new Map();
  for (const item of Array.isArray(parsed?.weights) ? parsed.weights : []) {
    const idx = Number(item?.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < count && !byIndex.has(idx)) {
      byIndex.set(idx, item);
    }
  }
  return Array.from({ length: count }, (_, idx) => {
    const item = byIndex.get(idx);
    const rawScore = Number(item?.score);
    const score = Number.isFinite(rawScore)
      ? Math.min(5, Math.max(1, Math.round(rawScore)))
      : 3;
    const rawConf = Number(item?.confidence);
    const confidence = item
      ? Number.isFinite(rawConf)
        ? Number(Math.min(1, Math.max(0, rawConf)).toFixed(3))
        : 0.7
      : 0.5;
    const probabilities = [0, 0, 0, 0, 0];
    probabilities[score - 1] = 1;
    return {
      score,
      expectedScore: Number(score.toFixed(2)),
      label: COGNITIVE_LEVELS[score - 1].label,
      confidence,
      probabilities,
    };
  });
}

function toPublicWeight(record) {
  return {
    id: record.id,
    score: record.score,
    expectedScore: record.expectedScore,
    label: record.label,
    confidence: record.confidence,
    probabilities: record.probabilities,
    model: record.model,
    updatedAt: record.updatedAt,
  };
}

/**
 * Creates the server AI service for multimodal quick-capture and cognitive energy scoring.
 */
export function createAiService({
  apiKey = "",
  baseUrl = DEFAULT_BASE_URL,
  captureModel = DEFAULT_CAPTURE_MODEL,
  transcribeModel = DEFAULT_TRANSCRIBE_MODEL,
  decisionModel = DEFAULT_DECISION_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const defaultClient = createGeminiClient({
    apiKey,
    baseUrl,
    fetchImpl,
    timeoutMs,
  });
  const isInlineAudioMode =
    !transcribeModel ||
    transcribeModel === "inline" ||
    transcribeModel === captureModel;

  const resolveClient = (userConfig) => {
    const mode = userConfig?.mode === "custom" ? "custom" : "shared";
    const customKey = String(userConfig?.apiKey || "").trim();
    const customBaseUrl = String(userConfig?.baseUrl || "").trim();
    if (mode !== "custom") {
      return {
        mode: "shared",
        customKey,
        customBaseUrl,
        client: defaultClient,
      };
    }
    const effectiveBaseUrl = customBaseUrl
      ? validateCustomBaseUrl(customBaseUrl)
      : baseUrl;
    return {
      mode: "custom",
      customKey,
      customBaseUrl,
      client: createGeminiClient({
        apiKey: customKey,
        baseUrl: effectiveBaseUrl,
        fetchImpl,
        timeoutMs,
      }),
    };
  };

  const unconfiguredError = (mode) =>
    Object.assign(
      new Error(
        mode === "custom"
          ? "请先在偏好设置中填写你的 Gemini API Key，或切换为使用默认提供的 API"
          : "服务器未配置 Gemini API Key，AI 功能未启用",
      ),
      { status: 503 },
    );

  const scoreWithInteraction = async (misses, modelName, activeClient) => {
    const response = await activeClient.createInteraction({
      model: modelName,
      systemInstruction:
        "你是精力日历的认知负荷评估助手。请综合日程标题、分类、持续时长与备注，区分短暂琐事（1-2）与连续深度专注或高压攻坚（4-5），严格按 JSON Schema 输出。",
      input: buildInteractionWeightPrompt(misses),
      responseFormat: {
        type: "text",
        mime_type: "application/json",
        schema: COGNITIVE_WEIGHT_SCHEMA,
      },
      generationConfig: {
        thinking_level: "low",
      },
      store: false,
    });
    return parseInteractionWeights(response.text, misses.length);
  };

  return {
    status(userConfig = null) {
      const { client: activeClient } = resolveClient(userConfig);
      return {
        enabled: activeClient.configured,
        capabilities: {
          quickCapture: activeClient.configured,
          voiceTranscribe: activeClient.configured,
          cognitiveWeight: activeClient.configured,
        },
        models: {
          capture: captureModel,
          transcribe: transcribeModel,
          decision: decisionModel,
        },
      };
    },

    getConfigStatus(userConfig = null) {
      const {
        mode,
        customKey,
        customBaseUrl,
        client: activeClient,
      } = resolveClient(userConfig);
      return {
        mode,
        hasCustomKey: Boolean(customKey),
        customKeyMask: customKey ? maskApiKey(customKey) : "",
        customBaseUrl,
        sharedAvailable: defaultClient.configured,
        enabled: activeClient.configured,
        models: {
          capture: captureModel,
          transcribe: transcribeModel,
          decision: decisionModel,
        },
      };
    },

    async quickCapture(payload, { userSettings = {}, userConfig = null } = {}) {
      if (!isPlainObject(payload)) {
        throw badRequest("请求参数须为 JSON 对象");
      }
      const {
        text,
        image,
        audio,
        referenceDate,
        timezone,
        utcOffset,
        workStart,
        workEnd,
        languageCodes,
      } = normalizeCaptureOptions(payload, userSettings, now);

      const { mode, client: activeClient } = resolveClient(userConfig);
      if (!activeClient.configured) {
        throw unconfiguredError(mode);
      }

      let transcript = null;
      let useInlineAudio = isInlineAudioMode;
      let usedTranscribeModel = audio
        ? useInlineAudio
          ? captureModel
          : transcribeModel
        : null;

      if (audio && !useInlineAudio) {
        const transcriptionConfig = {
          mode: "smart",
          ...(languageCodes.length ? { language_codes: languageCodes } : {}),
        };
        try {
          const transcribed = await activeClient.createInteraction({
            model: transcribeModel,
            input: [
              {
                type: "audio",
                data: audio.data,
                mime_type: audio.mimeType,
              },
            ],
            generationConfig: {
              transcription_config: transcriptionConfig,
            },
            store: false,
          });
          transcript = transcribed.text.trim();
          if (!transcript && !text && !image) {
            return {
              transcript: "",
              drafts: [],
              warnings: ["未能从语音中识别出有效文字内容"],
              models: { capture: null, transcribe: transcribeModel },
            };
          }
        } catch (error) {
          if (error?.upstreamStatus === 404 || error?.upstreamStatus === 403) {
            console.warn(
              `语音转写模型 ${transcribeModel} 不可用 (${error.upstreamStatus})，已自动降级为单次 ${captureModel} 语音直传`,
            );
            useInlineAudio = true;
            usedTranscribeModel = captureModel;
          } else {
            throw error;
          }
        }
      }

      const input = [];
      if (image) {
        input.push({
          type: "image",
          data: image.data,
          mime_type: image.mimeType,
        });
      }
      if (audio && useInlineAudio) {
        input.push({
          type: "audio",
          data: audio.data,
          mime_type: audio.mimeType,
        });
      }
      input.push({
        type: "text",
        text: buildCapturePrompt({
          referenceDate,
          timezone,
          utcOffset,
          workStart,
          workEnd,
          text,
          transcript,
          hasImage: Boolean(image),
          useInlineAudio: Boolean(audio && useInlineAudio),
        }),
      });

      const response = await activeClient.createInteraction({
        model: captureModel,
        systemInstruction: CAPTURE_SYSTEM_INSTRUCTION,
        input,
        responseFormat: {
          type: "text",
          mime_type: "application/json",
          schema: QUICK_CAPTURE_SCHEMA,
        },
        generationConfig: {
          thinking_level: "low",
        },
        store: false,
      });

      let parsed;
      try {
        parsed = JSON.parse(stripJsonFence(response.text));
      } catch {
        throw Object.assign(new Error("AI 返回的日程格式无法解析，请重试"), {
          status: 502,
        });
      }

      if (useInlineAudio && typeof parsed?.transcript === "string") {
        transcript = parsed.transcript.trim();
      }

      const { drafts, warnings } = normalizeDraftEvents(parsed);
      return {
        transcript,
        drafts,
        warnings,
        models: {
          capture: captureModel,
          transcribe: usedTranscribeModel,
        },
      };
    },

    async scoreEvents(payload, { calendar, cache, userConfig = null }) {
      if (!isPlainObject(payload)) {
        throw badRequest("请求参数须为 JSON 对象");
      }
      const force = payload.force === true;
      const targets = resolveScoreTargets(payload, calendar);
      if (targets.length === 0) {
        return {
          model: decisionModel,
          weights: [],
          cacheHits: 0,
          evaluated: 0,
        };
      }

      const targetItems = targets.map((event) => ({
        event,
        fingerprint: weightFingerprint(event),
      }));
      const cachedMap = cache.getMany(targetItems.map((item) => item.event.id));

      const resultsById = new Map();
      const misses = [];
      let cacheHits = 0;

      for (const item of targetItems) {
        const hit = cachedMap.get(item.event.id);
        if (!force && hit && hit.fingerprint === item.fingerprint) {
          resultsById.set(item.event.id, toPublicWeight(hit));
          cacheHits++;
        } else {
          misses.push(item);
        }
      }

      let usedModel = decisionModel;
      if (misses.length > 0) {
        const resolvedConfig = userConfig ?? cache?.getConfig?.() ?? null;
        const { mode, client: activeClient } = resolveClient(resolvedConfig);
        if (!activeClient.configured) {
          throw unconfiguredError(mode);
        }
        let parsedScores;
        if (String(decisionModel).startsWith("gemini-decision")) {
          try {
            const { input, questions } = buildDecisionPayload(misses);
            const decisionResponse = await activeClient.createDecision({
              model: decisionModel,
              input,
              questions,
            });
            parsedScores = misses.map((_, idx) =>
              parseDecisionAnswer(decisionResponse?.answers?.[`e_${idx}`]),
            );
          } catch (error) {
            if (error?.upstreamStatus === 404 || error?.upstreamStatus === 403) {
              console.warn(
                `决策模型 ${decisionModel} 不可用 (${error.upstreamStatus})，已自动降级为 ${captureModel}`,
              );
              usedModel = captureModel;
              parsedScores = await scoreWithInteraction(
                misses,
                captureModel,
                activeClient,
              );
            } else {
              throw error;
            }
          }
        } else {
          usedModel = decisionModel;
          parsedScores = await scoreWithInteraction(
            misses,
            decisionModel,
            activeClient,
          );
        }
        const evaluatedAt = now();
        const newRecords = misses.map((item, idx) => ({
          id: item.event.id,
          fingerprint: item.fingerprint,
          ...parsedScores[idx],
          model: usedModel,
          updatedAt: evaluatedAt,
        }));
        cache.putMany(newRecords);
        for (const record of newRecords) {
          resultsById.set(record.id, toPublicWeight(record));
        }
      }

      return {
        model: usedModel,
        weights: targetItems.map((item) => resultsById.get(item.event.id)),
        cacheHits,
        evaluated: misses.length,
      };
    },

    listCachedWeights({ calendar, cache, ids = null }) {
      const allEvents = calendar.list();
      const activeEvents = new Map();
      for (const event of allEvents) {
        const id = String(event.id);
        if (ids && ids.size > 0 && !ids.has(id)) continue;
        activeEvents.set(id, event);
      }
      if (activeEvents.size === 0) {
        return { weights: {} };
      }

      const cachedMap = cache.getMany([...activeEvents.keys()]);
      const weights = {};
      for (const [id, event] of activeEvents) {
        const entry = cachedMap.get(id);
        if (entry && entry.fingerprint === weightFingerprint(event)) {
          weights[id] = toPublicWeight(entry);
        }
      }
      return { weights };
    },
  };
}
