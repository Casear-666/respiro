# 精力日历 2.0

让时间，留有余地。一款面向个人的 Windows 本地日历，使用点击、拖动和拉伸安排日程。

## 直接使用

- 安装包：`release/EnergyCalendar-2.0.1-Setup.exe`，可选择安装目录并创建桌面快捷方式。
- 免安装运行：`release/win-unpacked/精力日历.exe`。保留同目录全部文件。
- 无需安装 Node、MySQL 或 Docker。默认免登录，断网可用。
- 双击项目根目录的「启动精力感知日历.bat」也会优先打开已构建的桌面程序。

当前构建面向 Windows 10/11 x64。安装包未配置发布者代码签名。

## 使用方式

| 操作           | 方式                                        |
| -------------- | ------------------------------------------- |
| 创建日程       | 点击日历空白，或点击「新建日程」/ 按 N；名称可留空，自动命名「新安排」 |
| 创建精确时间段 | 周、日视图中拖选，15 分钟吸附               |
| 编辑           | 点击日程，在编辑器中操作                    |
| 复制与粘贴     | Ctrl+C 复制；Ctrl+V 粘贴到所选日期；Ctrl+D 创建副本 |
| 改期与改时长   | 周、日视图拖动日程；月视图从悬停预览中拖到目标日期；拖动边缘调整时长 |
| 取消拖动       | 松手前按 Esc                                |
| 查看某日       | 点击日期数字或左侧小日历                    |
| 预览某日       | 在月视图日期、周/日视图表头或左侧小日历上稍作停留 |
| 删除           | 右键菜单直接删除（可撤销）；编辑器中点删除并确认 |
| 空白处右键     | 在当天或点击的时刻新建日程，或粘贴到该位置  |
| 撤销 / 重做    | Ctrl+Z / Ctrl+Shift+Z 或 Ctrl+Y，最多 30 步 |
| 搜索           | Ctrl+K，按名称和备注搜索；输入新名称可直接创建 |
| 今天 / 视图    | T / 1（月）、2（周）、3（日）               |
| 操作帮助       | ?                                           |

全天日程使用日期保存，结束日期为排他边界；界面显示含当天的结束日期。定时日程保存 ISO 时间，在本机时区显示。切换视图保留选定日期。输入文字时不会触发全局快捷键。

核心热力色谱为「鼠尾草绿 → 麦穗黄 → 焦糖橙 → 陶土红 → 酒红」。事件背景按同时重叠数连续插值（1 / 2 / 3 / 5 / 8+），日期整格底色按当天安排总量着色。月视图不再绘制事件条，日期格直接表达：底色随负荷着色，至多 3 枚分类色点加「+n」计数，跨日事项以格底细线提示；颜色约 450ms 平滑过渡，相邻日期之间还有轻微的色彩渗透。全天和跨日任务也计入，已完成任务不计入。拖动和拉伸过程中纯本地预览热力变化，松手后保存，撤销会同步恢复颜色。分类仅使用小色点辅助标记。右侧同时显示日程项数与去重后的定时占用时长，不把全天任务误算为 24 小时。

## 数据与迁移

桌面日程保存于 Electron `userData` 目录下的 `calendar.sqlite`（通常是 `%APPDATA%/Energy Calendar`），不写入安装目录。通过左下角「我的本地空间 → 数据目录」定位实际位置。

- 每日启动自动保存 JSON 快照，`backups/` 保留最近 14 份每日备份。
- 「导出备份」保存可迁移的 JSON 文件。
- 「导入日程」兼容旧版 `events.json` 及 2.0 备份。导入会验证整个文件、保留原有日程、跳过完全重复项；相同编号但内容不同的日程会分配新编号。导入前另外保存快照。
- 项目根目录的旧 `events.json` 保留原样。首次打开后用「导入旧日程」选择它即可迁移。
- 旧浏览器 `ec-local-events` 数据仅能在相同浏览器、相同网址下读取；新版网页预览会自动读取此键，之后可导出备份导入桌面。
- 示例空间仅保存在内存中，退出即丢弃，导入与导出操作在示例空间中禁用。
- 保存失败时保留窗口内数据，底部显示「重试保存」。桌面在保存未完成时会阻止正常关闭。
- 卸载默认保留用户数据；更新安装包不会覆盖个人数据库。

网页预览与桌面数据库独立。网页预览使用浏览器存储；它不是云同步版本。

## 自建服务器（可选）

除本地桌面版外，也可以把日历放到自己的 Ubuntu/Debian 服务器上，用同一个账号在多设备的浏览器中使用。需要 Node 24 或更高版本，后端只用 Node 内置模块（`node:http`、`node:sqlite`、`node:crypto`），无需额外数据库。

```bash
# 在服务器上（以 Ubuntu/Debian 为例）
node --version                   # 确认 >= 24；否则先安装官方 Node 24 发行版或配置好的 NodeSource 源
# 复制项目源码（src/、shared/、server/、desktop/、package.json、vite.config.js、index.html 等）
npm ci && npm run build          # 需要 devDependencies 构建 dist/
cp .env.server.example .env.server  # 按需修改后保持默认 127.0.0.1:3001 即可
read -rs CALENDAR_ADMIN_PASSWORD && export CALENDAR_ADMIN_PASSWORD
npm run server:create-user -- <用户名>   # 创建账号；密码只经环境变量传入
unset CALENDAR_ADMIN_PASSWORD
npm run server                          # 启动，默认仅监听 127.0.0.1:3001
```

