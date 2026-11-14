Agent Messenger 0.1.0

无头本机互发 MCP，仅含四个工具：
list_sessions / send_message / get_message / start_session

运行需要本机已有 Node.js 24.9+。将 agent-messenger.mjs、LICENSE、NOTICE、
THIRD_PARTY_LICENSES.txt、ui、scripts/install.mjs 和 plugins/pi/agent-messenger.ts
保存在一起。运行时不需要 npm 或 node_modules。

一键自动检测并接入本机已安装的 Codex / Antigravity / Pi（含自动迁移旧路径与同步 Pi 扩展）：
node scripts/install.mjs

MCP 启动命令（由接入脚本自动写入各客户端配置）：
node --disable-warning=ExperimentalWarning <绝对路径>/agent-messenger.mjs

客户端自动通过标准输入输出启动服务，无需单独打开后台窗口。
消息数据默认位于 %LOCALAPPDATA%\agent-messenger。

当前维护 Codex / Antigravity / Pi；新建会话支持 Codex 和 Pi。
Claude、DeepSeek 的已有模板保留，当前不接入。

MCP 启动后可访问 http://127.0.0.1:3721/ 查看本地看板。
回复仅传 reply_to 与 text，省略 to，即可精确回到原发送会话。
“已结束等待”不代表已撤回远端任务，迟到的可靠答案仍可更新。

完整源码、配置接入脚本、插件及实测结果：E:\Ameath\agent-messenger
