import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { configuration } from './config.mjs';
import { Messenger } from './messenger.mjs';
import { CodexAdapter } from './adapters/codex.mjs';
import { AntigravityAdapter } from './adapters/antigravity.mjs';
import { ChannelAdapter } from './adapters/channel.mjs';

const config = configuration();
const messenger = new Messenger(config, [new CodexAdapter(config), new AntigravityAdapter(config), new ChannelAdapter(config, 'claude'), new ChannelAdapter(config, 'deepseek')]);
const text = z.string().refine(value => Boolean(value.trim()), 'text must not be empty');
const request_id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional().describe('Optional retry key. Reuse it with exactly the same content after a disconnect; the prompt will not be sent again.');
const definitions = [
  ['list_sessions', 'list', true, 'List local Codex, Antigravity, Claude Code and DeepSeek Harness main sessions, their project, idle state, reachability and self. Unknown state is null. Use the returned id as send_message.to. Starts are supported for Codex only.',
    z.object({ client: z.enum(['codex', 'antigravity', 'claude', 'deepseek']).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict()],
  ['send_message', 'send', false, 'Enqueue text into another local session without interrupting it. Returns id and queued/refused/uncertain. Poll get_message for its final answer. reply_to must name a message you received; to can be omitted to answer its sender. Human input resets the default 10-pass chain limit. Reuse request_id after a disconnect, never blindly resend an uncertain message.',
    z.object({ to: z.string().min(1).optional(), text, reply_to: z.string().min(1).optional(), request_id }).strict()],
  ['get_message', 'get', true, 'Read the state and final answer of a message you sent. State is queued, taken, started, done, replied, refused, expired or uncertain. done is tied to the exact message turn. replied names an explicit reply delivered to your session. This call does not wake the target.',
    z.object({ id: z.string().min(1) }).strict()],
  ['start_session', 'start', false, 'Create a Codex session in an existing absolute project directory and queue its first prompt. Opens it in the installed Codex desktop client. Other clients are not started by this version. Returns a session_id and message id for get_message.',
    z.object({ client: z.enum(['codex', 'antigravity', 'claude', 'deepseek']), folder: z.string().optional(), text, request_id }).strict()],
];

const handle = serveStdio(() => {
  const server = new McpServer({ name: 'agent-messenger', version: '0.1.0' });
  for (const [name, method, readOnlyHint, description, inputSchema] of definitions) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false } }, async (args, context) => {
      try {
        const result = await messenger[method](args, context.mcpReq._meta);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        if (error.state) {
          const result = { state: error.state, reason: error.message };
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        }
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }
  return server;
}, { onerror: error => process.stderr.write(`agent-messenger: ${error.message}\n`) });

async function shutdown() { await handle.close(); messenger.close(); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
