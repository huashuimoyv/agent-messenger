# 无头互发服务实施边界

源码事实源：jazzenchen/agent-hud-open，固定提交 d14bc43fe117f2f5d4e9143d5ebcf92c62225a66，Apache-2.0。

- Node.js 24 原生 ESM，官方 MCP SDK v2，通过 stdio 暴露四个工具。
- 独立 SQLite journal，按需发现和读取；不包含 GUI、额度、Token 统计、审批拦截。
- Codex 通过已有 app-server 的 thread/queue/add 投递，不直接修改客户端数据库。
- Antigravity 只向已存在会话发送；首版 start_session 仅提供 Codex。
- Claude Code、DeepSeek Harness 使用独立轻量插件文件通道，保留确认记录，插件未加载时明确不可达。
- 投递前持久化 uncertain；可选 request_id 提供同一发送者内的幂等；ACK 不明不自动重试。
- sender 来自客户端元信息或启动环境；拒绝匿名、自发自收及非法 reply_to；连续转发默认最多10次。
- 回复必须关联消息所属 turn；Antigravity 忙时队列普通回复无法可靠对应，要求显式 reply_to。
- 配置接入先备份，再定点新增，保留其他 MCP 和审批配置。

实施前架构审查已完成。必要验证：真实客户端互发及答案捕获、跨进程幂等、断线 uncertain、10次熔断、半行日志、MCP 工具清单及配置回读。
