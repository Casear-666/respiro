# 精力日历 AI 后端接口契约（Web 服务端）

本文档供前端开发直接对接服务端 Gemini API 能力。所有新增能力均部署在 `EC/server/`，采用 **方案 A（按账号隔离的独立 SQLite 缓存）**，不改动现有 `shared/domain.js` 事件结构与同步协议。

---

## 1. 安全与公共约定

- **鉴权**：所有 `/api/ai/*` 接口均需要有效的登录 Cookie（`calendar_session`），未登录返回 `401 { error: "需要登录" }`。
- **写接口 CSRF 校验**：`POST` 接口与现有 `/api/sync/*` 一致，必须携带：
  - `Content-Type: application/json`
  - `X-Calendar-Request: 1`
  - 同源 Cookie（`credentials: "same-origin"`）
- **错误响应格式**：`{ "error": "中文错误提示" }`
  - `400`：参数格式错误或超限
  - `401`：未登录
  - `403`：缺少 `X-Calendar-Request: 1` 或跨站 Origin
  - `413`：图片/语音或请求体过大
  - `429`：请求过于频繁（单账号默认 15 次/分钟，或上游配额受限；含 `Retry-After` 头）
  - `502` / `504`：上游 Gemini 服务异常或响应超时
  - `503`：服务端未配置 `GEMINI_API_KEY`（前端据此优雅降级）

---

## 1.5 免费层快速接入（Gemini 3.8 Flash）

服务端默认针对 **Gemini Free Tier** 做了即开即用适配：
1. 在 Google AI Studio 免费申请 Key（`https://aistudio.google.com/apikey`），填入已预先生成且被 `.gitignore` 忽略的 `EC/.env.server`：
   ```ini
   GEMINI_API_KEY=你的免费层_API_Key
   ```
2. 默认模型为 **`gemini-3.8-flash`**（支持免费层标准调用、文本/截图/语音多模态及结构化 JSON 输出）；语音转写与决策评分分别默认使用 `gemini-3.5-transcribe` / `gemini-decision-1`，若遇到免费层/代理端点返回 `403` 或 `404`，后端会自动降级到单次 `gemini-3.8-flash` 完成，前端无需改动。
3. 如需最大化节省免费层 RPM 配额，可在 `.env.server` 中显式配置纯单模型模式（`GEMINI_TRANSCRIBE_MODEL=gemini-3.8-flash`、`GEMINI_DECISION_MODEL=gemini-3.8-flash`）。
4. 运行单命令真实连通性冒烟（不落盘任何日程数据）：
   ```bash
   node --env-file-if-exists=.env.server server/verify-ai.js
   ```

---

## 2. 接口清单

### 2.1 查询 AI 状态：`GET /api/ai/status`

页面启动或打开 `Ctrl+K` / 偏好设置前调用，决定是否亮起 AI 入口。

**响应 `200`：**
```json
{
  "enabled": true,
  "capabilities": {
    "quickCapture": true,
    "voiceTranscribe": true,
    "cognitiveWeight": true
  },
  "models": {
    "capture": "gemini-3.8-flash",
    "transcribe": "gemini-3.5-transcribe",
    "decision": "gemini-decision-1"
  }
}
```
> 另：`GET /api/info` 也额外附带了 `"aiEnabled": boolean`，可用于早期探测。

---

### 2.2 多模态快建日程：`POST /api/ai/quick-capture`

支持 **文字 / 粘贴截图 / 语音** 单独或组合输入：
- 若含 `audio`：默认先调用 `gemini-3.5-transcribe`（smart 模式）转写文本，再将转写文本与文字/图片一起交给 `gemini-3.8-flash` 输出严格符合 `normalizeEvent()` 的日程草稿（若配置了单模型模式或遇到 `403`/`404`，则自动合并为单次 `gemini-3.8-flash` 语音直传解析）。
- **注意**：后端不会直接把草稿写入数据库，而是返回给前端让用户在弹窗内确认、编辑后走现有的 `apply({ upserts })`（保留 30 步撤销与热力预览）。

**请求体：**（`text`、`image`、`audio` 至少提供一项；上限 `16 MB`）
```json
{
  "text": "明天下午3点和设计碰头，后天上午提交周报",
  "image": {
    "data": "data:image/png;base64,iVBORw0KGgo...",
    "mimeType": "image/png"
  },
  "audio": {
    "data": "GkXfo59ChoEB...",
    "mimeType": "audio/webm;codecs=opus"
  },
  "referenceDate": "2026-11-20T13:30:00+08:00",
  "timezone": "Asia/Shanghai",
  "utcOffset": "+08:00",
  "workStart": "08:00",
  "workEnd": "22:00",
  "languageCodes": ["cmn-Hans-CN"]
}
```
- `image.data` / `audio.data`：支持纯 Base64 或完整 `data:...;base64,...` Data URL（单张图片 ≤ `10 MB`，音频 ≤ `12 MB`）。
- `audio.mimeType`：浏览器 `MediaRecorder` 常见的 `audio/webm;codecs=opus` 等带分号参数的值会被后端自动清洗为 `audio/webm`。
- `referenceDate` / `timezone` / `utcOffset` / `workStart` / `workEnd` / `languageCodes` 均为可选，缺省按用户设置及 `+08:00` 处理。

**响应 `200`：**
```json
{
  "transcript": "周五早上九点半和设计师碰头一小时",
  "drafts": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "title": "和设计师碰头",
      "start": "2026-11-27T09:30:00+08:00",
      "end": "2026-11-27T10:30:00+08:00",
      "allDay": false,
      "description": "",
      "tag": "meeting",
      "completed": false
    }
  ],
  "warnings": [
    "已按常用工作时段推定时间，请确认后保存。"
  ],
  "models": {
    "capture": "gemini-3.8-flash",
    "transcribe": "gemini-3.5-transcribe"
  }
}
```

