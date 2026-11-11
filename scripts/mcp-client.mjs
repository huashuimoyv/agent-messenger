// Small protocol verifier, also used for the live smoke tests. No UI required.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class McpClient {
  constructor(env = process.env) {
    this.child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', env.AGENT_MESSENGER_SERVER || fileURLToPath(new URL('../dist/agent-messenger.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map(); this.next = 1; this.stderr = '';
    this.child.stderr.on('data', b => { this.stderr += b.toString(); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('Non-protocol text appeared on MCP stdout.')); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
    this.child.once('error', error => this.fail(error));
    this.exit = new Promise(resolve => this.child.once('exit', (code, signal) => { this.fail(new Error(`MCP process exited (${code ?? signal}): ${this.stderr}`)); resolve(); }));
  }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  request(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out. A write may have happened; retain request_id.`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async initialize() {
    const info = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-messenger-verifier', version: '0.1.0' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return info;
  }
  async call(name, args = {}, meta) {
    const response = await this.request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    if (response.isError) throw new Error(response.content?.[0]?.text || 'Tool call failed');
    return response.structuredContent || JSON.parse(response.content[0].text);
  }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 2000);
    await this.exit; clearTimeout(timer);
  }
}
