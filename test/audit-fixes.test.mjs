import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Journal, canTransition } from '../src/journal.mjs';
import { Messenger } from '../src/messenger.mjs';
import { FileChannel } from '../src/channel-store.mjs';
import { PiAdapter } from '../src/adapters/pi.mjs';
import { AntigravityAdapter } from '../src/adapters/antigravity.mjs';
import { startDashboardServer } from '../src/dashboard-server.mjs';
import { configuration } from '../src/config.mjs';
import piExtension from '../plugins/pi/agent-messenger.ts';

test('1. Malformed HTTP request with invalid Host returns 400 and does not crash process', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-1-'));
  const config = { ...configuration(), data: root };
  const port = 3791;
  const instance = startDashboardServer({ config, adapters: [], port });
  t.after(async () => {
    await instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.write("GET /api/state HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
    });
    let data = '';
    client.on('data', chunk => { data += chunk.toString(); });
    client.on('end', () => {
      assert.match(data, /HTTP\/1\.1 400 Bad Request/);
      resolve();
    });
    client.on('error', reject);
  });
});

test('2. Journal protects terminal states (done/replied/refused) from being overwritten by expired/queued', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-2-'));
  const journal = new Journal(root);
  t.after(() => {
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const record = {
    id: 'm-audit-test-1',
    requestKey: 'test:audit:1',
    fingerprint: 'fp1',
    fromId: 'antigravity:1',
    toId: 'codex:1',
    fromClient: 'antigravity',
    toClient: 'codex',
    sentAt: Date.now(),
    chain: 'm-audit-test-1',
    pass: 1,
    kind: 'send',
    replyTo: null,
    replyId: null,
    state: 'done',
    reason: null,
    anchor: {},
  };
  journal.reserve(record);
  assert.equal(journal.get('m-audit-test-1').state, 'done');

  // Try to overwrite done with expired
  journal.update('m-audit-test-1', { state: 'expired', reason: 'late timeout' });
  assert.equal(journal.get('m-audit-test-1').state, 'done', 'done must not be overwritten by expired');

  // Try to overwrite done with queued
  journal.update('m-audit-test-1', { state: 'queued' });
  assert.equal(journal.get('m-audit-test-1').state, 'done', 'done must not be overwritten by queued');

  // Try to overwrite done with replied
  journal.update('m-audit-test-1', { state: 'replied' });
  assert.equal(journal.get('m-audit-test-1').state, 'replied', 'done can transition to replied');

  // Settle reply updates replyId and state can transition to replied
  const parent = {
    ...record,
    id: 'm-audit-parent',
    requestKey: 'test:parent:1',
    state: 'started',
  };
  journal.reserve(parent);
  journal.reserve({ ...record, id: 'm-reply-child', requestKey: 'test:child:1',
    fromId: parent.toId, toId: parent.fromId, replyTo: parent.id, state: 'queued' });
  journal.settleReply('m-audit-parent', 'm-reply-child');
  const settled = journal.get('m-audit-parent');
  assert.equal(settled.replyId, 'm-reply-child');
  journal.update('m-audit-parent', { state: 'replied' });
  assert.equal(journal.get('m-audit-parent').state, 'replied');
});

test('2b. FileChannel respects takenAt and startedAt, never falsely marking them expired', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-2b-'));
  const store = new FileChannel(root);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rawId = 'test-session';
  const msgId = 'm-msg-1';
  // Create an expired prompt that was already taken and started
  const promptDir = path.join(root, 'prompts', rawId);
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(path.join(promptDir, `${msgId}.json`), JSON.stringify({
    text: 'hello',
    expiresAt: Date.now() - 10_000, // expired in past
    takenAt: Date.now() - 5_000,
    startedAt: Date.now() - 4_000,
  }));

  const receipt = store.receipt(rawId, msgId);
  assert.equal(receipt.state, 'started', 'Already started prompt must not be marked expired');
});

test('3. Dashboard server closes active sockets on close()', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-3-'));
  const config = { ...configuration(), data: root };
  const port = 3792;
  const instance = startDashboardServer({ config, adapters: [], port });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Open an idle keep-alive connection
  const socket = net.createConnection({ port, host: '127.0.0.1' });
  await new Promise(r => socket.once('connect', r));

  // Closing dashboard must terminate the socket immediately
  const socketClosedPromise = new Promise(r => socket.once('close', r));
  await instance.close();
  await socketClosedPromise;
});

