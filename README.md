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

`npm test` 先打包，再用模拟的 Grok（`test/fake-agent.js`）跑单元、接口和浏览器测试，不调用真的 Grok；浏览器测试会查找 macOS、Linux 常见位置的 Chrome / Chromium，也可以用 `CHROME_BIN` 指定可执行文件路径，没找到会跳过。`test:live` 连真实的 Grok 在临时目录里跑几轮（会用掉一点额度）：测排队、拒绝一次写文件、切推理强度和计划模式、/btw，结束后删掉临时会话。

## 许可证

[MIT](LICENSE)
