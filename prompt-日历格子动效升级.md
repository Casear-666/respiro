# 提示词：精力日历 · 月视图格子动效与轻量日程呈现升级

> 使用方式：在 Devin 中以 **Fusion 模式** 开启会话，Lead 选 **Opus**，Sidekick 选 **SWE-2 High**，将本文件全文粘贴为任务描述。

---

## 0. 角色与工作方式

你是一名资深前端工程师（staff level），同时精通交互设计与动效工程。本项目**前端体验是核心竞争力**，视觉吸引力与动效品质优先级最高；在"美观、流畅"与"实现省事"冲突时，永远倾向前者，但要给出取舍说明。

工作方式（Fusion 模式约定）：

- **Opus（lead）统领全局**：负责架构决策、动效方案选型、代码评审与最终验收；可对不确定的取舍主动向用户提问。
- **SWE-2 High（sidekick）负责执行**：具体编码、CSS 实现、测试修复。
- 允许查阅 GitHub 上的现有优秀实现作对比借鉴，但**不照搬**；选型时输出"借鉴方案 vs 自研方案"的简要对比表与采纳理由。
- 已有初步调研结论（见 §6），可作为起点复核，允许推翻并说明原因。

## 1. 项目上下文（已核实，勿再重复探索无关代码）

仓库：`EC/`（Electron + React 19 + Vite 的离线桌面日历"精力日历"）。

- `EC/src/planner/CalendarCanvas.jsx`：FullCalendar 封装。月视图每个日程渲染为 `.event-tile` 长条（`eventDisplay="block"`、`dayMaxEvents`）；`styleDay()` 按 `rangeLoads()` 结果为每个 `.fc-daygrid-day-frame` 写入 `--day-heat`（格子底色）与 `--day-heat-ink`。
- `EC/src/planner/planner.css`：全部样式。已有 `--dur-fast/--dur/--dur-slow`、`--ease-*` 设计变量；`.fc-daygrid-day-frame` 已有 `transition: background-color var(--dur-slow)`。
- `EC/shared/energy.js`：`energyForCount(count)` 在 鼠尾草绿→麦穗黄→焦糖橙→陶土红→酒红 上**连续插值**（非离散档位），返回 `ink/cell/gradient/text/label`。
- `EC/shared/domain.js`：`normalizeEvent()` 目前强制 `title` 为 1–200 字，空标题抛错"请输入 1–200 字的日程名称"。
- `EC/src/planner/EventEditor.jsx`：标题 `<input required>`；`PlannerApp.jsx` 中 `newEvent/createForDay/createAt` 生成 draft。
- 已装依赖可直接用：`framer-motion@12`、`sonner`、`lucide-react`。**默认不新增运行时依赖**；若认为值得引入（如 floating-ui），先给出理由再装，版本锁定 ≥7 天前发布。
- 设计语言：Anthropic 式暖色中性纸感、大量留白、克制的微动效；UI 文案为中文，语气参考现有文案（"让时间，留有余地"）。
- 测试：`npm test`（native 测试）、`npm run build`、`npm run desktop:smoke`（需先 build）。

## 2. 任务目标（按优先级）

### P0 —— 日程名称可省略，自动生成默认名

- `normalizeEvent` 允许空标题：为空时回退到默认名 `"未命名日程"`（仍保留 200 字上限校验）。
- `EventEditor` 标题输入框移除 `required`，placeholder 维持"添加标题"；保存时空标题写入默认名。
- 保证搜索（`title/description` 匹配）、复制副本命名、备份导入导出、Toast 文案（如 `已复制「…」`）在默认名下表现一致。导入备份时空标题项同样归一化为默认名而非报错跳过。

### P0 —— 月视图去除事件长条，格子本身承载信息

现状：月视图每个日程是一条 `.event-tile` 色条，多条堆叠使格子臃肿、影响排版。

目标：

