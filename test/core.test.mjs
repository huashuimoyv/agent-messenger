import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Messenger, callerIdentity } from '../src/messenger.mjs';
import { jsonLines } from '../src/io.mjs';

function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-test-'));
  const config = { data, deepseekChannel: path.join(data, 'deepseek'), passLimit: 10 };
  const sent = [], prompts = new Map(), answers = new Map();
  const sessions = ['a', 'b', 'c'].map(rawId => ({ id: `codex:${rawId}`, rawId, client: 'codex', title: rawId, project: data, state: 'idle', reachable: true }));
  const adapter = { client: 'codex', list: async () => sessions, get: async id => sessions.find(s => s.rawId === id) || null,
    capture: async () => ({}), current: async s => prompts.has(s.id) ? { text: prompts.get(s.id) } : null,
    deliver: async (s, text, id) => { sent.push({ to: s.id, text, id }); prompts.set(s.id, text); return { state: 'queued' }; },
    read: async (s, m) => answers.get(m.id) || {} };
  const first = new Messenger(config, [adapter], {}), second = new Messenger(config, [adapter], {});
  t.after(() => { first.close(); second.close(); fs.rmSync(data, { recursive: true, force: true }); });
  const meta = raw => ({ threadId: raw });
  return { config, sent, prompts, answers, adapter, first, second, meta };
}

test('two MCP owners reserve the same request once; conflicting retry is refused', async t => {
  const f = fixture(t); f.prompts.set('codex:a', 'human task');
  const args = { to: 'codex:b', text: '中文消息', request_id: 'one-attempt' };
  const [a, b] = await Promise.all([f.first.send(args, f.meta('a')), f.second.send(args, f.meta('a'))]);
  assert.equal(a.id, b.id); assert.equal(f.sent.length, 1);
  await assert.rejects(f.second.send({ ...args, text: 'different' }, f.meta('a')), /different content/);
});

test('ACK loss remains uncertain across owners and never resends the request', async t => {
  const f = fixture(t);
  f.adapter.deliver = async () => { f.sent.push('bytes left'); throw new Error('ACK lost'); };
  const args = { to: 'codex:b', text: 'only once', request_id: 'lost' };
  const a = await f.first.send(args, f.meta('a'));
  assert.equal(a.state, 'uncertain');
  const b = await f.second.send(args, f.meta('a'));
  assert.equal(b.id, a.id); assert.equal(f.sent.length, 1);
});

test('pass 11 is refused; unreadable transcript keeps chain; real user prompt resets it', async t => {
  const f = fixture(t); f.prompts.set('codex:a', 'human task');
  let last;
  for (let i = 1; i <= 10; i++) {
    const sender = i % 2 ? 'a' : 'b', target = i % 2 ? 'b' : 'a';
    last = await f.first.send({ to: `codex:${target}`, text: `pass ${i}` }, f.meta(sender));
    assert.equal(last.pass, i);
  }
  f.prompts.delete('codex:a');
  await assert.rejects(f.second.send({ to: 'codex:b', text: 'eleven' }, f.meta('a')), /10 passes/);
  f.prompts.set('codex:a', `new task from user: inspect reply to ${last.id}`);
  assert.equal((await f.first.send({ to: 'codex:b', text: 'new chain' }, f.meta('a'))).pass, 1);
});

test('reply ownership and sender ownership; explicit and final answer survive other state updates', async t => {
  const f = fixture(t);
  const original = await f.first.send({ to: 'codex:b', text: 'request' }, f.meta('a'));
  await assert.rejects(f.first.send({ reply_to: original.id, text: 'forged' }, f.meta('c')), /received/);
  await assert.rejects(f.first.send({ to: 'codex:a', text: 'self' }, f.meta('a')), /itself/);
  await assert.rejects(f.first.get({ id: original.id }, f.meta('c')), /Unknown message/);
  const reply = await f.second.send({ reply_to: original.id, text: 'response' }, f.meta('b'));
  let got = await f.first.get({ id: original.id }, f.meta('a'));
  assert.equal(got.state, 'replied'); assert.equal(got.reply, reply.id);
  f.answers.set(original.id, { state: 'done', answer: 'exact turn answer', turn: 'turn-1' });
  got = await f.second.get({ id: original.id }, f.meta('a'));
  assert.equal(got.state, 'done'); assert.equal(got.answer, 'exact turn answer'); assert.equal(got.reply, reply.id);
  f.first.journal.update(original.id, { state: 'queued' });
  assert.equal(f.first.journal.get(original.id).state, 'done');
});

test('identity comes from MCP metadata, not a model-written argument', () => {
  assert.deepEqual(callerIdentity({ 'x-codex-turn-metadata': { thread_id: 'a', turn_id: 't' } }, {}), { client: 'codex', rawId: 'a', turnId: 't' });
  assert.equal(callerIdentity({}, {}), null);
});

test('JSONL cursor preserves an unfinished line and a split UTF-8 character', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-lines-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'turn.jsonl');
  const complete = Buffer.from('{"text":"中文"}\n');
  fs.writeFileSync(file, complete.subarray(0, complete.length - 3));
  const first = []; for await (const row of jsonLines(file)) first.push(row);
  assert.equal(first.length, 0);
  fs.appendFileSync(file, complete.subarray(complete.length - 3));
  const next = []; for await (const row of jsonLines(file, 0)) next.push(row);
  assert.equal(next[0].value.text, '中文'); assert.equal(next[0].offset, complete.length);
});
