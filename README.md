# Agent Messenger

[中文](#中文) | [English](#english)

Headless local cross-agent messaging MCP server over stdio for **Codex**, **Antigravity**, and **Pi** — plug-and-play client auto-detection, path migration, event-driven `wait_ms`, and an optional local dashboard.

跨端无头本地智能体互发 MCP 服务，面向 **Codex**、**Antigravity** 与 **Pi** —— 支持换机即插即用自检测接入、跨设备路径自动迁移、事件驱动 `wait_ms` 等待与可选本地看板。

---

## 中文

### 简介

`Agent Messenger` 是一个轻量级本地 MCP（Model Context Protocol）标准输入输出服务，仅提供四个核心工具：`list_sessions`、`send_message`、`get_message`、`start_session`，以及一个可选本地状态看板（`http://127.0.0.1:3721/`）。

- **聚焦三端**：当前维护 **Codex**、**Antigravity**、**Pi**；不包含 HUD、WebView2、额度查询、Token 统计或审批拦截。
- **零运行时依赖**：`dist/agent-messenger.mjs` 已打包全部 JavaScript 依赖，运行与接入无需 `npm install` 或 Python（仅需本机已有 **Node.js 24.9.0+**）。
- **换机即插即用**：拉取仓库或解压运行包后，一行命令即可自动探测本机已安装客户端、补齐缺失配置、迁移旧路径并同步 Pi 扩展。

### 即插即用与自动接入

从 GitHub 克隆仓库或解压发行运行包（`dist/agent-messenger-runtime.zip`）后，直接运行一键接入脚本（支持 Windows / macOS / Linux）：

```powershell
node scripts/install.mjs
# 或使用以下等效入口：
npm run setup
npx . setup
python scripts/install.py
```

自动检测与迁移机制：

- **客户端与环境自检测**：自动识别 `CODEX_HOME`、`GEMINI_CLI_HOME`、`PI_CODING_AGENT_DIR`、`PATH` 中的可执行文件、各端配置/安装目录及本机 Node.js 24.9+ 路径；未安装的客户端自动跳过（也可用 `--clients codex,pi` 或 `--all` 指定范围）。
- **缺失配置自动生成**：已安装客户端尚无配置文件时，自动创建目录并写入标准 MCP 配置（`~/.codex/config.toml`、`~/.gemini/config/mcp_config.json`、`~/.pi/agent/mcp.json`）。
- **跨设备/换目录自动迁移**：若旧配置中已存在 `agent-messenger`（或历史 `agent-hud`）条目、TOML dotted keys 或残留 HTTP 传输字段且路径不一致，先生成 `.agent-messenger-*.bak` 备份再迁移更新 `command` / `args`，同时保留原有 `env`、超时策略与其他 MCP 服务；配置一致时幂等跳过，不产生多余备份。
- **Pi 扩展自动同步**：自动将 `plugins/pi/agent-messenger.ts` 同步到 `~/.pi/agent/extensions/agent-messenger.ts`。
- **诊断与卸载**：运行 `npm run doctor`（或 `node scripts/install.mjs --check`）可只读检查接入状态；`node scripts/install.mjs --uninstall` 可安全卸载并保留备份。

#### Pi（pi-coding-agent）原生包安装

本仓库同时声明了 `pi-package` 清单（`package.json` 中的 `pi.extensions`），可直接通过 Pi 包管理器安装：

```bash
pi install https://github.com/huashuimoyv/agent-messenger
# 或安装本地克隆目录：
pi install /path/to/agent-messenger
```

当以 Pi 包直接加载且 `mcp.json` 尚未配置 `agent-messenger`（兼容 `agent_messenger` 命名空间）时，扩展会自动调用 `pi.registerMcpServer` 挂载打包后的 MCP 服务，并通过 `pi.events` 防止多份加载重复挂载监听。

### 使用方法

1. 完成接入后，在客户端中重载 MCP 配置或新开会话（客户端按 stdio 自动拉起服务，无需手动开后台窗口）。
2. 调用 `send_message`：既可先通过 `list_sessions` 获取精确会话 ID，也可直接传语义简写（如 `"to": "antigravity"` 或 `"to": "codex:latest"`，优先匹配同项目在线空闲会话）。
3. **单次调用等待结果**：在 `send_message` 或 `get_message` 中传入 `"wait_ms": 15000`（上限 `30000`），服务端通过 `fs.watch` 监听回执与原生日志变化并辅以 `250ms` 兜底检查。
4. **精确回信**：回信时传 `reply_to` 和 `text` 并省略 `to`，即可精确路由回原发送会话；显式指定其他完整会话 ID 属于转发，不会把原请求标为已回信。
5. **拉起新会话**：`start_session` 支持 `client: "codex" | "pi"`、现有绝对路径 `folder` 与首条消息 `text`。
6. **身份绑定**：优先使用客户端自动携带的调用者身份元数据；未携带时可在对应 MCP 启动环境中设置 `AGENT_MESSENGER_CLIENT` 与 `AGENT_MESSENGER_SESSION_ID`。

### 本地看板

- 双击 `open-dashboard.vbs` 打开独立窗口，或运行 `npm run dashboard` 后访问 `http://127.0.0.1:3721/`。
- MCP 启动时也会伴生提供同端口看板；更新代码后需重载对应进程才会生效。

### 数据与状态边界

- 数据默认存储于 `%LOCALAPPDATA%\agent-messenger`（可通过 `AGENT_MESSENGER_HOME` 覆盖）；消息 journal 保留 7 天，仅记录元数据与内容指纹，回复正文按需从客户端原生记录读取。
- 重复请求请复用 `request_id`；`uncertain` 表示消息可能已投递，切勿更换新 ID 盲目重发。连续转发默认上限 10 次，用户在链路中发起新输入后重置。
- Antigravity 忙时入队的普通回复无法可靠归属，需显式使用 `reply_to`。
- `expired` 在看板中显示为“已结束等待”，不代表已撤回远端任务；迟到的可靠原生完成记录或精确回信仍可更新状态。存在已验证显式回信时状态保持 `replied`，同一轮次的最终答案仍可读取。
- **延期支持**：Claude Code 与 DeepSeek Harness 的历史适配器及模板暂时保留，当前不安装、生成或接入这两端。

### 开发与构建

```powershell
npm ci
npm run build
npm test
# Windows 构建并同步 dist/agent-messenger-runtime.zip：
powershell -NoProfile -File scripts/package.ps1
# 追踪上游互发协议变更（过滤 GUI/HUD 等无关改动）：
npm run check-upstream
```

架构设计与审计说明见 [docs/AUDIT.md](docs/AUDIT.md)，上游追踪说明见 [docs/UPSTREAM_TRACKING.md](docs/UPSTREAM_TRACKING.md)。

---

## English

### Overview

`Agent Messenger` is a lightweight local MCP (Model Context Protocol) stdio server for cross-agent messaging, exposing four focused tools — `list_sessions`, `send_message`, `get_message`, and `start_session` — alongside an optional local dashboard (`http://127.0.0.1:3721/`).

- **Focused client support**: Actively maintained for **Codex**, **Antigravity**, and **Pi**; contains no HUD, WebView2, quota tracking, token meters, or approval hooks.
- **Zero runtime dependencies**: `dist/agent-messenger.mjs` bundles all JavaScript dependencies, requiring only **Node.js 24.9.0+** (no `npm install` or Python needed at runtime).
- **Plug-and-play across machines**: After cloning from GitHub or extracting `dist/agent-messenger-runtime.zip`, a single setup command auto-detects installed clients, creates missing configs, migrates stale paths, and syncs the Pi extension.

### Plug-and-Play Setup

After cloning the repository or extracting a release runtime bundle, run the cross-platform auto-installer (Windows / macOS / Linux):

```bash
node scripts/install.mjs
# Equivalent entrypoints:
npm run setup
npx . setup
python scripts/install.py
```

What the installer does automatically:

- **Client & runtime detection**: Inspects `CODEX_HOME`, `GEMINI_CLI_HOME`, `PI_CODING_AGENT_DIR`, executables on `PATH`, client app/profile directories, and your local Node.js 24.9+ binary; undetected clients are skipped cleanly (override with `--clients codex,pi` or `--all`).
- **Creates missing configs**: Generates `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`, or `~/.pi/agent/mcp.json` when a detected client does not have one yet.
- **Cross-device path migration**: Safely backs up existing configs (`.agent-messenger-*.bak`) and updates stale `agent-messenger` (or legacy `agent-hud`), dotted TOML, or leftover HTTP-transport entries to the current machine/repo path while preserving `env`, timeouts, and all other MCP servers; stays idempotent with no extra backups when already up-to-date.
- **Syncs the Pi extension**: Copies `plugins/pi/agent-messenger.ts` to `~/.pi/agent/extensions/agent-messenger.ts`.
- **Diagnostics & uninstall**: Run `npm run doctor` (`node scripts/install.mjs --check`) for read-only inspection, or `node scripts/install.mjs --uninstall` to cleanly remove entries while keeping backups.

#### Native `pi-package` Support

`package.json` declares a standard `pi-package` manifest (`pi.extensions`), so Pi users can also install directly:

```bash
pi install https://github.com/huashuimoyv/agent-messenger
# Or from a local checkout:
pi install /path/to/agent-messenger
```

When loaded as a Pi package without an existing `agent-messenger` / `agent_messenger` entry in `mcp.json`, the extension auto-registers the local bundled MCP server via `pi.registerMcpServer` and deduplicates event hooks across `pi.events`.

### Usage

1. Reload MCP configuration or start a new session in your client (the client launches the stdio MCP server automatically).
2. Call `send_message` with either an exact session ID from `list_sessions` or a semantic shorthand (`"antigravity"`, `"codex:latest"` — preferring idle, reachable sessions in the same project).
3. Pass `"wait_ms": 15000` (up to `30000`) to `send_message` or `get_message` to wait in-call via `fs.watch` with a `250ms` fallback sweep.
4. Reply with `reply_to` and `text` while omitting `to` to route back to the original sender; passing a different target ID forwards the message without marking the original request as replied.
5. Use `start_session` with `client: "codex" | "pi"`, an existing absolute project `folder`, and an initial `text` prompt.
6. Both Codex legacy JSONL and paginated history databases are supported; caller identity is derived from MCP client metadata or `AGENT_MESSENGER_CLIENT` / `AGENT_MESSENGER_SESSION_ID`.

### Local Dashboard

Run `npm run dashboard` (or `open-dashboard.vbs` on Windows) and open `http://127.0.0.1:3721/`. The MCP server also hosts the same dashboard endpoint while active.

### Data & Guarantees

- Local state lives under `%LOCALAPPDATA%\agent-messenger` (or `AGENT_MESSENGER_HOME`). The SQLite journal retains 7 days of metadata and content fingerprints; reply bodies are read on demand from native client transcripts.
- Reuse `request_id` on retries; `uncertain` means delivery may have occurred and must not be retried with a new ID. Consecutive forwards default to a `passLimit` of 10 until a real user prompt resets the chain.
- Queued deliveries made while Antigravity is mid-turn cannot safely bind an ordinary final answer and require an explicit `reply_to`.
- `expired` indicates waiting ended unconfirmed rather than cancelling the remote task; late reliable completions or explicit replies still update status, and verified `replied` records preserve access to any native final answer.
- Claude Code and DeepSeek Harness adapters/templates remain in the tree as deferred code and are not installed or wired.

### Development & Packaging

```bash
npm ci
npm run build
npm test
# Windows runtime bundle (dist/agent-messenger-runtime.zip):
powershell -NoProfile -File scripts/package.ps1
# Audit upstream messaging changes only:
npm run check-upstream
```

See [docs/AUDIT.md](docs/AUDIT.md) for architecture details and [docs/UPSTREAM_TRACKING.md](docs/UPSTREAM_TRACKING.md) for upstream tracking rules.