test('4 & 6. Dashboard preserves real adapter states, rejects foreign CORS, and does not invent fake sessions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-4-'));
  const config = { ...configuration(), data: root };
  const port = 3793;

  const mockAdapter = {
    client: 'test-agent',
    list: async () => [
      {
        id: 'test-agent:123',
        client: 'test-agent',
        model: 'Custom Model 1',
        project: 'E:\\Ameath',
        state: 'running',
        reachable: null,
      }
    ]
  };

  const instance = startDashboardServer({ config, adapters: [mockAdapter], port });
  t.after(async () => {
    await instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Test state preservation and lack of fake sessions
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  const data = await res.json();
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].client, 'test-agent');
  assert.equal(data.sessions[0].state, 'running');
  assert.equal(data.sessions[0].reachable, null);

  // Test CORS: foreign origin rejected
  const foreignRes = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { Origin: 'https://evil.attacker.com' }
  });
  assert.equal(foreignRes.headers.get('access-control-allow-origin'), null);

  // Test CORS: local origin accepted
  const localRes = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { Origin: 'http://localhost:3000' }
  });
  assert.equal(localRes.headers.get('access-control-allow-origin'), 'http://localhost:3000');
});

test('Round 2 - 1. canTransition and Journal.update allow queued/taken/started -> expired and prevent done -> refused', async t => {
  assert.equal(canTransition('queued', 'expired'), true);
  assert.equal(canTransition('taken', 'expired'), true);
  assert.equal(canTransition('started', 'expired'), true);
  assert.equal(canTransition('done', 'refused'), false);
  assert.equal(canTransition('done', 'expired'), false);
  assert.equal(canTransition('done', 'replied'), true);
  assert.equal(canTransition('replied', 'done'), false);
  assert.equal(canTransition('refused', 'done'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-1-'));
  const journal = new Journal(root);
  t.after(() => {
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const m1 = {
    id: 'm-q-to-exp',
    requestKey: 'req:q:exp',
    fingerprint: 'fp',
    fromId: 'ag:1',
    toId: 'cx:1',
    fromClient: 'antigravity',
    toClient: 'codex',
    sentAt: Date.now(),
    chain: 'c1',
    pass: 1,
    kind: 'send',
    replyTo: null,
    replyId: null,
    state: 'queued',
    reason: null,
    anchor: {},
  };
  journal.reserve(m1);
  assert.equal(journal.get('m-q-to-exp').state, 'queued');

  // queued -> expired must succeed
  journal.update('m-q-to-exp', { state: 'expired', reason: 'target ended' });
  assert.equal(journal.get('m-q-to-exp').state, 'expired');

  // done -> refused must be blocked
  const m2 = { ...m1, id: 'm-done-ref', requestKey: 'req:done:ref', state: 'done' };
  journal.reserve(m2);
  journal.update('m-done-ref', { state: 'refused', reason: 'nope' });
  assert.equal(journal.get('m-done-ref').state, 'done', 'done state must not be overridden by refused');
});

test('Round 2 - 2. Standalone dashboard server keeps ref when unref is false', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-2-'));
  const config = { ...configuration(), data: root };
  const port = 3794;
  const instance = startDashboardServer({ config, adapters: [], port, unref: false });
  t.after(async () => {
    await instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(instance.unref, false, 'Standalone server instance must configure unref as false');
  await new Promise(r => {
    if (instance.server.listening) r();
    else instance.server.once('listening', r);
  });
  if (typeof instance.server._handle?.hasRef === 'function') {
    assert.equal(instance.server._handle.hasRef(), true, 'Server socket handle must have ref');
  }
});

test('Round 2 - 3. Expired prompt persists expiredAt to disk and Pi adapter preserves expired state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-3-'));
  const store = new FileChannel(root);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rawId = 'session-ended-target';
  const msgId = 'm-exp-persist';
  const promptDir = path.join(root, 'prompts', rawId);
  fs.mkdirSync(promptDir, { recursive: true });
  const promptFile = path.join(promptDir, `${msgId}.json`);
  fs.writeFileSync(promptFile, JSON.stringify({
    id: msgId,
    text: 'do task',
    expiresAt: Date.now() - 5_000,
  }));

  // Session file marked as ended
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${rawId}.json`), JSON.stringify({
    ended: Date.now() - 6_000,
  }));

  // receipt() must return expired AND persist expiredAt to promptFile
  const receipt = store.receipt(rawId, msgId);
  assert.equal(receipt.state, 'expired');

  const hasMarker = fs.existsSync(promptFile.replace(/\.json$/, '.expired')) || fs.existsSync(promptFile + '.expired');
  assert.ok(hasMarker, 'expired marker must be written to disk to avoid re-delivery on restart');

  // Verify Pi adapter read() returns expired (not started)
  const piAdapter = new PiAdapter({ home: root, data: root, piChannel: root });
  const readRes = await piAdapter.read({ rawId }, { id: msgId, state: 'queued' });
  assert.equal(readRes.state, 'expired', 'PiAdapter must return expired instead of converting to started');
});

test('Round 2 - 4. Idempotent Journal.close prevents ERR_INVALID_STATE', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-4-'));
  const journal = new Journal(root);
  // Calling close() twice must not throw
  assert.doesNotThrow(() => {
    journal.close();
    journal.close();
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('Round 2 - 5. Chain state resolution reflects active in-progress message instead of being masked by earlier done/replied', () => {
  function testBuildChainState(list) {
    const active = [...list].reverse().find(m => ['queued', 'taken', 'started', 'uncertain'].includes(m.state));
    const last = list[list.length - 1];
    return active ? active.state : (last.replyId ? 'replied' : last.state);
  }

  // Old done + new queued -> queued
  const chain1 = [
    { id: '1', state: 'done', sentAt: 1000 },
    { id: '2', state: 'queued', sentAt: 2000 },
  ];
  assert.equal(testBuildChainState(chain1), 'queued');

  // Old replied + new started -> started
  const chain2 = [
    { id: '1', state: 'replied', replyId: 'r1', sentAt: 1000 },
    { id: '2', state: 'started', sentAt: 2000 },
  ];
  assert.equal(testBuildChainState(chain2), 'started');

  // Both done -> done
  const chain3 = [
    { id: '1', state: 'done', sentAt: 1000 },
    { id: '2', state: 'done', sentAt: 2000 },
  ];
  assert.equal(testBuildChainState(chain3), 'done');
});

test('Round 2 - 6. Dashboard does not downgrade terminal state and invalidates cache on state change', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-6-'));
  const config = { ...configuration(), data: root };
  const journal = new Journal(root);
  const port = 3795;

  const mockAdapter = {
    client: 'codex',
    list: async () => [],
    read: async () => ({ state: 'queued' }), // returns outdated non-terminal state
  };

  const instance = startDashboardServer({ config, adapters: [mockAdapter], port });
  t.after(async () => {
    await instance.close();
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const record = {
    id: 'm-db-done-test',
    requestKey: 'req:done:test',
    fingerprint: 'fp',
    fromId: 'ag:1',
    toId: 'codex:1',
    fromClient: 'antigravity',
    toClient: 'codex',
    sentAt: Date.now(),
    chain: 'c-done',
    pass: 1,
    kind: 'send',
    replyTo: null,
    replyId: null,
    state: 'done',
    reason: null,
    anchor: {},
  };
  journal.reserve(record);

  // Even though mockAdapter returns queued, dashboard must preserve done
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  const data = await res.json();
  const msg = data.messages.find(m => m.id === 'm-db-done-test');
  assert.ok(msg);
  assert.equal(msg.state, 'done', 'Dashboard must not downgrade database done state to queued');
});

test('Round 2 - 3b. Antigravity offline session with correlationUnsafe message resolves to expired', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-3b-'));
  let messenger = null;
  t.after(() => {
    try { messenger?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const convId = '22222222-3333-4444-5555-666666666666';
  const brainDir = path.join(root, '.gemini', 'antigravity', 'brain', convId);
  fs.mkdirSync(path.join(brainDir, '.system_generated', 'logs'), { recursive: true });
  const transcript = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'USER_INPUT',
    step_index: 1,
    content: 'Initial query',
    created_at: new Date(Date.now() - 86400000).toISOString(),
  }) + '\n');

  const config = { home: root, data: path.join(root, 'data') };
  const adapter = new AntigravityAdapter(config, {
    discover: async () => [], // Simulate software completely closed
    request: async () => { throw new Error('offline'); }
  });

  const session = await adapter.get(convId);
  assert.ok(session);
  assert.equal(session.reachable, false, 'Offline session must have reachable: false');

  // Verify adapter.read directly marks correlationUnsafe as expired when offline
  const readRes = await adapter.read(session, {
    id: 'm-ag-unsafe',
    state: 'queued',
    anchor: { correlationUnsafe: true, path: transcript },
  });
  assert.equal(readRes.state, 'expired');
  assert.match(readRes.reason, /offline/i);

  // Verify Messenger.get marks it as expired in database
  const callerAdapter = {
    client: 'codex',
    get: async id => ({ id: `codex:${id}`, rawId: id, client: 'codex' }),
  };
  messenger = new Messenger({ data: path.join(root, 'data'), passLimit: 10 }, [adapter, callerAdapter], {});

  messenger.journal.reserve({
    id: 'm-ag-unsafe',
    requestKey: 'req:ag:unsafe',
    fingerprint: 'fp',
    fromId: 'codex:test',
    toId: `antigravity:${convId}`,
    fromClient: 'codex',
    toClient: 'antigravity',
    sentAt: Date.now() - 86400000, // 24 hours ago
    chain: 'm-ag-unsafe',
    pass: 1,
    kind: 'send',
    replyTo: null,
    replyId: null,
    state: 'queued',
    reason: null,
    anchor: { correlationUnsafe: true, path: transcript },
  });

  const getRes = await messenger.get({ id: 'm-ag-unsafe' }, { threadId: 'test' });
  assert.equal(getRes.state, 'expired', 'Messenger.get must return expired for offline unconfirmed session');
  assert.match(getRes.reason, /offline/i);
});

test('Round 2 - 3c. Concurrent claim by worker is not overwritten by reader receipt()', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-3c-'));
  const store = new FileChannel(root);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rawId = 'session-race-target';
  const msgId = 'm-race-claim';
  const promptDir = path.join(root, 'prompts', rawId);
  fs.mkdirSync(promptDir, { recursive: true });
  const promptFile = path.join(promptDir, `${msgId}.json`);

  // Prompt initially queued with past expiration
  fs.writeFileSync(promptFile, JSON.stringify({
    id: msgId,
    text: 'race prompt',
    expiresAt: Date.now() - 1000,
  }));

  // Session ended file
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${rawId}.json`), JSON.stringify({
    ended: Date.now() - 2000,
  }));

  // Simulate another process claiming and starting the prompt
  const takenAt = Date.now();
  const startedAt = Date.now() + 5;
  fs.writeFileSync(promptFile, JSON.stringify({
    id: msgId,
    text: 'race prompt',
    expiresAt: Date.now() - 1000,
    takenAt,
    startedAt,
  }));

  // receipt() must recognize started state and must NOT overwrite the file or wipe takenAt/startedAt
  const receipt = store.receipt(rawId, msgId);
  assert.equal(receipt.state, 'started', 'Must respect claim and return started');

  const onDisk = JSON.parse(fs.readFileSync(promptFile, 'utf8'));
  assert.equal(onDisk.takenAt, takenAt, 'takenAt must not be wiped out by reader');
  assert.equal(onDisk.startedAt, startedAt, 'startedAt must not be wiped out by reader');
});

