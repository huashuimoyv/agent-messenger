import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new McpClient();
const meta = { threadId: process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID };
const action = process.argv[2] || 'list';
try {
  const started = performance.now();
  const initialized = await client.initialize();
  if (action === 'list') {
    const tools = await client.request('tools/list', {});
    const sessions = await client.call('list_sessions', { limit: 100 }, meta);
    console.log(JSON.stringify({ server: initialized.serverInfo, initialize_ms: Math.round(performance.now() - started), pid: client.child.pid, tools: tools.tools.map(t => t.name), ...sessions }, null, 2));
  } else if (action === 'send') {
    const token = process.argv[4];
    const result = await client.call('send_message', { to: process.argv[3], text: `Authorized Agent Messenger smoke test. Please answer with exactly ${token}. No other work is needed.`, request_id: token }, meta);
    console.log(JSON.stringify(result));
  } else if (action === 'get') {
    const result = await client.call('get_message', { id: process.argv[3] }, meta);
    const output = process.argv[4];
    if (output) fs.writeFileSync(path.resolve(root, output), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } else if (action === 'start') {
    const token = process.argv[3];
    const result = await client.call('start_session', { client: 'codex', folder: root,
      text: `Authorized Agent Messenger smoke test. Reply to the message ID in the envelope using agent-messenger's send_message with reply_to and text exactly ${token}. If that MCP tool is unavailable, answer here with exactly ${token}. No files, configuration or other actions are needed.`, request_id: token }, meta);
    console.log(JSON.stringify(result));
  } else throw new Error('Use list, send <session-id> <test-token>, get <message-id>, or start <test-token>.');
} finally { await client.close(); }
