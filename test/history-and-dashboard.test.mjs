import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { Journal, findReply } from '../src/journal.mjs';
import { Messenger } from '../src/messenger.mjs';
import { messageBody } from '../src/io.mjs';
import { messageState } from '../src/message-state.mjs';
import { AntigravityAdapter } from '../src/adapters/antigravity.mjs';
import { readPiTranscript } from '../src/adapters/pi.mjs';
import { startDashboardServer } from '../src/dashboard-server.mjs';

const record = (id, patch = {}) => ({ id, requestKey: id, fingerprint: id,
  fromId: 'codex:a', toId: 'codex:b', fromClient: 'codex', toClient: 'codex',
  sentAt: Date.now(), chain: id, pass: 1, kind: 'send', replyTo: null,
  state: 'queued', reason: null, anchor: {}, ...patch });
function folder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-final-'));
}
function removeFolder(dir) {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('messenger-final-'));
  fs.rmSync(dir, { recursive: true, force: true });
}

test('message body follows its own envelope across merged and adjacent native inputs', () => {
  const input = '<USER_REQUEST>[Agent Messenger · m-other]\nwrong body\n</USER_REQUEST>\n'
    + '<USER_REQUEST>[Agent Messenger · from codex · title · m-wanted]\nright body\n'
    + 'Reply using tool with reply_to: m-wanted.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>';
  assert.equal(messageBody(input, 'm-wanted'), 'right body');
  assert.equal(messageBody(input, 'm-other'), 'wrong body');
  assert.equal(messageBody('Please inspect m-wanted in a different message.', 'm-wanted'), null);
});

test('Antigravity prompt lookup skips unrelated inputs without borrowing an unsafe answer', async t => {
  const home = folder(), id = '11111111-2222-4333-8444-555555555555';
  t.after(() => removeFolder(home));
  const file = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(file, [
    { type: 'USER_INPUT', content: '<USER_REQUEST>Unrelated user input</USER_REQUEST>' },
    { type: 'USER_INPUT', content: '<USER_REQUEST>[Agent Messenger · m-other]\nother</USER_REQUEST>\n<USER_REQUEST>[Agent Messenger · m-wanted]\ncorrect body</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', status: 'DONE', content: 'shared answer is not attributable' },
  ].map(v => JSON.stringify(v) + '\n').join(''));
  const adapter = new AntigravityAdapter({ home, data: home }, { discover: async () => [] });
  const message = { id: 'm-wanted', state: 'queued', anchor: { path: file, offset: 0, correlationUnsafe: true } };
  assert.equal(await adapter.readPrompt({ rawId: id }, message), 'correct body');
  assert.equal(await adapter.readPrompt({ rawId: id }, { ...message, id: 'm-missing' }), null);
  const result = await adapter.read({ reachable: true }, message);
  assert.equal(result.state, 'queued');
  assert.equal(result.answer, undefined);
});

test('journal ignores wrong recipients, stale pointers and unconfirmed replies', t => {
  const dir = folder(), j = new Journal(dir); t.after(() => { j.close(); removeFolder(dir); });
  const parent = record('m-parent'); j.reserve(parent);
  j.reserve(record('m-wrong', { replyTo: parent.id, fromId: parent.toId, toId: 'codex:c' }));
  j.settleReply(parent.id, 'm-wrong');
  assert.equal(j.get(parent.id).replyId, null);
  j.update(parent.id, { replyId: 'm-wrong' });
  const child = record('m-correct', { replyTo: parent.id, fromId: parent.toId, toId: parent.fromId, state: 'uncertain' });
  j.reserve(child);
  assert.equal(findReply(j.db, j.get(parent.id)), null);
  j.update(child.id, { state: 'queued' });
  j.settleReply(parent.id, child.id);
  assert.equal(j.get(parent.id).replyId, child.id);
  assert.equal(j.reply(parent).id, child.id);
  assert.equal(messageState(j.get(parent.id), {}, null, j.reply(parent)).state, 'replied');
});

