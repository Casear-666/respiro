import { createAiService } from "./ai.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CAPTURE_MODEL,
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_DECISION_MODEL,
  DEFAULT_TIMEOUT_MS,
} from "./gemini.js";

const apiKey = process.env.GEMINI_API_KEY?.trim() || "";
if (!apiKey) {
  console.error(
    [
      "未检测到 GEMINI_API_KEY。",
      "请先前往 Google AI Studio 免费申请 API Key：https://aistudio.google.com/apikey",
      "然后将密钥填入 EC/.env.server 中的 GEMINI_API_KEY= 后面，再重新运行：",
      "  npm run server   或   node --env-file-if-exists=.env.server server/verify-ai.js",
    ].join("\n"),
  );
  process.exit(2);
}

const baseUrl =
  process.env.GEMINI_API_BASE_URL?.trim()?.replace(/\/+$/, "") ||
  DEFAULT_BASE_URL;
const captureModel =
  process.env.GEMINI_CAPTURE_MODEL?.trim() || DEFAULT_CAPTURE_MODEL;
const transcribeModel =
  process.env.GEMINI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL;
const decisionModel =
  process.env.GEMINI_DECISION_MODEL?.trim() || DEFAULT_DECISION_MODEL;
const parsedTimeout = Number(process.env.GEMINI_TIMEOUT_MS?.trim());
const timeoutMs =
  Number.isInteger(parsedTimeout) && parsedTimeout >= 5000
    ? parsedTimeout
    : DEFAULT_TIMEOUT_MS;

const ai = createAiService({
  apiKey,
  baseUrl,
  captureModel,
  transcribeModel,
  decisionModel,
  timeoutMs,
});

const memoryCache = {
  getMany: () => new Map(),
  putMany: () => {},
};
const emptyCalendar = {
  list: () => [],
};

try {
  console.log("1/2 正在验证多模态快建接口（Quick-Capture）...");
  const capture = await ai.quickCapture({
    text: "明天下午3点到4点半在二楼开需求评审",
  });
  console.log(
    JSON.stringify(
      {
        models: capture.models,
        drafts: capture.drafts,
        warnings: capture.warnings,
      },
      null,
      2,
    ),
  );

  console.log("\n2/2 正在验证认知耗能评分接口（Cognitive Weight）...");
  const today = new Date().toISOString().slice(0, 10);
  const weights = await ai.scoreEvents(
    {
      events: [
        {
          id: "smoke-deep",
          title: "8小时架构重构攻坚",
          start: `${today}T09:00:00+08:00`,
          end: `${today}T17:00:00+08:00`,
          allDay: false,
          tag: "work",
          description: "核心引擎重写与性能压测",
        },
        {
          id: "smoke-errand",
          title: "楼下取快递",
          start: `${today}T17:10:00+08:00`,
          end: `${today}T17:15:00+08:00`,
          allDay: false,
          tag: "personal",
          description: "",
        },
      ],
    },
    { calendar: emptyCalendar, cache: memoryCache },
  );
  console.log(JSON.stringify(weights, null, 2));
  console.log("\nGemini 免费层连通性验证通过。");
} catch (error) {
  console.error(`验证失败 (${error?.status || "ERR"})：${error?.message || error}`);
  process.exit(1);
}
