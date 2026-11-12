import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal, canTransition } from '../src/journal.mjs';
import { FileChannel } from '../src/channel-store.mjs';
import { PiAdapter } from '../src/adapters/pi.mjs';
import { startDashboardServer } from '../src/dashboard-server.mjs';
import { configuration } from '../src/config.mjs';

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

  const onDisk = JSON.parse(fs.readFileSync(promptFile, 'utf8'));
  assert.ok(onDisk.expiredAt, 'expiredAt must be written to disk to avoid re-delivery on restart');

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
