import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiAdapter } from '../src/adapters/pi.mjs';
import { atomicJson } from '../src/io.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-pi-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const piHome = path.join(root, 'pi');
  const piChannel = path.join(root, 'pi-channel');
  const config = { home: root, data: root, piHome, piChannel };
  const adapter = new PiAdapter(config);
  const sessionId = '01a1026e-197c-715c-a547-dfdcd5dd08c4';
  const folderName = '--E--Ameath--';
  const sessionDir = path.join(piHome, 'sessions', folderName);
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionFile = path.join(sessionDir, `2026-10-03T15-42-12-348Z_${sessionId}.jsonl`);
  const header = { type: 'session', version: 3, id: sessionId, timestamp: '2026-10-03T15:42:12.348Z', cwd: 'E:\\Ameath' };
  const initialRecords = [
    header,
    { type: 'message', id: 'm1', timestamp: '2026-10-03T15:42:12.449Z', message: { role: 'user', content: 'Initial user prompt for title' } },
    { type: 'message', id: 'm2', timestamp: '2026-10-03T15:42:15.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Initial assistant reply' }] } }
  ];
  fs.writeFileSync(sessionFile, initialRecords.map(r => JSON.stringify(r) + '\n').join(''), 'utf8');

  return { root, config, adapter, sessionId, sessionFile, folderName };
}

test('PiAdapter lists sessions and extracts title, cwd, and canonical ID', async t => {
  const f = fixture(t);
  const list = await f.adapter.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, `pi:${f.sessionId}`);
  assert.equal(list[0].rawId, f.sessionId);
  assert.equal(list[0].client, 'pi');
  assert.equal(list[0].project, 'E:\\Ameath');
  assert.equal(list[0].title, 'Initial user prompt for title');
  assert.equal(list[0].reachable, true);
  assert.equal(list[0].state, 'idle');
});

test('PiAdapter delivers prompt to channel queue and reads final answer', async t => {
  const f = fixture(t);
  const session = await f.adapter.get(f.sessionId);
  assert.ok(session);
  const anchor = await f.adapter.capture(session);

  const delivered = await f.adapter.deliver(session, '[Agent Messenger · from codex · 拆解代码准备 · m-pi-test-01]\nPlease compute 42.', 'm-pi-test-01', anchor);
  assert.deepEqual(delivered, { state: 'queued' });

  // Verify prompt file in channel
  const promptFile = path.join(f.config.piChannel, 'prompts', f.sessionId, 'm-pi-test-01.json');
  assert.ok(fs.existsSync(promptFile));

  // Append new turn in session file
  const newTurn = [
    { type: 'message', id: 'm3', timestamp: '2026-10-03T16:00:00.000Z', message: { role: 'user', content: '[Agent Messenger · from codex · 拆解代码准备 · m-pi-test-01]\nPlease compute 42.' } },
    { type: 'message', id: 'm4', timestamp: '2026-10-03T16:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Result is 42.' }] } }
  ];
  fs.appendFileSync(f.sessionFile, newTurn.map(r => JSON.stringify(r) + '\n').join(''), 'utf8');

  const reply = await f.adapter.read(session, 'm-pi-test-01', anchor);
  assert.equal(reply.state, 'done');
  assert.equal(reply.answer, 'Result is 42.');
});

test('PiAdapter recognizes explicit reply_to', async t => {
  const f = fixture(t);
  const session = await f.adapter.get(f.sessionId);
  const anchor = await f.adapter.capture(session);

  const replyTurn = [
    { type: 'message', id: 'm5', timestamp: '2026-10-03T17:00:00.000Z', message: { role: 'user', content: '[Agent Messenger · from codex · m-req-99]\nQuestion' } },
    { type: 'message', id: 'm6', timestamp: '2026-10-03T17:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '[Agent Messenger · from pi · re m-req-99]\nConfirmed answer.' }] } }
  ];
  fs.appendFileSync(f.sessionFile, replyTurn.map(r => JSON.stringify(r) + '\n').join(''), 'utf8');

  const reply = await f.adapter.read(session, 'm-req-99', anchor);
  assert.equal(reply.state, 'replied');
  assert.equal(reply.replyId, 'm-req-99');
});

test('PiAdapter starts a new session in project directory', async t => {
  const f = fixture(t);
  const started = await f.adapter.start('E:\\Ameath\\new-project', '[Agent Messenger · from codex · m-start-01]\nInit prompt', 'm-start-01');
  assert.equal(started.client, 'pi');
  assert.ok(started.id.startsWith('pi:'));
  assert.equal(started.deliveryState, 'queued');

  const loaded = await f.adapter.get(started.rawId);
  assert.ok(loaded);
  assert.equal(loaded.project, 'E:\\Ameath\\new-project');
});