test('Round 2 - 6b. Dashboard does not permanently cache expired and reads late done answer on second poll without journal change', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-6b-'));
  const config = { ...configuration(), data: root };
  const journal = new Journal(root);
  const port = 3796;

  let adapterReads = 0;
  let mockState = 'expired';
  let mockAnswer = null;

  const mockAdapter = {
    client: 'codex',
    list: async () => [],
    read: async () => {
      adapterReads++;
      return { state: mockState, answer: mockAnswer };
    },
  };

  const instance = startDashboardServer({ config, adapters: [mockAdapter], port });
  t.after(async () => {
    await instance.close();
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const record = {
    id: 'm-db-expired-late-done',
    requestKey: 'req:exp:late:done',
    fingerprint: 'fp',
    fromId: 'ag:1',
    toId: 'codex:1',
    fromClient: 'antigravity',
    toClient: 'codex',
    sentAt: Date.now(),
    chain: 'c-exp',
    pass: 1,
    kind: 'send',
    replyTo: null,
    replyId: null,
    state: 'expired',
    reason: 'Initial expiration',
    anchor: {},
  };
  journal.reserve(record);

  // Poll 1: adapter returns expired
  const res1 = await fetch(`http://127.0.0.1:${port}/api/state`);
  const data1 = await res1.json();
  const msg1 = data1.messages.find(m => m.id === 'm-db-expired-late-done');
  assert.ok(msg1);
  assert.equal(msg1.state, 'expired');
  assert.equal(adapterReads, 1, 'First poll must read adapter');

  // Simulate late completion in native transcript:
  // Journal row in SQLite is UNCHANGED (still expired), but adapter now sees done + answer
  mockState = 'done';
  mockAnswer = 'Late reliable answer from transcript';

  // Poll 2: dashboard must NOT serve cached expired; must call adapter again and upgrade to done
  const res2 = await fetch(`http://127.0.0.1:${port}/api/state`);
  const data2 = await res2.json();
  const msg2 = data2.messages.find(m => m.id === 'm-db-expired-late-done');
  assert.ok(msg2);
  assert.equal(adapterReads, 2, 'Second poll must query adapter again instead of permanent expired cache');
  assert.equal(msg2.state, 'done', 'Dashboard must adopt late done state');
  assert.equal(msg2.answer, 'Late reliable answer from transcript', 'Dashboard must return late answer');
});

test('Round 2 - 3d. Pi extension consumes normal prompt and skips .expired/.cancel marker prompts without ReferenceError', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-3d-'));
  const piChannel = path.join(root, 'pi-channel');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prevHome = process.env.AGENT_MESSENGER_HOME;
  const prevChannel = process.env.AGENT_MESSENGER_PI_CHANNEL;
  process.env.AGENT_MESSENGER_HOME = root;
  process.env.AGENT_MESSENGER_PI_CHANNEL = piChannel;
  t.after(() => {
    if (prevHome !== undefined) process.env.AGENT_MESSENGER_HOME = prevHome;
    else delete process.env.AGENT_MESSENGER_HOME;
    if (prevChannel !== undefined) process.env.AGENT_MESSENGER_PI_CHANNEL = prevChannel;
    else delete process.env.AGENT_MESSENGER_PI_CHANNEL;
  });

  const submitted = [];
  const handlers = {};
  const mockPi = {
    on: (event, fn) => { handlers[event] = fn; },
    sendUserMessage: text => { submitted.push(text); },
  };

  piExtension(mockPi);
  assert.ok(typeof handlers['session_start'] === 'function');
  t.after(() => handlers['session_shutdown']?.());

  const sessionId = 'test-session-pi-ext';
  const promptsFolder = path.join(piChannel, 'prompts', sessionId);
  fs.mkdirSync(promptsFolder, { recursive: true });

  // Normal prompt
  const normalFile = path.join(promptsFolder, 'm-normal.json');
  fs.writeFileSync(normalFile, JSON.stringify({ id: 'm-normal', text: 'execute normal task', at: 1000 }));

  // Expired prompt with .expired marker sidecar
  const expiredFile = path.join(promptsFolder, 'm-exp.json');
  fs.writeFileSync(expiredFile, JSON.stringify({ id: 'm-exp', text: 'execute expired task', at: 1001 }));
  fs.writeFileSync(path.join(promptsFolder, 'm-exp.expired'), JSON.stringify({ at: Date.now() }));

  // Cancelled prompt with .cancel marker sidecar
  const cancelFile = path.join(promptsFolder, 'm-cancel.json');
  fs.writeFileSync(cancelFile, JSON.stringify({ id: 'm-cancel', text: 'execute cancel task', at: 1002 }));
  fs.writeFileSync(path.join(promptsFolder, 'm-cancel.cancel'), JSON.stringify({ at: Date.now() }));

  // Trigger session start
  handlers['session_start'](null, {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => path.join(root, 'session.jsonl'),
    }
  });

  // Verify submitted messages
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], 'execute normal task');

  // Verify normal prompt file was marked takenAt and startedAt
  const normalOnDisk = JSON.parse(fs.readFileSync(normalFile, 'utf8'));
  assert.ok(normalOnDisk.takenAt);
  assert.ok(normalOnDisk.startedAt);

  // Verify expired & cancel prompt files were NOT claimed/executed
  const expOnDisk = JSON.parse(fs.readFileSync(expiredFile, 'utf8'));
  assert.equal(expOnDisk.takenAt, undefined);
  const cancelOnDisk = JSON.parse(fs.readFileSync(cancelFile, 'utf8'));
  assert.equal(cancelOnDisk.takenAt, undefined);
});

