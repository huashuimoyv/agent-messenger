# 上游互发子系统变更追踪规范 (Upstream Tracking)

本项目代码剥离自开源项目 [jazzenchen/agent-hud-open](https://github.com/jazzenchen/agent-hud-open.git)（Apache-2.0 协议）。

为了在彻底剔除 GUI、WebView2、Notch/Dock、额度爬虫与审批拦截的同时，持续吸收上游关于**智能体跨端互发通信**的最新改进，我们建立了专属的上游互发子系统追踪机制。

---

## 1. 关注范围与过滤边界

上游仓库中大量提交属于前端界面优化、Tauri 窗口控制、额度爬取规则或样式变动。我们在追踪中**严格过滤并只关注以下互发相关路径**：

- `src/crates/messaging/`：核心通信协议、转录本解析、熔断机制、日志管理。
- `src/crates/platform/src/delivery/`：各客户端消息队列与投递适配器。
- `src/crates/platform/src/claude_plugin/` 与 `src/crates/platform/src/deepseek_plugin/`：插件文件通道。
- `src/crates/platform/src/hooks/`：客户端 completion/rewake hooks 通信支持。
- `src/apps/mcp/`：MCP 调用者识别与元数据提取契约。
- `docs/agent-messages.md`、`docs/agent-contract.md`、`docs/client-hooks.md`：官方通信规范文档。

所有与 `src/packages/hud/`、`src/packages/app/`、`accounts/`、`pricing/`、`usage/`、`tao-panel-patch/` 相关的变更一律自动忽略。

---

## 2. 自动化追踪脚本

在工程根目录下执行以下命令即可自动拉取最新远程并比对互发子系统变动：

```powershell
npm run check-upstream
```

脚本会自动比对基线与最新 remote，输出受影响的互发提交列表与文件级 diff 统计，并记录至 `verification/upstream-sync.json`。

---

## 3. 当前上游最新动向审计 (2026-11-11)

- **基线提交 (Baseline)**：`d14bc43fe117f2f5d4e9143d5ebcf92c62225a66`
- **上游最新提交 (Latest)**：`6d259bca402778ff956247c4581f185efc2e0b57`
- **总新增提交**：8 个（其中 5 个涉及互发子系统）

### 互发相关提交详析：
1. `37a273c Support TRAE, WorkBuddy, Qoder, ZCode and Kimi Code, and message them through their own hooks`
   - **内容**：通过各客户端自身的 completion hook 和 rewake hook 机制，将互发能力扩展至 TRAE、WorkBuddy、Qoder、ZCode 与 Kimi Code。
2. `ef6e91b Install Cursor's prompt, tool and reply hooks beside its stop`
3. `df61802 Read a Cursor turn's reply from its transcript`
   - **内容**：针对 Cursor 客户端，通过其 prompt/tool/reply/stop hooks 截获对话并从转录本末尾捕获回复文本。
4. `a373dc7 Name a TRAE caller through the app's own processes`
   - **内容**：在 TRAE 跨进程架构中通过进程树匹配识别调用方会话。
5. `78aefad Say where the running copy is when hooks or HUD tools need the installed app`

### 对 Agent Messenger 的影响评估：
- **核心契约兼容性**：四工具（`list_sessions`、`send_message`、`get_message`、`start_session`）契约未发生任何破坏性变动。
- **现有客户端运行**：Codex（标准 app-server 队列）与 Antigravity（本地 Connect 接口）逻辑未受任何负面影响。
- **未来扩展潜力**：若未来需要在 Cursor、TRAE 或 Kimi Code 等新客户端中实现互发，可直接参考上游 hooks 通道设计在 `src/adapters/` 目录下扩建对应的轻量适配器。
