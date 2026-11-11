import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { CodexAdapter } from '../src/adapters/codex.mjs';

const THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ROLE_AGENT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const ARCHIVED = 'cccccccc-dddd-4eee-8fff-000000000000';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL,
    updated_at_ms INTEGER, cwd TEXT NOT NULL, title TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0, agent_role TEXT, agent_nickname TEXT, source TEXT NOT NULL, history_mode TEXT NOT NULL DEFAULT 'legacy'
  )`);
  db.close();
  const config = { home: root, codexHome, codexExecutable: process.execPath };
  return { root, codexHome, config };
}

function rollout(home, id = THREAD, compressed = false) {
  const folder = path.join(home, 'sessions', '2026', '11', '11');
  fs.mkdirSync(folder, { recursive: true });
  return path.join(folder, `rollout-2026-11-11T01-00-00-${id}.jsonl${compressed ? '.zst' : ''}`);
}

function addThread(home, id, file, extra = {}) {
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.prepare(`INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms, cwd, title, archived, agent_role, agent_nickname, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, file, 1_800_000_000, Date.now(), extra.cwd || path.dirname(file), extra.title || 'Fixture thread',
      extra.archived || 0, extra.agent_role || null, extra.agent_nickname || null, extra.source || '{}');
  db.close();
}

function appendRows(file, rows) {
  fs.appendFileSync(file, rows.map(value => `${JSON.stringify(value)}\n`).join(''));
}

function fakeAppServer(t, responses = {}) {
  const requests = [];
  let optionsSeen;
  const launch = (_executable, args, options) => {
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
    optionsSeen = options;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.stdin.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        if (!request.id) continue;
        const response = responses[request.method] || (request.method === 'thread/start'
          ? { thread: { id: THREAD } }
          : request.method === 'thread/queue/add' ? { queuedSubmission: { id: 'queued' } } : {});
        child.stdout.write(`${JSON.stringify({ id: request.id, result: response })}\n`);
      }
    });
    child.kill = () => {
      if (child.exitCode !== null) return false;
      child.exitCode = 0;
      child.stdin.end(); child.stdout.end();
      child.emit('exit', 0, null);
      return true;
    };
    child.unref = () => {};
    child.stdin.on('finish', () => child.kill());
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return child;
  };
  return { launch, requests, options: () => optionsSeen };
}

test('discovers main threads from the read-only state database and reads lifecycle state', async t => {
  const f = fixture(t), file = rollout(f.codexHome);
  appendRows(file, [
    { type: 'session_meta', payload: { id: THREAD, cwd: f.root, source: { subagent: null } } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ]);
  addThread(f.codexHome, THREAD, file, { cwd: f.root, title: 'Fixture title' });
  addThread(f.codexHome, OTHER, file, { title: 'Guardian', source: JSON.stringify({ subagent: { other: 'guardian' } }) });
  addThread(f.codexHome, ROLE_AGENT, file, { title: 'Worker', agent_role: 'worker' });
  addThread(f.codexHome, ARCHIVED, file, { title: 'Archived', archived: 1 });
  const adapter = new CodexAdapter(f.config);
  const sessions = await adapter.list({ limit: 10 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, `codex:${THREAD}`);
  assert.equal(sessions[0].rawId, THREAD);
  assert.equal(sessions[0].title, 'Fixture title');
  assert.equal(sessions[0].project, f.root);
  assert.equal(sessions[0].state, 'idle');
  assert.equal((await adapter.get(THREAD)).id, sessions[0].id);
  assert.equal(await adapter.get(OTHER), null);
  assert.equal(await adapter.get(ROLE_AGENT), null);
  assert.equal((await adapter.get(ARCHIVED)).id, `codex:${ARCHIVED}`);
});

test('capture anchors at the last complete line and read waits for the exact turn completion', async t => {
  const f = fixture(t), file = rollout(f.codexHome);
  appendRows(file, [{ type: 'session_meta', payload: { id: THREAD, cwd: f.root } }]);
  addThread(f.codexHome, THREAD, file, { cwd: f.root });
  const adapter = new CodexAdapter(f.config), session = await adapter.get(THREAD);
  fs.appendFileSync(file, '{"type":"unfinished"');
  const anchor = await adapter.capture(session);
  assert.equal(anchor.offset, Buffer.byteLength(`${JSON.stringify({ type: 'session_meta', payload: { id: THREAD, cwd: f.root } })}\n`));
  fs.truncateSync(file, anchor.offset);

  appendRows(file, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-human' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A person cited m-wanted in a normal sentence.' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-human', last_agent_message: 'not this answer either' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Agent Messenger · from codex · m-wanted]\nReview this.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'progress only' }] } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-unrelated' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Agent Messenger · m-other]\nOther message.' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-unrelated', last_agent_message: 'not this answer' } },
  ]);
  let reply = await adapter.read(await adapter.get(THREAD), { id: 'm-wanted', anchor });
  assert.equal(reply.state, 'started');
  assert.equal(reply.turn, 'turn-2');

  appendRows(file, [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: 'The final answer.' } }]);
  reply = await adapter.read(await adapter.get(THREAD), { id: 'm-wanted', anchor });
  assert.equal(reply.state, 'done');
  assert.equal(reply.answer, 'The final answer.');
  assert.equal(reply.turn, 'turn-2');
});

