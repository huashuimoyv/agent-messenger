import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Messenger } from '../src/messenger.mjs';
import { AntigravityAdapter } from '../src/adapters/antigravity.mjs';
import { PiAdapter } from '../src/adapters/pi.mjs';
import { atomicJson } from '../src/io.mjs';

test('self-describing 6th adapter plugs into Messenger without modifying core files', async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-ext-'));

  const delivered = [];
  const sessions = [
    { id: 'cursor:caller', rawId: 'caller', client: 'cursor', title: 'Caller', project: data, state: 'idle', reachable: true },
    { id: 'cursor:busy-1', rawId: 'busy-1', client: 'cursor', title: 'Busy', project: data, state: 'running', reachable: true, updatedAt: 200 },
    { id: 'cursor:idle-1', rawId: 'idle-1', client: 'cursor', title: 'IdleSameProj', project: data, state: 'idle', reachable: true, updatedAt: 100 },
  ];

  const cursorAdapter = {
    client: 'cursor',
    replyTool: 'mcp__cursor_messenger__send',
    canStart: true,
    identifyCaller: ({ meta }) => meta?.cursorId ? { client: 'cursor', rawId: meta.cursorId, turnId: null } : null,
    list: async () => sessions,
    get: async raw => sessions.find(s => s.rawId === raw) || null,
    capture: async () => ({}),
    current: async () => ({ text: 'user prompt' }),
    deliver: async (session, text, id) => { delivered.push({ to: session.id, text, id }); return { state: 'queued' }; },
    read: async () => ({}),
    start: async (folder, text, id) => ({ id: 'cursor:new-1', rawId: 'new-1', client: 'cursor', project: folder, deliveryState: 'queued', anchor: {} }),
  };

  const messenger = new Messenger({ data, passLimit: 10 }, [cursorAdapter], {});
  t.after(() => { messenger.close(); fs.rmSync(data, { recursive: true, force: true }); });

  assert.deepEqual(messenger.clientNames, ['cursor']);
  assert.deepEqual(messenger.startableClients, ['cursor']);

  const listed = await messenger.list({}, { cursorId: 'caller' });
  assert.deepEqual(listed.start_clients, ['cursor']);
  assert.equal(listed.sessions.find(s => s.id === 'cursor:caller').self, true);

  // Semantic target "cursor" selects reachable idle session in same project, skipping self and busy
  const sent = await messenger.send({ to: 'cursor', text: 'hello cursor' }, { cursorId: 'caller' });
  assert.equal(sent.state, 'queued');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].to, 'cursor:idle-1');
  assert.ok(delivered[0].text.includes('mcp__cursor_messenger__send'));

  // Dynamic start_session works for the new adapter
  const started = await messenger.start({ client: 'cursor', folder: data, text: 'boot' }, { cursorId: 'caller' });
  assert.equal(started.session_id, 'cursor:new-1');
});