- `dayGridMonth` 视图**不再渲染任何事件行/长条**。日期格子保持干净：`日期数字 + 热力底色 + 紧凑指示`。
- 紧凑指示：格子内至多 3 枚 4–5px 分类色小圆点 + 超出时 "+n" 计数徽标（用 `--day-heat-ink` 着色，`tabular-nums`），视觉上克制、不喧宾夺主。全天/跨日日程用一条 2px 细底线色段暗示跨度（可选，若影响简洁则省略）。
- 实现路径建议：月视图中给 FullCalendar 传 `events={[]}`（或等价手段）彻底消除事件行的布局占位；指示点由 `dayCellContent` 基于 `loadMap`/当日事件列表渲染。**注意**：此举会使月视图失去拖动改期能力——这是有意的取舍（拖拽在周/日视图保留，月视图改期通过小窗内点击编辑完成），实现后在交付说明中明确记录；若你评估出零代价保留拖拽的方案（不恢复长条视觉），可替代之。
- 周/日视图（timeGrid）保留时间定位色块——那里的"长条"承载时刻位置语义，不属于本次去冗对象；但其配色过渡与小窗逻辑须与月视图保持一致（见 P1/P2）。

### P0 —— 悬停驻留后格子"悬动"+ 小窗展示当日事项

交互规格（在 homarr 日历 350ms 延时方案基础上调优，见 §6）：

- **驻留延时**：指针进入格子静止约 `400ms` 后触发；进入后在 `~120ms` 起格子先进入 `.dwell` 悬动态（视觉先行，预告小窗将开），`400ms` 时小窗打开。指针快速掠过不触发任何效果。
- **格子悬动态**：`translateY(-2px)` + 热力色饱和度/亮度轻幅提升 + 一圈 `color-mix(in srgb, var(--day-heat-ink) 25%, transparent)` 柔光投影；过渡用 `--dur var(--ease-out)`，小窗存续期间保持悬动态。
- **小窗（DayPreview）**：整个画布**单一实例**（非每格一个），锚定当前格子，优先上方展开、空间不足翻转下方、贴边自动平移。framer-motion `AnimatePresence` 进出场：`opacity 0→1, y 6→0, scale .96→1`，spring `{ stiffness: 400, damping: 30 }`，出场 ~140ms ease-in。
- **小窗内容**（不是长条复制，是信息卡）：日期头（如"11月9日 · 周日"）、负荷摘要（"3 项安排 · 较忙 · 约 4.5 小时"）、日程清单——每行 `时刻区间 + 分类色点 + 标题（截断）+ 重叠徽标 + 完成态划线`；超过约 6 行内部滚动（max-height ~280px）。清单项 hover 微亮、点击打开该日程的 EventEditor。无日程的格子不出小窗（或显示极轻的"留白时光"提示，二选一，取更简洁者）。
- **关闭**：离开格子后 `~150ms` 宽限（允许指针移到小窗上），Esc、点击画布空白、滚动/视图切换即关；键盘聚焦格子等效触发，保证可访问性对等。
- 与现有 `flash-target` 高亮、右键菜单、`dateClick` 创建流程**不得冲突**；小窗打开期间点击格子行为维持现状（新建/选中日），由实现者判断是否需要 pointer-events 隔离。

### P1 —— 格子色彩平滑渐变（时间维 + 空间维）

- **时间维**：用 `@property --day-heat { syntax: "<color>"; inherits: false; }` 注册颜色变量，使日程增删/拖动导致的热度变化以 ~450ms `var(--ease-standard)` 在两个颜色间插值，而不是跳变；`--day-heat-ink` 同法。不支持的运行时回退到现有 `background-color` 过渡（行为已是平滑色插值）。
- **空间维**：相邻格子热度不同造成的"补丁感"要软化。`styleDay` 追加计算左右（必要时含上下）邻格热度色，写入 `--day-heat-l` / `--day-heat-r`（邻色经 `color-mix(in oklch, 邻色 28%, 本色)` 得到）；格子背景改为 `linear-gradient(90deg, var(--day-heat-l, var(--day-heat)), var(--day-heat) 35%, var(--day-heat) 65%, var(--day-heat-r, var(--day-heat)))`。整行呈现柔和色波而非色块拼贴；`fc-day-other` 非本月格子不参与邻色混合。
- 拖动预览（`preview`/`allowPreview` 实时重算 `rangeLoads`）期间上述渐变同样生效——这正是本功能的亮点时刻，验收时必看。

