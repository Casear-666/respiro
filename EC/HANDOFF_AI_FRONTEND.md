# 精力日历（Energy Calendar）AI 双功能与前端交互交接文档

**交付日期**：2026-11-20  
**对接契约**：[`EC/AI_API_CONTRACT.md`](./AI_API_CONTRACT.md)  
**背景依据**：[`市场化分析-2026-10-20.md`](../%E5%B8%82%E5%9C%BA%E5%8C%96%E5%88%86%E6%9E%90-2026-10-20.md)

---

## 1. 交付概览与已完成能力

本次交付完成了后端 Gemini AI 双能力的前端人机交互落地、认知耗能视觉系统统一，以及全视图右键直接删除事件功能：

1. **功能 1：多模态快建日程（Multimodal Quick-Capture）**
   - **三重唤起入口**：
     - 顶部栏 **「AI 快建」** 按钮（仅在 `aiStatus.enabled === true` 时显示）；
     - `Ctrl+K` / `/` 搜索与命令面板内集成图片上传、拖拽、粘贴与语音录制；
     - 主界面非输入态直接按 `Ctrl+V` 粘贴剪贴板截图（≤ 10 MB），自动弹出面板并加载截图。
   - **多模态输入与可取消请求**：支持文字、截图（Base64 Data URL）、语音（`MediaRecorder`，最长 120s，≤ 12 MB）单独或组合提交，请求超时放宽至 `65000ms` 且支持 `AbortController` 随时取消。
   - **人在回路确认与单步撤销**：解析结果以可编辑草稿卡片呈现（勾选、5 类标签切换、标题、全天开关、起止时间、备注），内置基于现有未完成定时日程的实时时间重叠预警；确认后通过 `saveEventsBatch` 单步事务落库，按一次 `Ctrl+Z` 即可整批撤销，并自动跳转闪烁高亮首条新日程。

2. **功能 2：认知耗能评分与双视角热力体系（Cognitive Energy Weighting）**
   - **异步静默生命周期**：登录后并行拉取 `/api/ai/status` 与 `/api/ai/weights`，对未评分日程以 `450ms` 防抖按最多 50 项分批静默补齐；新建/批量保存或修改内容后后台自动重评，纯拖拽改期不触发多余调用。
   - **解决「5 个 5 分钟琐事 > 1 个 8 小时攻坚」痛点**：在 [`shared/domain.js`](./shared/domain.js) 新增 `eventCognitiveUnits` 与 `dayLoad` / `rangeLoads` 双视角扩展，将 `COGNITIVE_LEVELS` 等级权重与持续时长因子结合；右侧 `TodayPanel` 提供 **「认知精力」 / 「事项密度」** 切换开关与可解释归因摘要（`cognitiveSummary`）。
   - **顺滑冷暖渐变视觉体系**：全站统一 1–5 档双主题语义配色（柔和鼠尾草青 → 中性雾灰 → 潮汐蓝 → 深海靛 → 低饱和赤陶），贯穿右侧列表、月/周画布、悬停预览、昼夜表盘与编辑器；`EventEditor` 支持展示 AI 来源与置信度、手动点选 1–5 档覆写及点击「重新评估」（`force: true`）。

3. **功能 3：全视图右键直接删除事件**
   - **统一秒删 + 一键撤销**：在周视图色块（`.fc-event`）、月视图/小月历悬停预览（`.day-preview-item`）、日视图昼夜表盘（弧段 `.dial-arc` 与列表项 `.dial-entry`）、右侧当日面板（`.agenda-item`）及独立表盘示例页均支持右击日程直接删除，底部 Toast 自动提供「撤销」恢复入口；在月视图右击日期格子时，除了「在此新建日程 / 粘贴到这一天」，若当日存在日程还会在右键菜单内展示逐条删除项（`.context-menu-event-delete`）及「删除当日全部日程（N 项）」（`.context-menu-delete-all`），支持单条与整日批量删除及单步撤销；右击空白日期格子依然仅弹出「在此新建日程 / 粘贴到这一天」上下文菜单。

---

## 2. 文件改动地图与职责