test('current prompt is bound to the requested Codex turn', async t => {
  const f = fixture(t), file = rollout(f.codexHome);
  appendRows(file, [
    { type: 'session_meta', payload: { id: THREAD, cwd: f.root } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-old' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'older prompt' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-old' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-current' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'current prompt' }] } },
  ]);
  addThread(f.codexHome, THREAD, file);
  const adapter = new CodexAdapter(f.config), session = await adapter.get(THREAD);
  assert.deepEqual(await adapter.current(session, 'turn-current'), { text: 'current prompt', turnId: 'turn-current' });
  assert.equal(await adapter.current(session, 'missing'), null);
});

test('a target abort with no answer cannot borrow a later turn final answer', async t => {
  const f = fixture(t), file = rollout(f.codexHome);
  appendRows(file, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'target' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: '[Agent Messenger · m-abort]\nquestion' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'other' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'other', last_agent_message: 'wrong answer' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'target' } },
  ]);
  addThread(f.codexHome, THREAD, file);
  const adapter = new CodexAdapter(f.config);
  const observed = await adapter.read(await adapter.get(THREAD), { id: 'm-abort', anchor: {} });
  assert.equal(observed.state, 'done'); assert.equal(observed.answer, null);
});

test('decompresses Codex rollout archives with an uncompressed byte cursor', async t => {
  const f = fixture(t), file = rollout(f.codexHome, THREAD, true);
  const lines = [
    { type: 'session_meta', payload: { id: THREAD } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-zstd' } },
  ].map(value => `${JSON.stringify(value)}\n`).join('');
  fs.writeFileSync(file, zstdCompressSync(Buffer.from(lines)));
  addThread(f.codexHome, THREAD, file);
  const adapter = new CodexAdapter(f.config), session = await adapter.get(THREAD);
  assert.deepEqual(await adapter.capture(session), { path: file, offset: Buffer.byteLength(lines) });
});

test('delivery uses app-server JSON-RPC; start queues then wakes while preserving the thread id', async t => {
  const f = fixture(t), project = path.join(f.root, 'project');
  fs.mkdirSync(project);
  const fake = fakeAppServer(t);
  const adapter = new CodexAdapter({ ...f.config, spawn: fake.launch, openUrl: async url => url === `codex://threads/wake/${THREAD}` ? false : false });
  const session = await adapter.start(project, '[Agent Messenger · m-start]\nStart this task.', 'm-start');
  assert.equal(session.id, `codex:${THREAD}`);
  assert.equal(session.deliveryState, 'queued');
  assert.match(session.reason, /could not be opened automatically/);
  assert.deepEqual(fake.requests.filter(request => request.method).map(request => request.method), [
    'initialize', 'initialized', 'thread/start', 'thread/name/set', 'initialize', 'initialized', 'thread/queue/add',
  ]);
  assert.equal(fake.requests.find(request => request.method === 'thread/queue/add').params.clientUserMessageId, 'agent-messenger:m-start');
  assert.deepEqual(fake.options().stdio, ['pipe', 'pipe', 'ignore']);
  assert.equal(fake.options().windowsHide, true);
});

test('existing-thread delivery reports a confirmed queue receipt', async t => {
  const f = fixture(t), fake = fakeAppServer(t), file = rollout(f.codexHome);
  appendRows(file, [{ type: 'session_meta', payload: { id: THREAD } }]);
  addThread(f.codexHome, THREAD, file);
  let woke = null;
  const adapter = new CodexAdapter({ ...f.config, spawn: fake.launch, openUrl: async url => { woke = url; return true; } });
  const receipt = await adapter.deliver({ rawId: THREAD }, 'message body', 'm-send');
  assert.deepEqual(receipt, { state: 'queued' });
  assert.equal(woke, `codex://threads/wake/${THREAD}`);
  assert.deepEqual(fake.requests.find(request => request.method === 'thread/queue/add').params.input, [
    { type: 'text', text: 'message body', text_elements: [] },
  ]);
});

test('app-server startup errors are refused and an EPIPE after queue write stays uncertain', async t => {
  const f = fixture(t);
  const launchFailing = failAt => (_executable, _args, _options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.stdin.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (!line) continue;
        const request = JSON.parse(line);
        if (!request.id) continue;
        if (failAt === 'startup' && request.method === 'initialize') {
          setImmediate(() => child.emit('error', new Error('native process startup error')));
        } else if (failAt === 'pipe' && request.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        } else if (failAt === 'pipe' && request.method === 'thread/queue/add') {
          setImmediate(() => child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
        }
      }
    });
    child.kill = () => {
      if (child.exitCode !== null) return false;
      child.exitCode = 0; child.stdin.end(); child.stdout.end(); child.emit('exit', 0, null); return true;
    };
    return child;
  };
  const startup = new CodexAdapter({ ...f.config, spawn: launchFailing('startup') });
  await assert.rejects(startup.deliver({ rawId: THREAD }, 'body', 'm-startup'), error => error.state === 'refused');

  const pipe = new CodexAdapter({ ...f.config, spawn: launchFailing('pipe') });
  await assert.rejects(pipe.deliver({ rawId: THREAD }, 'body', 'm-pipe'), error => error.state === 'uncertain');
});