首次使用推荐 SSH 隧道，立即可用且无需开放端口：

```bash
ssh -L 3001:127.0.0.1:3001 user@SERVER_IP
# 本地浏览器打开 http://127.0.0.1:3001 登录
```

- 数据保存在 `CALENDAR_DATA_DIR`（默认 `./data`）：`accounts.sqlite` 存账号与会话，`users/<账号 id>/` 下是各自的 `calendar.sqlite` 与 `backups/`。目录属主建议收紧为服务账号（如 `energy-calendar`）。
- 每个账号的数据库在每个服务进程内首次打开时尝试保存当天 JSON 快照；同一天已有快照则跳过，长期运行不会定时触发备份（`backups/daily/` 各保留最近 14 份），导入前另存 `before-import-*` 快照。完整备份请**停止服务后整体复制数据目录**（账号库与各日程库必须一起备份，应用不提供整站导出）。
- 没有开放注册：账号只能由管理员用 `server:create-user` 创建；新增其他用户时各自数据自动隔离。同一日程在两处修改时，**后保存的一方生效**；在其他设备修改后请刷新页面查看。
- 网页预览的浏览器数据与服务器账号互不相通；迁移请先在旧端「导出备份」，再在新端「导入日程」。
- 暂不对外公开时保持 `CALENDAR_SECURE_COOKIE=false` 并经 SSH 隧道访问。之后要直接 HTTPS 访问：参考 `deploy/nginx.conf.example`（自签/已有证书占位）与 `deploy/energy-calendar.service`（systemd，按实际 Node 路径调整 ExecStart），同时设置 `CALENDAR_SECURE_COOKIE=true` 与 `CALENDAR_PUBLIC_ORIGIN=https://你的域名`。不建议对公网开放纯 HTTP 登录。
- 运行时只需要已构建的 `dist/`、`server/`、`desktop/database.js`、`shared/` 与 `package.json`，后端不依赖 `node_modules`（只用 Node 内置模块）。`npm ci` 仅用于构建前端；也可以在本机构建后只把上述文件复制到服务器。Windows 的 `node_modules` 不能用于 Linux 部署，如需在服务器上构建请重新 `npm ci`。

## 本地开发与验证

需要 Node 24 LTS 或更高版本（`node:sqlite`）。

```powershell
npm ci
npm run dev            # 网页开发预览
npm run desktop        # Vite + Electron 桌面开发
npm run build          # 前端生产构建
npm test               # 真实 Node/SQLite 测试
npm run test:native     # 数据语义、导入合并、重叠算法、SQLite 事务与备份
npm run desktop:smoke   # 隔离数据，验证生产页面、热力着色、IPC 读写和数据库重开恢复
npm run desktop:dist    # Windows x64 安装包
```

`tests/native/` 共 35 项，使用 Node 官方测试运行器、真实 React/FullCalendar 和 SQLite。桌面冒烟测试加载真实生产构建，在临时数据目录验证三项全天日程在月视图日期格与色点上的着色、IPC 创建/改期/删除、精确到分钟的时间保存，以及重开 SQLite、重载页面后的颜色和主题恢复。运行前需要先 `npm run build`；也可直接运行 `release/win-unpacked/精力日历.exe --smoke-test` 验证打包程序。测试与构建结果记录于 `artifacts/`。

## 结构与实现

- `src/planner/`：独立的新界面、原生交互封装、编辑器、偏好设置、串行保存与撤销历史。
- `shared/domain.js`：日程校验、迁移、时区/全天边界、O(n log n) 全局重叠计算及负荷统计。
- `desktop/`：Electron 主进程、受限 preload 通道与 SQLite 数据库。渲染进程无 Node 权限，启用 context isolation、sandbox 和 CSP，不启动本地 HTTP API。
- `server/`：可选的自建服务器。`accounts.js` 管理账号（scrypt 口令散列、SHA-256 会话令牌），`app.js` 提供同源 JSON API 与静态资源，按账号隔离复用桌面的 `openCalendarDatabase`；`index.js`/`create-user.js` 为启动与建号入口。浏览器在服务端页面下经 `/api/runtime.js` 注入切换为服务器存储，登录态使用 HttpOnly、SameSite=Strict Cookie，写请求要求 `X-Calendar-Request` 头与同源 Origin。
- `deploy/`：systemd 单元与 nginx HTTPS 反代示例，供以后直接对外访问时参考。
- 生产前端与数据库模块仅依赖已打包资源及 Node 内置模块，安装包不包含开发依赖。

当前维护本地桌面版、网页预览与可选的自建服务器；旧 Express/MySQL 服务、Docker 配置、旧离线启动服务、旧界面前端代码（`src/components/`、`src/stores/` 等）及其回归测试均已移除。

项目已清理旧截图、重复安装包、测试解压副本和过时协作记录；`release/` 保留 2.0.1 安装包及启动脚本使用的免安装目录。当前使用与开发说明以本文件为准。清理记录与保留文件的校验值见 `artifacts/CLEANUP.json`。

设计参考 [Anthropic](https://www.anthropic.com/) 的温暖中性色、排版与留白；日历沿用 FullCalendar 的成熟几何与拖拽能力。桌面边界遵循 [Electron IPC 文档](https://www.electronjs.org/docs/latest/tutorial/ipc)。