test('event-driven wait_ms wakes up immediately on reply or transcript completion', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-wait-'));
  const transcript = path.join(root, 'target.jsonl');
  fs.writeFileSync(transcript, '');

  const sessions = [
    { id: 'codex:a', rawId: 'a', client: 'codex', title: 'A', project: root, state: 'idle', reachable: true },
    { id: 'codex:b', rawId: 'b', client: 'codex', title: 'B', project: root, state: 'idle', reachable: true, file: transcript },
  ];

  const adapter = {
    client: 'codex',
    watchPaths: s => [s?.file].filter(Boolean),
    list: async () => sessions,
    get: async id => sessions.find(s => s.rawId === id) || null,
    capture: async () => ({ path: transcript }),
    current: async () => ({ text: 'human prompt' }),
    deliver: async (_s, _text, id) => {
      setTimeout(() => {
        fs.appendFileSync(transcript, JSON.stringify({ id, answer: 'instant wakeup' }) + '\n');
      }, 60);
      return { state: 'queued' };
    },
    read: async (_s, record) => {
      const content = fs.readFileSync(transcript, 'utf8').trim();
      if (!content) return { state: 'queued' };
      const parsed = JSON.parse(content);
      return parsed.id === record.id ? { state: 'done', answer: parsed.answer } : { state: 'queued' };
    },
  };

  const messenger = new Messenger({ data: path.join(root, 'data'), passLimit: 10 }, [adapter], {});
  t.after(() => { messenger.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const t0 = Date.now();
  const res = await messenger.send({ to: 'codex:latest', text: 'ping', wait_ms: 5000 }, { threadId: 'a' });
  const elapsed = Date.now() - t0;

  assert.equal(res.state, 'done');
  assert.equal(res.answer, 'instant wakeup');
  assert.ok(elapsed < 1500, `expected fast fs.watch wakeup, got ${elapsed}ms`);
});

test('Antigravity caches endpoint discovery, self-heals on stale cache, and tail-reads >512KB transcripts', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-ag-perf-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const bigId = '11111111-2222-4333-8444-555555555555';
  const transcript = path.join(home, '.gemini', 'antigravity', 'brain', bigId, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });

  // Build >600KB transcript: head has title, middle has padding, tail has DONE response
  const firstLine = JSON.stringify({
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    step_index: 1,
    created_at: new Date(Date.now() - 5000).toISOString(),
    content: '<USER_REQUEST>Big Transcript Title</USER_REQUEST>',
  }) + '\n';
  const fillerLine = JSON.stringify({ type: 'GENERIC', step_index: 2, payload: 'x'.repeat(8192) }) + '\n';
  const lastLine = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    step_index: 99,
    created_at: new Date().toISOString(),
    status: 'DONE',
    content: 'Final tail answer',
  }) + '\n';
  const body = firstLine + fillerLine.repeat(75) + lastLine;
  assert.ok(Buffer.byteLength(body) > 512 * 1024);
  fs.writeFileSync(transcript, body);

  let discoverCount = 0;
  let activePort = 1001;
  const fastAdapter = new AntigravityAdapter({ home, data: path.join(home, 'data') }, {
    discover: async () => {
      discoverCount++;
      return [{ pid: 1, scheme: 'http', port: activePort, token: 't' }];
    },
    request: async (ep, method) => {
      if (ep.port !== activePort) throw new Error('ECONNREFUSED');
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { [bigId]: {} } };
      if (method === 'GetCascadeTrajectory') return { trajectory: { steps: [{ userInput: { userConfig: { plannerConfig: { planModel: 'MODEL_TEST' } } } }] } };
      if (method === 'SendUserCascadeMessage') return {};
      return {};
    },
  });

  const sessions = await fastAdapter.list({ limit: 5 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, 'Big Transcript Title');
  assert.equal(sessions[0].state, 'idle');
  const anchor = await fastAdapter.capture(sessions[0]);
  assert.equal(anchor.offset, Buffer.byteLength(body));

  // Second call hits endpoint cache (discoverCount stays 1)
  await fastAdapter.get(bigId);
  assert.equal(discoverCount, 1);

  // Simulate Antigravity restarting on a new port: deliver self-heals by re-discovering
  activePort = 2002;
  const receipt = await fastAdapter.deliver(sessions[0], '[Agent Messenger · m-heal]\nping', 'm-heal');
  assert.equal(receipt.state, 'queued');
  assert.equal(discoverCount, 2);
});

test('ended Pi session marks reachable false and refuses dead-letter delivery', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-pi-dead-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const piHome = path.join(root, 'pi'), piChannel = path.join(root, 'pi-channel');
  const id = '01a1026e-197c-715c-a547-dfdcd5dd08c4';
  const dir = path.join(piHome, 'sessions', '--E--Ameath--');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-10-03T15-42-12-348Z_${id}.jsonl`), JSON.stringify({ type: 'session', version: 3, id, cwd: root }) + '\n');

  atomicJson(path.join(piChannel, 'sessions', `${id}.json`), { ended: Date.now() });
  const adapter = new PiAdapter({ home: root, data: root, piHome, piChannel });
  const session = await adapter.get(id);
  assert.equal(session.reachable, false);
  await assert.rejects(adapter.deliver(session, 'msg', 'm-dead'), /ended|not running/);
});