test('a late settlement cannot replace a valid reply linked by another owner', t => {
  const dir = folder(), first = new Journal(dir), second = new Journal(dir);
  t.after(() => { first.close(); second.close(); removeFolder(dir); });
  const parent = record('m-parent'); first.reserve(parent);
  for (const id of ['m-first', 'm-late']) first.reserve(record(id, {
    replyTo: parent.id, fromId: parent.toId, toId: parent.fromId,
  }));
  const get = first.get.bind(first); let interleave = true;
  first.get = id => {
    const value = get(id);
    if (id === parent.id && interleave) {
      interleave = false;
      second.settleReply(parent.id, 'm-first');
    }
    return value;
  };
  first.settleReply(parent.id, 'm-late');
  assert.equal(first.get(parent.id).replyId, 'm-first');
});

test('reply_to with client:latest still returns to the original sender', async t => {
  const data = folder(), destinations = [];
  const sessions = ['c', 'a', 'b'].map(rawId => ({ id: 'codex:' + rawId, rawId, client: 'codex', state: 'idle', reachable: true }));
  const adapter = { client: 'codex', list: async () => sessions, get: async id => sessions.find(s => s.rawId === id),
    capture: async () => ({}), current: async () => null,
    deliver: async target => { destinations.push(target.id); return { state: 'queued' }; } };
  const messenger = new Messenger({ data, passLimit: 10 }, [adapter], {});
  t.after(() => { messenger.close(); removeFolder(data); });
  const original = await messenger.send({ to: 'codex:b', text: 'request' }, { threadId: 'a' });
  const reply = await messenger.send({ to: 'codex:latest', reply_to: original.id, text: 'reply' }, { threadId: 'b' });
  assert.equal(destinations.at(-1), 'codex:a');
  assert.equal(messenger.journal.get(original.id).replyId, reply.id);
});

test('Pi history maintenance reads exact completion without touching channel files', async t => {
  const dir = folder(); t.after(() => removeFolder(dir));
  const transcript = path.join(dir, 'session.jsonl'), receipt = path.join(dir, 'receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({ takenAt: 1, startedAt: 2 }));
  fs.writeFileSync(transcript, [
    { type: 'message', message: { role: 'user', content: '[Agent Messenger · m-other]\nother' } },
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: 'wrong answer' } },
    { type: 'message', message: { role: 'user', content: '[Agent Messenger · m-wanted]\nrequest' } },
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: 'right answer' } },
    { type: 'message', message: { role: 'user', content: 'next user' } },
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: 'later wrong answer' } },
  ].map(v => JSON.stringify(v) + '\n').join(''));
  const before = fs.readFileSync(receipt, 'utf8');
  assert.deepEqual(await readPiTranscript(transcript, { id: 'm-wanted' }), { state: 'done', answer: 'right answer' });
  assert.deepEqual(await readPiTranscript(transcript, { id: 'm-missing' }), {});
  assert.equal(fs.readFileSync(receipt, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['receipt.json', 'session.jsonl']);
});

test('Pi tool and pending phases stay started until an explicitly final assistant response', async t => {
  const dir = folder(); t.after(() => removeFolder(dir));
  const file = path.join(dir, 'session.jsonl');
  const user = { type: 'message', message: { role: 'user', content: '[Agent Messenger · m-wanted]\nrequest' } };
  for (const stopReason of ['toolUse', 'pending', 'deferred']) {
    fs.writeFileSync(file, [user, { type: 'message', message: { role: 'assistant', stopReason,
      content: [{ type: 'text', text: 'I am checking files.' }, { type: 'toolCall', name: 'read' }] } }]
      .map(row => JSON.stringify(row) + '\n').join(''));
    assert.deepEqual(await readPiTranscript(file, { id: 'm-wanted' }), { state: 'started', answer: null });
    fs.appendFileSync(file, JSON.stringify({ type: 'message', message: {
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Verified final answer' }],
    } }) + '\n');
    assert.deepEqual(await readPiTranscript(file, { id: 'm-wanted' }), { state: 'done', answer: 'Verified final answer' });
  }
});

test('MCP get does not accept an adapter invented replyId as completion', async t => {
  const data = folder();
  const adapter = { client: 'codex', get: async id => ({ id: 'codex:' + id, rawId: id, client: 'codex', reachable: false }),
    read: async () => ({ state: 'replied', replyId: 'm-made-up' }) };
  const messenger = new Messenger({ data, passLimit: 10 }, [adapter], {});
  t.after(() => { messenger.close(); removeFolder(data); }); messenger.journal.reserve(record('m-owned'));
  const result = await messenger.get({ id: 'm-owned' }, { threadId: 'a' });
  assert.equal(result.state, 'expired');
  assert.equal(result.reply, null);
});

