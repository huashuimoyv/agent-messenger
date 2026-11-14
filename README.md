# Agent Messenger

本机智能体互发 MCP，提供 `list_sessions`、`send_message`、`get_message`、`start_session` 和可选本地看板。当前维护 Codex、Antigravity、Pi 三端；不包含 HUD、WebView2、额度查询、Token 统计或审批拦截。

运行要求：本机已有 Node.js 24.9+；Codex/Antigravity 使用各自现有的客户端。打包文件 `dist/agent-messenger.mjs` 已包含所需 JavaScript 依赖，运行时无需 npm 或 node_modules。

```powershell
& 'E:\Program Files\Node js\node.exe' --disable-warning=ExperimentalWarning E:\Ameath\agent-messenger\dist\agent-messenger.mjs
```

服务等待 MCP 标准输入，终端无输出属于正常状态。客户端由 MCP 配置自动启动服务，无需另开后台窗口。

## 使用

1. 在客户端中重新加载 MCP 配置或新开会话。
2. 调用 `send_message`：既可先通过 `list_sessions` 选取精确会话 ID，也可直接传语义简写（如 `"to":"antigravity"` 或 `"to":"codex:latest"`，优先匹配同项目在线空闲会话）。
3. 支持单次调用内等待结果：在 `send_message` 或 `get_message` 中传入 `"wait_ms":15000`（上限 30000）。服务端以 `fs.watch` 监听回执与日志变更，并用 250ms 检查兜底。

回信使用 `reply_to` 和 `text`，省略 `to`，即可回到原发送会话。携带 `reply_to` 时，客户端简称及 `client:latest` 同样指向原发送者；显式指定其他完整会话 ID 属于转发，不会把原消息标成已回信。

客户端自动提供调用会话身份。不要把另一个智能体协作工具中同名的 send_message 当作本服务工具。若客户端没有携带身份，应在其 MCP 启动环境中绑定 `AGENT_MESSENGER_CLIENT` 和 `AGENT_MESSENGER_SESSION_ID`，服务不会猜测“最新会话”。

新增客户端适配器只需实现自描述接口并在 `src/adapters/index.mjs` 注册，核心调度层 `src/messenger.mjs` 与协议层 `src/server.mjs` 无需改动。
可选的 `readPrompt(session, record)` 用于看板读取该消息的原始正文；找不到精确信封时返回 `null`，不借用后续其他输入。

`start_session` 支持 Codex 和 Pi，接受 `client:"codex" | "pi"`、现有绝对项目路径 `folder`、首条消息 `text`。其余客户端可以向现有会话发送。

Codex 的 legacy 和 paginated 历史都可读取。新建线程使用已实测的 legacy 历史格式；不会修改用户的全局历史格式设置。

## 客户端接入

```powershell
python E:\Ameath\agent-messenger\scripts\install.py
```

脚本修改并回读：

- `C:\Users\Ameath\.codex\config.toml`
- `C:\Users\Ameath\.gemini\config\mcp_config.json`
- `C:\Users\Ameath\.pi\agent\mcp.json`

写入前在原目录生成带时间戳的 `.agent-messenger-*.bak` 完整备份，保留其他服务器和配置。恢复时把对应备份复制回原路径，再重新加载客户端。备份可能含有原配置的私密内容，应留在本机。

## Pi (pi-coding-agent) 扩展支持

Pi 自动从 `~/.pi/agent/extensions/agent-messenger.ts` 加载扩展插件，实现会话心跳报到、排队消息自动消费、以及 MCP 调用者身份感知。会话历史自动从 `~/.pi/agent/sessions/` 的原生 JSONL 解析。可通过 `start_session` 直接拉起新的 Pi 实例。

## 本地看板

双击 `open-dashboard.vbs` 打开独立窗口，或运行 `npm run dashboard` 后访问 `http://127.0.0.1:3721/`。MCP 也会伴生启动同一看板；独立启动保持运行，伴生启动随 MCP 退出清理连接。更新代码后需重新加载相应服务，已运行进程不会自动热更新。

看板区分实时连接、断开后保留的上次数据和静态示例。未知模型显示“模型未提供”；正文只按消息信封 ID 提取，无法读取时明确提示。任务计时和目标取自实际未完成消息。

## 延期支持

Claude Code 与 DeepSeek Harness 的适配器及模板暂时保留，当前不安装、生成或接入这两端；未来启用时需另行验证真实客户端互发。

## 数据与边界

独立数据位于 `%LOCALAPPDATA%\agent-messenger`，可用 `AGENT_MESSENGER_HOME` 指定另一位置。消息 journal 保留7天，只记元数据和内容指纹；待接收队列文件必须暂存正文，插件取走后替换为确认状态。回复正文按需从客户端原始记录读取。

重复请求请复用 request_id；uncertain 表示可能已投递，不能换新 ID 盲目重发。连续转发默认最多10次，用户在链中发起新输入后重置。Antigravity 忙时收到的队列消息，普通最终回答无法可靠归属，需要显式 reply_to。

`expired` 在看板显示“已结束等待”：可能来自过期、目标离线或用户要求结束历史等待，不代表已撤回远端任务；迟到的可靠完成记录或精确回信仍可更新状态。回复关联必须同时匹配原消息 ID 和反向收发会话，正文中提到 `reply_to` 不能冒充真实回信。
存在已验证的显式回信时，状态保持 `replied`；同一原始轮次的最终答案仍可读取，不会因状态名称变化丢失正文。

开发：`npm ci`、`npm run build`、`npm test`。实际验证和资源占用见 `verification/report.json`；架构与上游映射见 [docs/AUDIT.md](docs/AUDIT.md)。
Windows 上运行 `powershell -NoProfile -File scripts/package.ps1` 可重新构建并同步运行包 ZIP，包含同一版本的服务、看板页面和许可证。

## 上游互发更新追踪

原版 Agent HUD 客户端已卸载，如需持续追踪开源上游（[jazzenchen/agent-hud-open](https://github.com/jazzenchen/agent-hud-open)）关于互发机制的最新改动：

```powershell
npm run check-upstream
```

脚本会自动过滤掉所有 GUI、WebView2、额度爬取和样式变动，仅审计互发协议、通道适配和 hooks 的变更，详情见 [docs/UPSTREAM_TRACKING.md](docs/UPSTREAM_TRACKING.md)。