---

### 2.3 批量计算认知耗能评分：`POST /api/ai/cognitive-weight`

通过 Gemini Decisions API（`v1beta/decisions`，模型 `gemini-decision-1`）单次批量评估 1–50 项日程的认知耗能（1–5 档），自动命中并写入当前账号独立的 `ai-cache.sqlite`。

**请求体（二选一）：**
```json
{
  "eventIds": ["id-1", "id-2"],
  "force": false
}
```
或直接传入未入库/前端当前的事件摘要对象（例如刚创建保存后立刻评估）：
```json
{
  "events": [
    {
      "id": "deep-8h",
      "title": "8小时架构重构攻坚",
      "start": "2026-11-20T09:00:00+08:00",
      "end": "2026-11-20T17:00:00+08:00",
      "allDay": false,
      "tag": "work",
      "description": "核心引擎重写"
    }
  ],
  "force": false
}
```
> 缓存指纹基于 `(title, tag, description, allDay, durationMinutes)` 计算：仅拖动日程改期不改时长和内容时**直接命中缓存**，不重复消耗额度；修改标题、备注、标签或时长时自动失效重算。

**响应 `200`：**
```json
{
  "model": "gemini-decision-1",
  "cacheHits": 1,
  "evaluated": 1,
  "weights": [
    {
      "id": "deep-8h",
      "score": 5,
      "expectedScore": 4.51,
      "label": "高压攻坚",
      "confidence": 0.91,
      "probabilities": [0.01, 0.02, 0.07, 0.25, 0.65],
      "model": "gemini-decision-1",
      "updatedAt": 1795150000000
    }
  ]
}
```

5 个认知负荷等级对应关系：

| `score` | `label` | 典型场景 |
| --- | --- | --- |
| `1` | 恢复放松 | 休息、散步、午休、咖啡、轻松聚会 |
| `2` | 轻量事务 | 5–30 分钟取快递、打卡、简短同步 |
| `3` | 常规协作 | 例会、一般沟通、日常推进 |
| `4` | 深度专注 | 编码、写作、方案设计、备考学习（1.5–4h） |
| `5` | 高压攻坚 | 关键汇报、高风险截止日、4 小时以上连续攻坚 |

---

### 2.4 读取当前有效缓存评分：`GET /api/ai/weights`

页面初始化或同步刷新后拉取已有缓存评分（不触发 AI 调用，即使服务端未配置 Key 也会安全返回已缓存记录；已删除或内容/时长已变的旧缓存会自动过滤）。

- 可选查询参数：`?ids=id1,id2`（仅返回指定日程的缓存）。

**响应 `200`：**
```json
{
  "weights": {
    "deep-8h": {
      "id": "deep-8h",
      "score": 5,
      "expectedScore": 4.51,
      "label": "高压攻坚",
      "confidence": 0.91,
      "probabilities": [0.01, 0.02, 0.07, 0.25, 0.65],
      "model": "gemini-decision-1",
      "updatedAt": 1795150000000
    }
  }
}
```

---

## 3. 前端对接建议（`serverRepository.js` 扩展示例）

前端在 `EC/src/planner/serverRepository.js` 中只需补充 4 个方法（注意：**图片/语音请求可能耗时 10–40 秒，建议为 `aiQuickCapture` 单独放宽超时到 `60000ms`**）：

```js
// 在 createServerRepository 内部：
aiStatus: () => request("/api/ai/status"),

aiWeights: (ids) => {
  const query = Array.isArray(ids) && ids.length
    ? `?ids=${encodeURIComponent(ids.join(","))}`
    : "";
  return request(`/api/ai/weights${query}`);
},

aiQuickCapture: (payload) =>
  request("/api/ai/quick-capture", {
    method: "POST",
    body: JSON.stringify(payload),
    // 如需避免 20s 超时，可为 request 支持覆盖 timeoutMs: 65000
  }),

aiCognitiveWeight: (payload) =>
  request("/api/ai/cognitive-weight", {
    method: "POST",
    body: JSON.stringify(payload),
  }),
```

### UI 展示建议（不破坏现有纸感界面）

1. **未启用态自动隐身**：进入网页后调用 `aiStatus()`，当 `enabled === false`（或非服务端/本地预览环境无此方法）时，隐藏或弱化 AI 按钮，主日历功能 100% 保持离线可用。
2. **多模态快建 → 挂在 `Ctrl+K` 搜索/快建浮层中**：
   - 在输入框支持 `onPaste` 捕获剪贴板图片（`FileReader.readAsDataURL`），下方显示小缩略图并支持一键清除；
   - 右侧提供麦克风按钮，使用浏览器 `MediaRecorder` 录制后转为 Base64 调用 `aiQuickCapture`；
   - 返回后若 `transcript` 非空先展示转写句，下面列出 `drafts` 勾选确认卡片（可点进编辑器微调），确认后统一调用 `apply({ upserts })`，天然保留 `Ctrl+Z` 撤销能力。
3. **认知耗能权重 → 异步静默叠加**：
   - 登录后并行拉取一次 `aiWeights()` 存为前端 `Map<eventId, weight>`；
   - 新建/编辑保存日程后在后台静默调用 `aiCognitiveWeight({ events: [savedEvent] })` 更新 `Map`（绝不阻塞用户保存操作）；
   - 在事件编辑弹窗、悬停预览 `DayPreview` 或周/日视图卡片角标处展示 `score`（1–5 档与 `label`）；
   - 可在顶部或右侧当日摘要增加「按认知负荷着色」切换开关，将 `score` 与时长纳入负荷视图权重，直观区分「8 小时深度攻坚」与「5 件 5 分钟小事」。
