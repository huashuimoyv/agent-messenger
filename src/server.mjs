import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { configuration } from './config.mjs';
import { Messenger } from './messenger.mjs';
import { createAdapters } from './adapters/index.mjs';
import { startDashboardServer } from './dashboard-server.mjs';

const config = configuration();
const adapters = createAdapters(config);
const messenger = new Messenger(config, adapters);
const dashboard = startDashboardServer({ config, adapters });
const clientEnum = z.enum(messenger.clientNames);
const text = z.string().refine(value => Boolean(value.trim()), 'text must not be empty');
const request_id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional()
  .describe('Optional retry key. Reuse it with exactly the same content after a disconnect; the prompt will not be sent again.');
const wait_ms = z.number().int().min(0).max(30_000).optional()
  .describe('Optional milliseconds (up to 30000) to wait via event-driven file watch for a done/replied result before returning.');

const definitions = [
  ['list_sessions', 'list', true,
    'List local Codex, Antigravity, Claude Code, DeepSeek Harness and Pi main sessions, their project, idle state, reachability and self. Unknown state is null. Use the returned id (or client shorthand like "antigravity") as send_message.to. Starts are supported for Codex and Pi.',
    z.object({ client: clientEnum.optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict()],
  ['send_message', 'send', false,
    'Enqueue text into another local session without interrupting it. to accepts a full session id from list_sessions or a client shorthand like "antigravity" / "antigravity:latest". Pass wait_ms to wait in-call for the final answer or reply_to. Reuse request_id after a disconnect, never blindly resend an uncertain message.',
    z.object({ to: z.string().min(1).optional(), text, reply_to: z.string().min(1).optional(), request_id, wait_ms }).strict()],
  ['get_message', 'get', true,
    'Read the state and final answer of a message you sent. State is queued, taken, started, done, replied, refused, expired or uncertain. Pass wait_ms (up to 30000) to block until done/replied without polling loops. This call does not wake the target.',
    z.object({ id: z.string().min(1), wait_ms }).strict()],
  ['start_session', 'start', false,
    'Create a Codex or Pi session in an existing absolute project directory and queue its first prompt. Returns a session_id and message id for get_message.',
    z.object({ client: clientEnum, folder: z.string().optional(), text, request_id }).strict()],
];

const handle = serveStdio(() => {
  const server = new McpServer({ name: 'agent-messenger', version: '0.1.0' });
  for (const [name, method, readOnlyHint, description, inputSchema] of definitions) {
    server.registerTool(name, {
      description,
      inputSchema,
      annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false },
    }, async (args, context) => {
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

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { dashboard?.close(); } catch {}
  try { await handle.close(); } catch {}
  try { messenger.close(); } catch {}
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.stdin.once('end', shutdown);
process.stdin.once('close', shutdown);