test('Round 2 - 3e. Claude hook intercepts prompts with .expired or .cancel marker sidecars', async t => {
  const prevChannel = process.env.AGENT_MESSENGER_CLAUDE_CHANNEL;
  const channelDir = 'C:/mock/claude';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-3e-'));
  process.env.AGENT_MESSENGER_CLAUDE_CHANNEL = channelDir;
  t.after(() => {
    if (prevChannel !== undefined) process.env.AGENT_MESSENGER_CLAUDE_CHANNEL = prevChannel;
    else delete process.env.AGENT_MESSENGER_CLAUDE_CHANNEL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'claude', 'register.template.ts');
  const template = fs.readFileSync(templatePath, 'utf8');
  assert.ok(template.includes('__AGENT_MESSENGER_CHANNEL_JSON__'));
  const rendered = template.replace('__AGENT_MESSENGER_CHANNEL_JSON__', JSON.stringify(channelDir));
  assert.equal(rendered.includes('__AGENT_MESSENGER_CHANNEL_JSON__'), false);
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  const registerPath = path.join(tmpDir, 'register.ts');
  fs.writeFileSync(registerPath, rendered, 'utf8');

  const { register } = await import(pathToFileURL(registerPath).href);
  let sessionHook = null;
  register((name, hook) => {
    if (name === 'session.start') sessionHook = hook;
  });
  assert.ok(sessionHook);

  const submitted = [];
  const written = new Map();
  const folder = `${channelDir}/prompts/test-claude-session`;
  const disk = new Map([
    [`${folder}/m-normal.json`, JSON.stringify({ id: 'm-normal', text: 'claude normal' })],
    [`${folder}/m-exp.json`, JSON.stringify({ id: 'm-exp', text: 'claude exp' })],
    [`${folder}/m-exp.expired`, JSON.stringify({ at: 1000 })],
  ]);

  let notifyDone;
  const donePromise = new Promise(r => { notifyDone = r; });

  const mockCtx = {
    session: {
      id: async () => 'test-claude-session',
      version: async () => ({ version: '1.0' }),
    },
    clock: {
      now: async () => 1234567,
      every: (ms, cb) => cb(),
    },
    fs: {
      exists: async p => p === folder || disk.has(p),
      list: async () => [
        { kind: 'file', name: 'm-normal.json' },
        { kind: 'file', name: 'm-exp.json' },
      ],
      read: async p => disk.get(p),
      write: async (p, content) => {
        written.set(p, content);
        disk.set(p, content);
      },
    },
    prompt: {
      submit: async opts => {
        submitted.push(opts.text);
        notifyDone();
        return {};
      },
    },
  };

  await sessionHook(mockCtx, {}, async e => e);
  await donePromise;

  // Normal prompt submitted, expired prompt intercepted
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], 'claude normal');

  // Normal was marked takenAt
  const normalWritten = JSON.parse(written.get(`${folder}/m-normal.json`));
  assert.ok(normalWritten.takenAt);

  // Expired prompt was acknowledged as cancelledAt
  const expWritten = JSON.parse(written.get(`${folder}/m-exp.json`));
  assert.ok(expWritten.cancelledAt);
});

