import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpClient } from '../scripts/mcp-client.mjs';

test('real stdio server initializes, lists exactly four tools, validates input and rejects anonymous writes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-protocol-'));
  const client = new McpClient({
    ...process.env,
    AGENT_MESSENGER_HOME: path.join(root, 'data'),
    CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    DSH_HOME: path.join(root, 'dsh'),
    PI_CODING_AGENT_DIR: path.join(root, 'pi'),
    PI_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    AGENT_MESSENGER_CLIENT: '',
    AGENT_MESSENGER_SESSION_ID: '',
  });
  t.after(async () => { await client.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const initialized = await client.initialize();
  assert.equal(initialized.serverInfo.name, 'agent-messenger');
  const tools = await client.request('tools/list', {});
  assert.deepEqual(tools.tools.map(v => v.name).sort(), ['get_message', 'list_sessions', 'send_message', 'start_session']);
  const found = await client.call('list_sessions', { client: 'claude' });
  assert.deepEqual(found.sessions, []);
  const refused = await client.call('send_message', { to: 'codex:a', text: 'test' });
  assert.equal(refused.state, 'refused'); assert.match(refused.reason, /did not identify/);
  await assert.rejects(client.call('send_message', { text: '  ' }), /must not be empty|validation|invalid/i);
  assert.equal(client.stderr, '');
});
