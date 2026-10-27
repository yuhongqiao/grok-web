# grok-web

在浏览器里用 [Grok Build](https://docs.x.ai/build/overview)：按项目管理会话，新开会话、接着聊、看历史，终端里的交互基本都能在页面上点。

A local web UI for Grok Build sessions. Unofficial, not affiliated with xAI.

> 非 xAI 官方项目。Grok 是 xAI 的商标。

## 环境要求

- macOS 或 Linux（Windows 见下面说明）
- Node.js 20 或更新
- 装好并登录过的 Grok Build：终端里 `grok --version` 能打出版本号，`grok` 能正常对话。网页会在后台启动 `grok agent stdio`，沿用你在 `~/.grok/config.toml` 里配的模型、API key 和权限。

已在 macOS arm64（Node.js 22）和 Debian 12 arm64（Node.js 20）上通过构建、单元、接口和浏览器测试，测试使用模拟 Grok。依赖锁文件包含 macOS、Linux、Windows 的 arm64 和 x64 原生构建包，但 Intel Mac、Linux x64 尚未实测。换机器后重新安装依赖，不要直接复制 `node_modules`。

**Windows**：Grok Build 官方提供 Windows 安装方式，但本项目的路径处理和会话锁检测尚未适配原生 Windows。可以在 WSL2 内按下面的 Linux 步骤安装，把 Node.js、Grok Build 和本项目都装在同一个 WSL2 环境；本项目在 WSL2 下尚未实测。

## 安装

```bash
git clone https://github.com/yuhongqiao/grok-web.git
cd grok-web
npm install
npm run build
npm start
```

然后在浏览器打开 http://127.0.0.1:3090 。

### 独立的 Codex 工作台

左上角可以切换 **Grok / Codex**，也可以直接打开 `/grok` 或 `/codex`。两边使用独立页面、会话列表、草稿和设置；切换工作台不会停止后台正在运行的任务。

使用 Codex 前，先在本机装好并配置 Codex CLI，确认 `codex --version` 和 `codex app-server --help` 能正常运行，并完成 CLI 登录或 API key 配置。打开 Codex 页面后服务才会启动自己的 `codex app-server` 进程，沿用本地 Codex 的账号及配置。

在 Codex 页面添加已有项目目录，即可新建会话，或从列表继续本地 CLI / app-server 的历史会话。支持文本和图片对话、UTF-8 文本附件（选择、拖入、粘贴）、流式输出、工具轨迹和文件 diff、模型与推理强度选择、只读 / 工作区写入 / 完全访问权限、命令与文件审批、用户提问、停止、改名、按轮分叉、归档与恢复、复制回复及 Markdown 导出。附件最多 8 个、每个 8MB；PDF、Office 和其他二进制附件暂不支持。

任务运行时，Enter 将消息加入网页服务的队列，当前任务完成后依次发送；Ctrl/⌘+Enter 或「立即补充」调用 CLI 的 `turn/steer`，把输入补充给当前这一轮。队列最多 5 条，支持暂停、继续、编辑文字、调整顺序、移除或立即补充；编辑保留附件与技能。停止、任务失败或 CLI 退出时会暂停，发送失败的排队消息会保留。队列（含附件与每条消息的设置）写入 `data/codex-queues/`，刷新、切换页面、CLI 或网页服务重启后仍可恢复；服务重启后需手动继续。若服务退出时消息正在发送，会提示先查看历史再决定继续或移除，避免重复执行。

`/` 打开 Codex 独立命令菜单，支持 /new /resume /rename /fork /compact /plan /model /effort /skills /skill-manager /settings /retry /undo /status /copy /export /archive /help；`@` 搜索当前项目文件，`$` 或技能按钮选择本地已启用的技能。技能管理可搜索、刷新、启停技能；启停会写入本机 Codex 配置。模型、推理强度、权限和计划 / 执行模式可随下一条消息发送，也可点击勾选按钮或使用 /settings 立即保存到会话，不启动新任务。计划 / 执行模式使用 CLI 的原生 collaboration mode，仅在 CLI 提供该能力时显示。

输入框只保留一个权限入口，可选择「沿用当前权限」「只读」「工作区写入」「完全访问」及本机自定义配置。只读和工作区写入搭配按需审批，完全访问搭配从不审批；只有主动选择并保存或发送后才生效。权限列表读取 CLI 的 `permissionProfile/list`，本机策略禁止的配置不可选；旧 CLI 不支持该接口时使用原生沙箱模式。需要独立设置访问范围或审批时，打开「自定义权限」，保留原生三种审批策略和五类 granular 选项；取消不保留修改。默认继承当前设置，不写入全局 CLI 配置，网络访问和可写目录等配置细节由原生 CLI 解析并保留。

每轮回复下方可复制、按轮分叉、编辑输入或重试。编辑与重试在所选轮次之前建立新分支，保留原会话，重新发送该轮初始输入（含附件、技能）；失败时消息保留在新分支的暂停队列中。新建会话使用 CLI 的分页历史，可通过回退按钮或 /undo 移除指定轮及后续对话；旧版历史可通过编辑 / 重试创建分支。分叉与历史回退都不回退项目文件。侧栏和归档窗口使用 CLI 全文搜索历史内容，并支持继续加载搜索结果。

命令与文件审批支持允许一次、本会话允许、拒绝、拒绝并停止，仅显示 CLI 对该请求开放的选项；权限审批仅授权本轮。提问支持选项、自由输入和跳过。MCP 请求支持基本表单（文字、数字、布尔值、单选和多选）及验证链接；设备证明等需要专用客户端的类型会明确提示，可在网页拒绝或取消。网页不会自动打开验证链接或自动确认审批。

会话右上角菜单支持复制会话链接、ID、`codex -C … resume …` 恢复命令、新标签打开、置顶、Markdown / JSON 导出，以及主动开启完成通知。每轮下方可复制定位链接，打开后会展开并滚动到对应轮次，包括较早的历史。链接指向当前本机服务；置顶和通知偏好保存在当前浏览器。

在对话中直接说「用浏览器登录并测试这个页面」并提供地址，Codex 可自动打开内置浏览器、填写登录表单、点击页面并验证结果。对话旁会自动显示页面预览和操作轨迹；窄屏显示在对话上方。浏览器使用独立 Chrome 进程，默认不弹出外部窗口。需要自己输入账号密码、验证码或授权时，Codex 可发起接管并等待；在预览中点击页面、输入内容，点击「完成登录，继续」后原工具返回更新后的页面，Codex 继续测试。CLI 要求的工具审批仍由用户确认。

「浏览器测试」保留手动调试、切换项目登录配置、标签页、截图预览与点击、元素填写和文字断言、桌面 / 手机 / 平板视口、截图标注及发送到当前 Codex 会话。点击「开始录制」后，面板或 Codex 浏览器工具执行的操作会写成用例；接管操作不录制。保存后可回放、下载含逐步截图及控制台 / 网络诊断的报告，并设置最终截图的视觉基准。密码框填写的口令转为运行变量，回放时重新填写，不写入用例和报告。「让 Codex 修复并重测」将报告及用例 ID 发送到当前原生会话；需要登录时可由用户在内置浏览器完成。

浏览器能力通过一个新增的原生 stdio MCP 服务提供，名称为 `grok_web_browser_…`，只通过 `-c` 参数附加到此 Web 服务管理的 app-server 进程。不会写入 `~/.codex/config.toml`、替换系统提示、关闭已有 MCP 或技能、调整原生权限。每轮通过原生 `additionalContext` 告知当前网页提供的浏览器入口，保留用户原文，并明确继续到其他客户端时使用该客户端的工具。工具为 `browser_open`、`browser_snapshot`、`browser_action`、`browser_screenshot`、`browser_handoff`、`browser_tests`，调用遵循 CLI 的 MCP 机制。接管等待最多五分钟，超时后仍保留用户控制权。项目和登录配置独立存放于 `data/codex-browser/`，不读取个人 Chrome 配置；需安装 Chrome / Chromium，可用 `CHROME_BIN` 指定位置。

「开发面板」提供项目文件树、UTF-8 文本编辑及保存冲突检查、Git 状态 / 差异 / 暂存 / 取消暂存 / 显式提交 / 新分支、原生代码审查、交互终端和项目脚本启动 / 停止。文件使用 CLI 的 `fs/*`，Git、终端与服务使用 `command/exec`，代码审查使用 `review/start`，未指定权限覆盖。原生沙箱拒绝 Git 写入时保留拒绝，可点击「交给 Codex 处理」在当前会话走原生审批流程。切换面板不停止进程，停止 Web 服务会关闭其 CLI 和测试浏览器。补充命令：`/review /link /resume-cli /browser /workspace`。

Codex 历史通过 app-server 接口读写；网页添加的项目目录另存为 `data/codex-projects.json`。未发送的文字和 Codex 输入选项按会话保存在当前浏览器标签页中，附件草稿保存在按标签页隔离的 IndexedDB 中。归档保留 Codex 历史，不删除项目文件。

```text
Codex 页面 ──HTTP + SSE──> 本机 Node 服务 ──JSON-RPC──> codex app-server
Grok 页面  ──HTTP + SSE──> 本机 Node 服务 ──ACP───────> grok agent stdio
```

如果服务找不到 `codex`，启动时指定完整路径，例如：

```bash
CODEX_AGENT_COMMAND=/完整路径/codex npm start
```

本机已用 Codex CLI `0.163.0-alpha.11.2` 验证上述基础会话能力，以及新增 MCP 的发现与调用、文件读写、PTY 输入 / 调整尺寸 / 停止、服务输出和 Git 读取。新旧进程的已有 MCP、features、权限配置一致，全局配置文件哈希未变化。原生沙箱对 Git 写入的拒绝同样保留；Git 完整操作另在隔离测试仓库验证。原生审查页面采用模拟协议测试，未重新调用真实模型审查。app-server 协议会随 CLI 版本变化，不支持的新接口会显示错误，其他版本仍需实测。

已知缺陷、尚未接入的能力与验证边界见 [Codex 验收记录](docs/codex-audit.md)。

### 安装为桌面应用

在 Chrome 中打开页面，通过右上角菜单「投放、保存和分享 → 将网页安装为应用」安装 `grok web`。安装后可以从桌面应用入口启动，页面会在独立窗口里打开；再次在 Chrome 中访问时，可以使用地址栏的「在应用中打开」。

本机的 `http://127.0.0.1` 和 `http://localhost` 都支持，无需配置 HTTPS。安装后仍需保持本机服务运行，并使用安装时的地址和端口。

### 放到后台运行

```bash
nohup npm start > ~/grok-web.log 2>&1 &
```

停止：

```bash
kill $(lsof -tiTCP:3090 -sTCP:LISTEN)
```

### 更新

```bash
git pull
npm install
npm run build
```

再重启服务。

## 配置

都是可选的环境变量，启动时加在前面，比如 `PORT=3100 npm start`：

| 变量 | 默认 | 作用 |
|------|------|------|
| `PORT` | `3090` | 端口。只监听 `127.0.0.1`，这一点改不了 |
| `GROK_PARENT_DIR` | 现有项目最集中的那个上级目录，没有项目就用主目录 | 「新建项目」默认建在哪 |
| `GROK_AGENT_COMMAND` | `grok` | `grok` 不在 PATH 里时，填它的完整路径 |
| `GROK_HOME` | `~/.grok` | Grok 的数据目录 |
| `CODEX_AGENT_COMMAND` | `codex` | Codex CLI 可执行文件的路径 |
| `CODEX_PARENT_DIR` | 主目录 | Codex「添加项目」的默认目录 |
| `CHROME_BIN` | 常见 Chrome / Chromium 安装路径 | 浏览器测试使用的可执行文件 |

## 数据放在哪

- 会话记录就是 Grok 自己的 `~/.grok/sessions/`，网页直接读，不另存一份。
- 删除会话只是移到 `~/.grok/session-trash/`，项目里的代码不动。
- 在网页里新建或移除的项目，记在这个目录下的 `data/projects.json`。

## 只给本机用

这个服务能开 Grok 会话、执行命令，所以只让这台电脑访问：

- 固定只监听 `127.0.0.1`，没有改成别的 IP 的开关，局域网和外网都连不上。
- 请求的 Host 必须是 `127.0.0.1` 或 `localhost`，挡住借 DNS 重绑定从浏览器里调接口；浏览器带来的 Origin 不是本页面（或开发页面）的一律拒绝。
- 不要用端口转发、内网穿透之类的方式把它暴露出去。

## 能做什么

- **项目和会话**：左边按项目列出 `~/.grok/sessions/` 里的会话；新建项目会建真实目录。会话可以改名、删除。
- **新会话先选项目**：点「新会话」先选项目；输入框左下角的项目也能在发第一句前换。
- **连发消息**：Grok 在忙时照样能发，消息进 Grok 自己的排队，可以移除，或者「立即发送」（打断当前这一轮先跑它，也可以 Ctrl+Enter）。
- **模型、推理强度、权限**：输入框下方分开显示，菜单往上弹；权限有询问、计划模式、自动审批、全部放行（Shift+Tab 轮换）。默认跟 `~/.grok/config.toml` 一致。
- **Grok 停下来等你的时候**：权限审批、Grok 提的选择题、计划审批（批准 / 按意见修改 / 放弃）都在输入框上方弹卡片。
- **斜杠命令**：`/` 打开菜单，网页命令（/new /resume /rename /fork /rewind /btw /model /effort /plan /view-plan /usage /copy /export …）和 Grok 自己的命令、技能、工作流（/compact /context /goal /deep-research …）一起列出。`@` 搜项目里的文件，发送时作为文件引用交给 Grok。
- **对话里**：思考过程、工具调用（按读取 / 搜索 / 命令 / 修改归组，能展开看命令、输出和 diff）、待办、每轮用量和用时；「轨迹」页按轮列出所有工具调用；底部是本会话的轮数、token、缓存命中和费用。
- 同一个会话在终端里开着时，页面顶部会提示：两边各记各的对话。

## 怎么接的 Grok

```text
浏览器 ──HTTP + SSE──> 本机 Node 服务 ──JSON-RPC (ACP)──> grok agent stdio
```

- 一个 `grok agent stdio` 进程服务所有会话；它退出后下一次操作会自动重启。
- 历史直接读 `updates.jsonl`（没有时读 `chat_history.jsonl`）。打开会话时先拿一份快照，之后通过 `GET /api/sessions/:id/events` 收实时事件；中途刷新页面不会丢正在输出的内容。
- 发消息是 `session/prompt`，排队和插队用 Grok 的 `x.ai/queue/*`；审批、提问、计划分别回应 `session/request_permission`、`x.ai/ask_user_question`、`x.ai/exit_plan_mode`。
- 切换权限需要重新载入会话，所以只能在这一轮结束、排队清空后切换。

## 常见问题

- **页面提示「Grok 没有启动」**：后台起不来 `grok agent stdio`。先在终端里确认 `grok` 能用；装在别处就用 `GROK_AGENT_COMMAND` 指过去。
- **端口被占用**：换一个，比如 `PORT=3100 npm start`。
- **从来不弹审批卡片**：`~/.grok/config.toml` 里多半是 `permission_mode = "always-approve"`，新会话默认就是「全部放行」。在输入框下方把权限切到「询问」就会弹。
- **会话在终端里也开着**：页面顶部会提示。网页和终端各自记录对话，同时在两边发消息会互相看不到。

## 开发和测试

```bash
npm run dev
```

页面在 http://127.0.0.1:5173 （改代码自动刷新），接口仍在 3090。

```bash
npm test
npm run test:live
```

`npm test` 先打包，再用模拟的 Grok（`test/fake-agent.js`）和 Codex（`test/fake-codex.js`）跑单元、接口和浏览器测试，不调用真实模型。Codex 测试覆盖会话恢复、流式输出、扩展审批、MCP 表单、进程退出、工作台切换、文字与附件草稿、文件引用、技能管理和计划模式、队列编辑排序与服务重启恢复、立即补充、编辑重试、分页历史回退、全文搜索、设置保存、分叉、压缩、归档恢复及导出。浏览器测试会查找 macOS、Linux 常见位置的 Chrome / Chromium，也可以用 `CHROME_BIN` 指定可执行文件路径，没找到会跳过。`test:live` 连真实的 Grok 在临时目录里跑几轮（会用掉一点额度）：测排队、拒绝一次写文件、切推理强度和计划模式、/btw，结束后删掉临时会话。

新增测试覆盖真实 Chrome 的独立登录态、录制回放、运行密钥、诊断与视觉对比，以及新面板、链接定位、通知和文件冲突。`CODEX_NATIVE_TEST=1 CODEX_AGENT_COMMAND=/完整路径/codex npm test` 可额外开启真实 CLI 兼容检查；使用临时项目和临时会话，不调用模型、不改全局配置，并验证原生权限保持不变。

`CODEX_NATIVE_BROWSER_TEST=1 CODEX_AGENT_COMMAND=/完整路径/codex npm test` 另行开启真实模型的对话浏览器测试，会消耗模型额度。在本地隔离登录站点中，由自然语言消息发起，经原生 MCP 审批完成登录、点击、断言及截图，检查对话预览自动出现、用户原文与全局配置保持不变，结束后归档临时会话。

## 许可证

[MIT](LICENSE)