test('MCP persists a verified reply even when the original target reports expired', async t => {
  const data = folder(); let observation = { state: 'expired', reason: 'offline' };
  const adapter = { client: 'codex', get: async id => ({ id: 'codex:' + id, rawId: id, client: 'codex', reachable: false }),
    read: async () => observation };
  const messenger = new Messenger({ data, passLimit: 10 }, [adapter], {});
  t.after(() => { messenger.close(); removeFolder(data); });
  const parent = record('m-parent'); messenger.journal.reserve(parent);
  messenger.journal.reserve(record('m-reply', { replyTo: parent.id, fromId: parent.toId, toId: parent.fromId }));
  let response = await messenger.get({ id: parent.id }, { threadId: 'a' });
  assert.equal(response.state, 'replied'); assert.equal(messenger.journal.get(parent.id).state, 'replied');
  observation = { state: 'done', answer: 'late final answer' };
  response = await messenger.get({ id: parent.id }, { threadId: 'a' });
  assert.equal(response.state, 'replied'); assert.equal(response.answer, 'late final answer');
  assert.equal(messenger.journal.get(parent.id).state, 'replied');
});

test('a historical false replied state can be repaired and later receive a genuine reply', async t => {
  const data = folder();
  const adapter = { client: 'codex', get: async id => ({ id: 'codex:' + id, rawId: id, client: 'codex', reachable: true }),
    read: async () => ({ state: 'queued' }) };
  const messenger = new Messenger({ data, passLimit: 10 }, [adapter], {});
  t.after(() => { messenger.close(); removeFolder(data); });
  const parent = record('m-parent', { state: 'replied', replyId: 'm-missing' }); messenger.journal.reserve(parent);
  let response = await messenger.get({ id: parent.id }, { threadId: 'a' });
  assert.equal(response.state, 'expired');
  assert.equal(messenger.journal.get(parent.id).state, 'expired');
  assert.equal(messenger.journal.get(parent.id).replyId, null);
  messenger.journal.reserve(record('m-real', { replyTo: parent.id, fromId: parent.toId, toId: parent.fromId }));
  response = await messenger.get({ id: parent.id }, { threadId: 'a' });
  assert.equal(response.state, 'replied'); assert.equal(response.reply, 'm-real');
  messenger.journal.reserve(record('m-empty-pointer', { state: 'replied', replyId: null }));
  response = await messenger.get({ id: 'm-empty-pointer' }, { threadId: 'a' });
  assert.equal(response.state, 'expired');
  assert.equal(messenger.journal.get('m-empty-pointer').state, 'expired');
  messenger.journal.reserve(record('m-late-complete', { state: 'replied', replyId: 'm-false' }));
  adapter.read = async () => ({ state: 'done', answer: 'verified native answer' });
  response = await messenger.get({ id: 'm-late-complete' }, { threadId: 'a' });
  assert.equal(response.state, 'done'); assert.equal(response.answer, 'verified native answer');
  assert.equal(messenger.journal.get('m-late-complete').state, 'done');
  assert.equal(messenger.journal.get('m-late-complete').replyId, null);
});

test('dashboard finds exact replies outside the visible window and does not fabricate bodies or models', async t => {
  const data = folder(), j = new Journal(data);
  const parent = record('m-parent', { sentAt: 1000 }); j.reserve(parent);
  j.reserve(record('m-reply', { replyTo: parent.id, fromId: parent.toId, toId: parent.fromId, sentAt: 1 }));
  j.reserve(record('m-forwarded', { replyTo: parent.id, fromId: parent.toId, toId: 'codex:c', sentAt: 2000, state: 'done' }));
  for (let i = 0; i < 65; i++) j.reserve(record('m-filler-' + i, { sentAt: 2 + i }));
  j.update(parent.id, { replyId: 'm-not-real' });
  const adapter = { client: 'codex', list: async () => [{ id: 'codex:b', client: 'codex', state: 'running', reachable: null }],
    get: async () => ({ rawId: 'b', reachable: true }), read: async () => ({}), readPrompt: async () => null };
  const instance = startDashboardServer({ config: { data }, adapters: [adapter], port: 0 });
  t.after(async () => { await instance.close(); j.close(); removeFolder(data); });
  if (!instance.server.listening) await once(instance.server, 'listening');
  const response = await fetch(`http://127.0.0.1:${instance.server.address().port}/api/state`);
  const snapshot = await response.json(), item = snapshot.messages.find(m => m.id === parent.id);
  assert.equal(item.state, 'replied'); assert.equal(item.replyId, 'm-reply');
  assert.equal(item.text, null); assert.equal(snapshot.sessions[0].model, null);
  assert.match(snapshot.messages.find(m => m.id === 'm-forwarded').reason, /其他会话/);
});