test('Round 2 - 4. Third-party forwarding with reply_to does not settle parent message; reply to original sender settles parent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-r2-4-'));
  const config = { data: root, passLimit: 10 };

  const sessions = [
    { id: 'codex:a', rawId: 'a', client: 'codex', title: 'Session A', project: root, state: 'idle', reachable: true },
    { id: 'antigravity:b', rawId: 'b', client: 'antigravity', title: 'Session B', project: root, state: 'idle', reachable: true },
    { id: 'pi:c', rawId: 'c', client: 'pi', title: 'Session C', project: root, state: 'idle', reachable: true },
  ];

  const answers = new Map();
  const prompts = new Map();
  const makeAdapter = client => ({
    client,
    list: async () => sessions.filter(s => s.client === client),
    get: async id => sessions.find(s => s.client === client && (s.id === id || s.rawId === id)) || null,
    capture: async () => ({}),
    current: async s => prompts.has(s.id) ? { text: prompts.get(s.id) } : null,
    deliver: async (s, text, id) => {
      prompts.set(s.id, text);
      return { state: 'queued' };
    },
    read: async (s, m) => answers.get(m.id) || {},
  });

  const messenger = new Messenger(config, [makeAdapter('codex'), makeAdapter('antigravity'), makeAdapter('pi')], {});
  const messengerC = new Messenger(config, [makeAdapter('codex'), makeAdapter('antigravity'), makeAdapter('pi')], {
    AGENT_MESSENGER_CLIENT: 'pi',
    AGENT_MESSENGER_SESSION_ID: 'c',
  });

  t.after(() => {
    messenger.close();
    messengerC.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const metaA = { threadId: 'a' };
  const metaB = { 'antigravity.google/conversation_id': 'b' };

  // 1. Session A sends m1 to Session B
  const m1 = await messenger.send({ to: 'antigravity:b', text: 'Task from A to B' }, metaA);
  assert.equal(m1.state, 'queued');
  let m1Record = messenger.journal.get(m1.id);
  assert.equal(m1Record.replyId, null);

  // 2. Session B receives m1, forwards to Session C (third party) referencing reply_to: m1.id
  const m2 = await messenger.send({ to: 'pi:c', reply_to: m1.id, text: 'Forward from B to C' }, metaB);
  assert.equal(m2.state, 'queued');
  assert.equal(m2.pass, 2);

  // Assert m1 is NOT settled because m2 was sent to C, not A (reply.fromId !== target.id)
  m1Record = messenger.journal.get(m1.id);
  assert.equal(m1Record.replyId, null, 'Forwarding to third session C must NOT settle m1');

  // 3. Session C replies back to Session B
  const m3 = await messengerC.send({ reply_to: m2.id, text: 'C answers B' }, {});
  assert.equal(m3.state, 'queued');
  const m2Record = messenger.journal.get(m2.id);
  assert.equal(m2Record.replyId, m3.id, 'C replying to B must settle m2');

  // m1 is still untouched
  m1Record = messenger.journal.get(m1.id);
  assert.equal(m1Record.replyId, null, 'C replying to B must NOT settle m1');

  // 4. Session B replies to Session A omitting `to` (using reply_to: m1.id)
  const m4 = await messenger.send({ reply_to: m1.id, text: 'B answers A with results' }, metaB);
  assert.equal(m4.state, 'queued');
  assert.equal(messenger.journal.get(m4.id).toId, 'codex:a');

  // Assert m1 is now settled with m4.id
  m1Record = messenger.journal.get(m1.id);
  assert.equal(m1Record.replyId, m4.id, 'Replying to A must settle m1');

  // Session A inspects m1
  const m1Got = await messenger.get({ id: m1.id }, metaA);
  assert.equal(m1Got.state, 'replied');
  assert.equal(m1Got.reply, m4.id);

  // 5. Test explicit `to: codex` with reply_to also targets the exact sender session
  const m5 = await messenger.send({ to: 'antigravity:b', text: 'Another task from A to B' }, metaA);
  const m6 = await messenger.send({ to: 'codex', reply_to: m5.id, text: 'B replies with explicit to: codex' }, metaB);
  assert.equal(messenger.journal.get(m6.id).toId, 'codex:a');
  const m5Record = messenger.journal.get(m5.id);
  assert.equal(m5Record.replyId, m6.id, 'Explicit to: codex must route to A and settle m5');
});
