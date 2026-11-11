Agent Messenger 0.1.0

无头本机互发 MCP，仅含四个工具：
list_sessions / send_message / get_message / start_session

运行需要本机已有 Node.js 24.9+。将 agent-messenger.mjs、LICENSE、NOTICE
和 THIRD_PARTY_LICENSES.txt 保存在一起。运行时不需要 npm 或 node_modules。

MCP 启动命令：
node --disable-warning=ExperimentalWarning <绝对路径>/agent-messenger.mjs

客户端自动通过标准输入输出启动服务，无需单独打开后台窗口。
消息数据默认位于 %LOCALAPPDATA%\agent-messenger。

Codex 和 Antigravity 可向现有会话互发；新建会话当前仅支持 Codex。
Claude Code、DeepSeek Harness 需要单独加载轻量插件。

完整源码、配置接入脚本、插件及实测结果：E:\Ameath\agent-messenger
