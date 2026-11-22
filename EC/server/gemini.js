/**
 * Zero-dependency Gemini REST client using Node 24's built-in fetch.
 * Uses the Interactions API (POST /v1/interactions) and Decisions API (POST /v1beta/decisions).
 */

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
export const DEFAULT_CAPTURE_MODEL = "gemini-3.8-flash";
export const DEFAULT_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
export const DEFAULT_DECISION_MODEL = "gemini-decision-1";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const API_REVISION = "2026-05-20";

const CONTENT_TYPES = new Set(["text", "image", "audio", "document", "video"]);

function normalizeInteractionInput(input) {
  if (typeof input === "string") {
    return [{ type: "user_input", content: [{ type: "text", text: input }] }];
  }
  if (
    Array.isArray(input) &&
    input.length > 0 &&
    CONTENT_TYPES.has(input[0]?.type)
  ) {
    return [{ type: "user_input", content: input }];
  }
  return input;
}

function collectStepText(steps) {
  return steps
    .flatMap((step) => (Array.isArray(step?.content) ? step.content : []))
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

/**
 * Extracts trailing text output from a Gemini Interactions response.
 */
export function extractInteractionText(interaction) {
  if (
    interaction?.status === "failed" ||
    interaction?.status === "cancelled"
  ) {
    throw Object.assign(new Error("AI 生成任务未能完成，请稍后重试"), {
      status: 502,
    });
  }
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  const trailingModelSteps = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.type === "model_output") {
      trailingModelSteps.unshift(steps[i]);
    } else if (trailingModelSteps.length > 0) {
      break;
    }
  }
  const trailingText = collectStepText(trailingModelSteps);
  if (trailingText) return trailingText;

  const allModelText = collectStepText(
    steps.filter((step) => step?.type === "model_output"),
  );
  if (allModelText) return allModelText;

  return typeof interaction?.output_text === "string"
    ? interaction.output_text
    : "";
}

function redactSecret(text, secret) {
  const raw = String(text || "");
  return secret ? raw.split(secret).join("[REDACTED]") : raw;
}

function extractUpstreamErrorMessage(rawText, secret) {
  let message = rawText;
  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed?.error?.message === "string") {
      message = parsed.error.message;
    } else if (typeof parsed?.message === "string") {
      message = parsed.message;
    }
  } catch {
    /* keep raw text */
  }
  return redactSecret(message, secret).slice(0, 300);
}

/**
 * Creates a Gemini REST client bound to an optional API key and fetch implementation.
 */
export function createGeminiClient({
  apiKey = "",
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const cleanKey = String(apiKey || "").trim();
  const cleanBaseUrl = String(baseUrl || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const effectiveTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : DEFAULT_TIMEOUT_MS;

  const postJson = async (
    endpointPath,
    payload,
    { includeApiRevision = false } = {},
  ) => {
    if (!cleanKey) {
      throw Object.assign(
        new Error("服务器未配置 Gemini API Key，AI 功能未启用"),
        { status: 503 },
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${cleanBaseUrl}${endpointPath}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": cleanKey,
          ...(includeApiRevision ? { "Api-Revision": API_REVISION } : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        throw Object.assign(new Error("AI 服务响应超时，请稍后重试"), {
          status: 504,
        });
      }
      if (error instanceof TypeError) {
        throw Object.assign(
          new Error("暂时无法连接 Gemini 服务，请检查网络或代理配置"),
          { status: 502 },
        );
      }
      if (error?.status) throw error;
      throw Object.assign(
        new Error("暂时无法连接 Gemini 服务，请检查网络或代理配置"),
        { status: 502 },
      );
    } finally {
      clearTimeout(timer);
    }

    const rawText = await response.text();
    if (!response.ok) {
      const detail = extractUpstreamErrorMessage(rawText, cleanKey);
      console.warn(
        `Gemini API 请求失败 (${response.status} ${endpointPath})：${detail}`,
      );
      if (response.status === 429) {
        const retryAfter = response.headers?.get?.("retry-after")?.trim();
        throw Object.assign(
          new Error("AI 调用频率已达上限，请稍后再试"),
          {
            status: 429,
            upstreamStatus: response.status,
            ...(retryAfter ? { retryAfter } : {}),
          },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(
          new Error("服务端 Gemini API Key 无效或无权限"),
          { status: 502, upstreamStatus: response.status },
        );
      }
      throw Object.assign(
        new Error("AI 服务返回异常，请稍后重试"),
        { status: 502, upstreamStatus: response.status },
      );
    }

    try {
      return JSON.parse(rawText);
    } catch {
      throw Object.assign(
        new Error("AI 服务返回了无法解析的响应"),
        { status: 502 },
      );
    }
  };

  return {
    configured: Boolean(cleanKey),
    async createInteraction({
      model,
      input,
      systemInstruction,
      responseFormat,
      generationConfig,
      store = false,
    }) {
      const payload = {
        model,
        input: normalizeInteractionInput(input),
        store,
        ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(generationConfig ? { generation_config: generationConfig } : {}),
      };
      const raw = await postJson("/v1/interactions", payload, {
        includeApiRevision: true,
      });
      return {
        raw,
        text: extractInteractionText(raw),
        usage: raw?.usage ?? null,
      };
    },
    async createDecision({
      model = DEFAULT_DECISION_MODEL,
      input,
      questions,
    }) {
      return postJson("/v1beta/decisions", {
        model,
        input,
        questions,
      });
    },
  };
}
