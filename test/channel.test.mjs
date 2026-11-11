import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { ChannelAdapter } from '../src/adapters/channel.mjs';
import { atomicJson } from '../src/io.mjs';
import { start } from '../plugins/deepseek/agent-messenger.mjs';

function fixture(t, client) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-channel-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const config = { claudeHome: path.join(root, 'claude'), deepseekHome: path.join(root, 'dsh'), claudeChannel: path.join(root, 'claude-channel'), deepseekChannel: path.join(root, 'deepseek-channel') };
  const adapter = new ChannelAdapter(config, client), id = client === 'claude' ? 'claude-test-id' : 'session-test-id';
  const channel = config[`${client}Channel`];
  atomicJson(path.join(channel, 'sessions', `${id}.json`), { at: Date.now() });
  const file = client === 'claude' ? path.join(config.claudeHome, 'projects', 'project', `${id}.jsonl`) : path.join(config.deepseekHome, 'sessions', 'project', id, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, client === 'claude' ? '' : zstdCompressSync(Buffer.from('')));
  return { root, config, adapter, id, channel, file };
}

test('Claude final answer belongs to the marked turn, excludes later replies and request copies', async t => {
  const f = fixture(t, 'claude');
  const session = await f.adapter.get(f.id), anchor = await f.adapter.capture(session);
  const rows = [
    { type: 'user', uuid: 'wanted', message: { role: 'user', content: '[Agent Messenger · from codex · m-one]\nquestion' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'this answer' }], stop_reason: 'end_turn' } },
    { type: 'api-request-blob', message: { role: 'user', content: '[Agent Messenger · m-one]' } },
    { type: 'user', uuid: 'later', message: { role: 'user', content: 'later question' } },
    { type: 'assistant', message: { role: 'assistant', content: 'wrong answer', stop_reason: 'end_turn' } },
  ];
  fs.appendFileSync(f.file, rows.map(v => `${JSON.stringify(v)}\n`).join(''));
  const reply = await f.adapter.read(await f.adapter.get(f.id), { id: 'm-one', state: 'queued', anchor });
  assert.equal(reply.state, 'done'); assert.equal(reply.answer, 'this answer'); assert.equal(reply.turn, 'wanted');
});

test('DeepSeek compressed concatenated frames bind exact turn and ignore time context', async t => {
  const f = fixture(t, 'deepseek'), anchor = await f.adapter.capture(await f.adapter.get(f.id));
  const rows = [
    { type: 'session', id: f.id, version: 4, cwd: f.root },
    { type: 'turn/start', seq: 1, data: { turn: 3 } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '[Agent Messenger · m-two]\nquestion' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 3, data: { content: 'time context', source: { kind: 'time-context' } } },
    { type: 'assistant/message', seq: 4, data: { turn: 3, message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '精确回复' }] } } },
    { type: 'turn/end', seq: 5, data: { turn: 3, reason: { kind: 'completed' } } },
  ];
  fs.writeFileSync(f.file, Buffer.concat(rows.map(v => zstdCompressSync(Buffer.from(`${JSON.stringify(v)}\n`)))));
  const reply = await f.adapter.read(await f.adapter.get(f.id), { id: 'm-two', state: 'queued', anchor });
  assert.equal(reply.state, 'done'); assert.equal(reply.answer, '精确回复'); assert.equal(reply.turn, '3');
});

test('plugin confirmation is readable after 60 seconds without any HUD maintenance', async t => {
  const f = fixture(t, 'claude');
  atomicJson(path.join(f.channel, 'prompts', f.id, 'm-old.json'), { takenAt: Date.now() - 90000, startedAt: Date.now() - 89000 });
  const reply = await f.adapter.read(await f.adapter.get(f.id), { id: 'm-old', state: 'queued', anchor: {} });
  assert.equal(reply.state, 'started');
  const stale = path.join(f.channel, 'sessions', `${f.id}.json`);
  fs.utimesSync(stale, new Date(Date.now() - 30000), new Date(Date.now() - 30000));
  await assert.rejects(f.adapter.deliver(await f.adapter.get(f.id), 'test', 'm-absent'), /not running/);
});

test('stripped DeepSeek plugin queues once, records caller and has no approval hooks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-plugin-'));
  const callbacks = new Map(), sent = [];
  const ctx = { agents: { list: () => [{ id: 'session-test' }] }, get: key => key === 'sessionController' ? { prompt: async p => { sent.push(p); return { accepted: true }; } } : null,
    on: (name, fn) => callbacks.set(name, fn) };
  const plugin = start(ctx, dir, { host: 100 });
  t.after(() => { plugin.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const target = path.join(dir, 'prompts', 'session-test', 'm-plugin.json');
  atomicJson(target, { id: 'm-plugin', text: 'queue this', at: Date.now(), expiresAt: Date.now() + 1000 });
  plugin.tick(); await new Promise(resolve => setImmediate(resolve)); plugin.tick();
  assert.equal(sent.length, 1); assert.equal(sent[0].mode, 'queue');
  assert.ok(JSON.parse(fs.readFileSync(target)).startedAt);
  assert.deepEqual([...callbacks.keys()], ['tools/execute']);
  await callbacks.get('tools/execute')({ name: 'mcp__agent-messenger__list_sessions', agent: { id: 'session-test' }, arguments: {} }, async () => {
    assert.equal(fs.readdirSync(path.join(dir, 'calls', '100')).length, 1);
  });
  assert.equal(fs.readdirSync(path.join(dir, 'calls', '100')).length, 0);
});