| 模块 | 文件路径 | 核心变更 |
| --- | --- | --- |
| API 通信 | [`EC/src/planner/serverRepository.js`](./src/planner/serverRepository.js) | `request()` 支持单次 `timeout` 覆盖与外部 `AbortSignal`；新增 `aiStatus`、`aiWeights`、`aiQuickCapture`（65s）、`aiCognitiveWeight`（35s） |
| 领域算法 | [`EC/shared/domain.js`](./shared/domain.js) | 导出 `COGNITIVE_LEVELS`、`cognitiveLevelOf`、`eventCognitiveInfo`、`eventCognitiveUnits`；扩展 `dayLoad` / `rangeLoads` 支持 `{ weightsMap, energyMode }` 及 `cognitiveUnits`、`effectiveCount`、`cognitiveSummary` |
| 状态管理 | [`EC/src/planner/usePlanner.js`](./src/planner/usePlanner.js) | 管理 `aiStatus`、`aiWeights`（服务端缓存 + `localStorage` 手动覆写）、`aiScoringIds`；新增 `saveEventsBatch`、`setCognitiveOverride`、`rescoreEvent`、`quickCapture` 与后台防抖补齐；扩展 `deleteEvent(idOrIds)` 支持单条与批量删除及一键撤销 |
| 多模态面板 | [`EC/src/planner/SearchPalette.jsx`](./src/planner/SearchPalette.jsx) | 从 `PlannerApp.jsx` 拆出的 `SearchDialog`：搜索命令、图片粘贴/拖拽/上传、`MediaRecorder` 录音、加载取消态、行内草稿微调与实时冲突检测 |
| 主界面 | [`EC/src/planner/PlannerApp.jsx`](./src/planner/PlannerApp.jsx) | 接入 `energyMode` 持久化与 `TodayPanel` 视角切换、`Ctrl+V` 全局截图唤起、顶栏 `AI 快建` 入口、`TodayPanel` 右键删除与认知微章；增强并导出 `ContextMenu` 支持月视图日期格右键菜单内单条/当日全部日程删除 |
| 画布与预览 | [`EC/src/planner/CalendarCanvas.jsx`](./src/planner/CalendarCanvas.jsx) | 接入 `aiWeights` / `energyMode` 热力渲染与周视图认知角标；FullCalendar `eventDidMount` 绑定优先 `onDelete` 右键直删；`openSlotMenu` 附带当日日程列表并关闭悬停预览；透传 `onDelete` 与稳定 `DialContext` |
| 悬停卡片 | [`EC/src/planner/DayPreview.jsx`](./src/planner/DayPreview.jsx) | 接入认知视角热度、摘要与高耗能角标；列表项 `.day-preview-item` 绑定 `onContextMenu` 直接调用 `onDelete(event.id)` |
| 昼夜表盘 | [`EC/src/planner/DayDial.jsx`](./src/planner/DayDial.jsx) | 通过 `globalThis.__EC_DIAL_CONTEXT__` + `__EC_DIAL_STATE__` 保持 HMR 上下文一致；渐变 ID 按 `event.id` 稳定生成；表盘弧段与右侧列表均支持右键秒删与中心认知标签展示 |
| 事件编辑器 | [`EC/src/planner/EventEditor.jsx`](./src/planner/EventEditor.jsx) | 新增「认知耗能」1–5 档选择器、来源与置信度展示、手动覆写/恢复自动、编辑态点击「重新评估」 |
| 表盘示例 | [`EC/examples/dial-demo.jsx`](./examples/dial-demo.jsx) | 为 `DialContext.Provider` 补充 `onDelete` 回调 |
| 样式表 | [`EC/src/planner/planner.css`](./src/planner/planner.css) | 新增亮/暗双主题 `--cog-1-*` ~ `--cog-5-*` 语义变量、多模态输入/录音/草稿确认视图样式、视角切换胶囊、编辑器认知控件及右键菜单日程删除列表样式 |
| 单元测试 | [`EC/tests/native/server-repository.test.js`](./tests/native/server-repository.test.js)<br>[`EC/tests/native/domain.test.js`](./tests/native/domain.test.js)<br>[`EC/tests/native/calendar-rendering.test.js`](./tests/native/calendar-rendering.test.js) | 覆盖 AI 接口请求头/超时/取消、认知加权对比（8h 攻坚 vs 5×5min 琐事）、全视图（周色块/月预览/昼夜表盘）右键直接删除、月视图日期格右键菜单内单条/批量删除与表盘时长重算 |

---