test('dashboard distinguishes a missing target from a failed session lookup', async t => {
  const data = folder(), j = new Journal(data);
  j.reserve(record('m-missing')); let failLookup = false;
  const adapter = { client: 'codex', list: async () => [], get: async () => {
    if (failLookup) throw new Error('lookup unavailable');
    return null;
  }, read: async () => ({}) };
  const instance = startDashboardServer({ config: { data }, adapters: [adapter], port: 0 });
  t.after(async () => { await instance.close(); j.close(); removeFolder(data); });
  if (!instance.server.listening) await once(instance.server, 'listening');
  const url = `http://127.0.0.1:${instance.server.address().port}/api/state`;
  let snapshot = await (await fetch(url)).json();
  assert.equal(snapshot.messages[0].state, 'expired');
  failLookup = true; snapshot = await (await fetch(url)).json();
  assert.equal(snapshot.messages[0].state, 'queued');
  assert.match(snapshot.messages[0].reason, /无法读取目标会话/);
});

test('actual page reducer times and routes the active message instead of a later finished message', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('function buildChains('), html.indexOf('/* ---------- state ---------- */'));
  const build = vm.runInNewContext(source + ';buildChains', { firstLine: s => s });
  const chain = build([
    { id: 'first', chain: 'c', state: 'started', sentAt: 1, pass: 1, title: 'first', toClient: 'pi' },
    { id: 'last', chain: 'c', state: 'done', sentAt: 2, pass: 2, toClient: 'codex' },
  ])[0];
  assert.equal(chain.state, 'started'); assert.equal(chain.focus.id, 'first');
  assert.equal(chain.focus.toClient, 'pi'); assert.equal(chain.focus.sentAt, 1);
  const unconfirmed = build([
    { id: 'first', chain: 'c', state: 'expired', sentAt: 1, pass: 1, title: 'unconfirmed', toClient: 'antigravity' },
    { id: 'wrong-recipient', chain: 'c', state: 'done', sentAt: 2, pass: 2, toClient: 'codex' },
  ])[0];
  assert.equal(unconfirmed.state, 'expired');
  assert.equal(unconfirmed.focus.toClient, 'antigravity');
});

test('actual page load reports disconnection and keeps prior data without substituting demo messages', async () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('async function load()'), html.indexOf("if (location.protocol.startsWith('http'))"));
  const ui = { data: null }, snapshots = [];
  const load = vm.runInNewContext(source + ';load', { ui, ENDPOINT: '/api/state',
    fetch: async () => { throw new Error('offline'); },
    setData: data => { ui.data = data; snapshots.push(data); },
  });
  await load(); assert.equal(ui.disconnected, true); assert.equal(snapshots[0].messages.length, 0);
  const previous = { messages: [{ id: 'existing' }], sessions: [] }; ui.data = previous;
  await load(); assert.equal(snapshots[1], previous);
});

test('refreshing an empty active filter does not resurrect a hidden completed detail', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const filterDefs = html.slice(html.indexOf('const ACTIVE ='), html.indexOf('const STEPS ='));
  const build = html.slice(html.indexOf('function buildChains('), html.indexOf('/* ---------- state ---------- */'));
  const setData = html.slice(html.indexOf('function setData('), html.indexOf('/* ---------- render ---------- */'));
  const visible = html.slice(html.indexOf('function visibleChains('), html.indexOf('function renderTasks('));
  const ui = { filter: 'live', selected: null };
  const apply = vm.runInNewContext(filterDefs + build + setData + visible + ';setData', {
    ui, params: new URLSearchParams(), firstLine: s => s, render: () => {},
  });
  apply({ messages: [{ id: 'm-done', chain: 'c', state: 'done', sentAt: 1, pass: 1, title: 'done' }] }, true);
  assert.equal(ui.selected, null);
});