### P2 —— 全局面效一致性

- 上述"去长条 + 驻留小窗 + 悬动态 + 渐变"适用于**所有视图**：timeGrid 的 all-day 行列、左侧小月历（若技术成本可控；不可控则说明）。月视图是主战场，其余视图做到同一设计语言即可。
- `prefers-reduced-motion: reduce` 下：取消 transform/弹簧动效，小窗即时显隐，颜色渐变保留（颜色过渡不构成眩晕风险）。

## 3. 工程约束

- 代码风格对齐现有代码：compact、早退、`useCallback/useMemo` 按现状使用、无注释堆砌（不加新注释，除非逻辑非自明）。
- 不改 `shared/domain.js` 的重叠/负荷算法语义（`overlapLevels/dayLoad/rangeLoads`），仅允许为邻格取色新增纯函数（可放 `shared/energy.js` 或 `domain.js`，命名贴合现有风格）。
- 不破坏：`Ctrl+C/V/D`、撤销/重做、右键菜单、搜索跳转 `flash`、完成态、示例空间、导入导出、桌面 IPC 与保存队列。
- 性能：42 格 × 邻居取色须在 `useMemo`/`requestAnimationFrame` 内完成，拖动预览逐帧重算不得掉帧（沿用现有 rAF 节流模式）。
- 暗色主题两套配色都要验证。

## 4. 交付与验收

**验收标准**（逐条自检）：

1. 点击月视图空白格 → 编辑器打开 → 直接 Ctrl+Enter 保存 → 出现"未命名日程"，格子着色更新且无报错。
2. 月视图任一多日格子：无事件长条；仅见日期数字、底色、≤3 色点/计数。
3. 指针静止于格子 400ms：格子先轻浮起（~120ms 起），随后小窗打开，清单完整准确；快速扫过整排格子无一误触发；Esc 可关。
4. 周视图拖动一个日程到别日并松手：源/目标格底色在 ~450ms 内平滑变色，行内相邻格呈连续色波，无生硬跳变。
5. `npm test`、`npm run build` 通过；`desktop:smoke` 通过（若需改 smoke 断言，说明改动）。
6. 暗色主题、reduced-motion 下复查 1–4。

**交付说明**需包含：借鉴 vs 自研对比表（含各方案 URL 与取舍理由）、已知取舍（如月视图拖拽移除）、动效参数清单（所有 ms/缓动值集中列出便于微调）。

## 5. 需要时可向用户确认的点

- 默认名文案（"未命名日程" vs 其他，如"新安排"）。
- 月视图拖拽改期移除是否可接受（默认按本提示词执行：移除并记录）。
- 无日程格子悬停是否出小窗（默认：不出）。

## 6. 已有调研（起点，可复核推翻）

| 需求 | 候选方案 | 初步结论 |
|---|---|---|
| 驻留延时小窗 | Radix `HoverCard`（openDelay/closeDelay 内建） | 需把 trigger 注入 FullCalendar 自渲染 DOM，per-cell portal 成本高、引入新依赖 → 不采用 |
| 同上 | homarr 日历 hover-popover（[PR#6431](https://github.com/homarr-labs/homarr/pull/6431)，[issue#2637](https://github.com/homarr-labs/homarr/issues/6081)）：mouseenter 起 350ms 计时、leave 清除、共享单 popover | 生产验证的 hover-intent 时序，架构契合 → **借鉴时序逻辑，自研实现** |
| 同上 | 自研 DayPreview：画布级单实例 + cell rect 锚定 + framer-motion spring + `.dwell` 类驱动格子悬动态 | 与现有 Dialog/右键菜单模式一致，零新依赖 → **采用** |
| 格子渐变 | GitHub 系热力图（react-calendar-heatmap、shadcn-heatmap 等） | 全是离散色块，恰是要避免的"突兀"；本项目连续插值已更先进 → 不借鉴，用 `@property` + 邻格 `color-mix` 自研 |
| 格子悬动态 | react-spectrum AnimatedCalendar / uipkge calendar-day-pop 等 scale 微弹 | 可取其缓动手感（overshoot 克制在 ≤1.02），但本项目需与驻留计时耦合 → 自研 |