## 3. 关键契约与防坑约束（后续开发必读）

1. **前端本地状态不要写入后端 `settings`**：
   - `energyMode` 存储在 `localStorage["energy-calendar-ui"]`；
   - 手动认知评分覆写存储在 `localStorage["energy-calendar-weight-overrides-v1"]`；
   - 切勿把这两个字段并入 `model.updateSettings()`，否则服务端 [`EC/server/app.js`](./server/app.js) 的 `SETTING_RULES` 白名单校验会返回 `400 包含未知的偏好设置项`。
2. **既有渲染与测试契约不可破坏**：
   - [`CalendarCanvas.jsx`](./src/planner/CalendarCanvas.jsx) 的日格 `element.dataset.busyCount` 必须始终保持为实际未完成日程数 `String(load.count)`（热力着色单独使用 `effectiveCount`），不可用负荷分值覆盖 `busyCount`；
   - [`DayDial.jsx`](./src/planner/DayDial.jsx) 未悬停状态下的 `.dial-center strong` 文本格式必须保持 `"X时Y分"`；
   - `shared/energy.js` 的蓝色连续光谱保持不变（`tests/native/energy.test.js` 强校验蓝色系与对比度）。
3. **`DialContext` 在 FullCalendar 自定义视图中的注意事项**：
   - FullCalendar 通过内部的 `CustomRenderingComponent`（React `PureComponent`）门户挂载 `DayDial`，因此在 [`DayDial.jsx`](./src/planner/DayDial.jsx) 中保留 `globalThis.__EC_DIAL_CONTEXT__` 单例与 `globalThis.__EC_DIAL_STATE__` 兜底，避免 Vite HMR 后上下文引用分裂。

---

## 4. 运行环境注意事项与后续待办

1. **Web 服务端静态 HTML 缓存**：
   - [`EC/server/app.js`](./server/app.js#L252-L262) 会在首次访问页面时把 `dist/index.html` 缓存在内存 `indexHtml` 变量中。每次运行 `npm run build` 更新前端构建产物后，**必须重启 `server/index.js`** 才能加载到最新的哈希脚本。
2. **当前仅 Web 服务端模式（`isServer`）激活 AI 入口**：
   - [`EC/src/planner/repository.js`](./src/planner/repository.js#L74-L81) 中仅 `createServerRepository` 暴露了 `aiStatus` / `aiWeights` / `aiQuickCapture` / `aiCognitiveWeight`；
   - 在 Electron 桌面版（`isDesktop`）和无后端纯浏览器本地模式中，因 `repository.aiStatus` 未定义，`aiStatus.enabled` 自动保持 `false`，AI 入口自动隐身；
   - **后续待办建议**：如需在 Electron 桌面版直接启用 AI，可在 `EC/desktop/main.cjs` 与 `EC/desktop/preload.cjs` 桥接本地 `createAiService`（或转发已登录的同步服务端）并重新打包 `release/`，同时注意 [`启动精力感知日历.bat`](../%E5%90%AF%E5%8A%A8%E7%B2%BE%E5%8A%9B%E6%84%9F%E7%9F%A5%E6%97%A5%E5%8E%86.bat) 会优先启动 `EC/release/win-unpacked/精力日历.exe`。
3. **已知测试偶发竞争提示**：
   - `tests/native/calendar-rendering.test.js` 中原有测试 `clicking a preview row without moving opens the editor` 在多文件并发高 CPU 负载下偶发 Framer Motion 退出动画（140ms）与 `DWELL.warm`（160ms）的时序竞争；单独运行或重跑即可稳定通过。

---

## 5. 验收记录

在 `EC` 目录下执行以下验收命令，全部通过：

1. **全量原生测试**：
   ```bash
   node --test tests/native/*.test.js
   ```
   结果：**111 项测试全部通过**（`tests 111, pass 111, fail 0, skipped 0`）。
2. **生产与示例构建**：
   ```bash
   node scripts/build-dial-demo.js
   node node_modules/vite/bin/vite.js build
   ```
   结果：示例页 [`EC/public/dial-demo.html`](./public/dial-demo.html) 与生产产物 `EC/dist/assets/index-BLQX8A5D.js`、`EC/dist/assets/CalendarCanvas-CZvksnhi.js`、`EC/dist/assets/index-CZiy5TL3.css` 构建成功（0 错误）。
