# Agent Messenger

独立无头的本机智能体互发 MCP。只提供 `list_sessions`、`send_message`、`get_message`、`start_session`；不包含 HUD、WebView2、额度查询、Token 统计或审批拦截。

运行要求：本机已有 Node.js 24.9+；Codex/Antigravity 使用各自现有的客户端。打包文件 `dist/agent-messenger.mjs` 已包含所需 JavaScript 依赖，运行时无需 npm 或 node_modules。

```powershell
& 'E:\Program Files\Node js\node.exe' --disable-warning=ExperimentalWarning E:\Ameath\agent-messenger\dist\agent-messenger.mjs
```

服务等待 MCP 标准输入，终端无输出属于正常状态。客户端由 MCP 配置自动启动服务，无需另开后台窗口。

## 使用

1. 在 Codex 或 Antigravity 中重新加载 MCP 配置或新开会话。
2. 让智能体调用 `agent-messenger` 的 `list_sessions`，选取目标 ID。
3. 调用 `send_message`：`{"to":"<目标ID>","text":"要发送的内容","request_id":"task-001"}`。
4. 用返回的消息 ID 调用 `get_message`，读取状态和最终回答。收件方可用 `{"reply_to":"<收到的消息ID>","text":"回复"}` 直接回信。

客户端自动提供调用会话身份。不要把另一个智能体协作工具中同名的 send_message 当作本服务工具。若客户端没有携带身份，应在其 MCP 启动环境中绑定 `AGENT_MESSENGER_CLIENT` 和 `AGENT_MESSENGER_SESSION_ID`，服务不会猜测“最新会话”。

`start_session` 首版只支持 Codex，接受 `client:"codex"`、现有绝对项目路径 `folder`、首条消息 `text`。其余客户端可以向现有会话发送。

Codex 的 legacy 和 paginated 历史都可读取。新建线程使用已实测的 legacy 历史格式；不会修改用户的全局历史格式设置。

## 客户端接入

```powershell
python E:\Ameath\agent-messenger\scripts\install.py
```

脚本修改并回读：

- `C:\Users\Ameath\.codex\config.toml`
- `C:\Users\Ameath\.gemini\config\mcp_config.json`

写入前在原目录生成带时间戳的 `.agent-messenger-*.bak` 完整备份，只将原 `agent-hud` MCP 入口替换为 `agent-messenger`，保留其他服务器和配置。恢复时把对应备份复制回原路径，再重新加载客户端。备份可能含有原配置的私密内容，应留在本机。

## Claude Code / DeepSeek Harness

两者需要轻量插件在会话内报到。本服务不会自动安装或改写它们的全局设置：

```powershell
node E:\Ameath\agent-messenger\scripts\prepare-plugins.mjs
```

Claude 生成的本地插件位于 `plugins/claude/generated`，使用 Claude Code 自己的本地插件安装方式加载。Harness 模块为 `plugins/deepseek/agent-messenger.mjs`，配置 `channel` 为准备脚本输出的 `deepseek_channel` 路径。两种插件均只负责报到、消息队列和调用者识别；未安装插件的会话不具备投递能力。

## 数据与边界

独立数据位于 `%LOCALAPPDATA%\agent-messenger`，可用 `AGENT_MESSENGER_HOME` 指定另一位置。消息 journal 保留7天，只记元数据和内容指纹；待接收队列文件必须暂存正文，插件取走后替换为确认状态。回复正文按需从客户端原始记录读取。

重复请求请复用 request_id；uncertain 表示可能已投递，不能换新 ID 盲目重发。连续转发默认最多10次，用户在链中发起新输入后重置。Antigravity 忙时收到的队列消息，普通最终回答无法可靠归属，需要显式 reply_to。

开发：`npm ci`、`npm run build`、`npm test`。实际验证和资源占用见 `verification/report.json`；架构与上游映射见 [docs/AUDIT.md](docs/AUDIT.md)。

## 上游互发更新追踪

原版 Agent HUD 客户端已卸载，如需持续追踪开源上游（[jazzenchen/agent-hud-open](https://github.com/jazzenchen/agent-hud-open)）关于互发机制的最新改动：

```powershell
npm run check-upstream
```

脚本会自动过滤掉所有 GUI、WebView2、额度爬取和样式变动，仅审计互发协议、通道适配和 hooks 的变更，详情见 [docs/UPSTREAM_TRACKING.md](docs/UPSTREAM_TRACKING.md)。
