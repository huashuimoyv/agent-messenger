import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AntigravityAdapter } from '../src/adapters/antigravity.mjs';

const id = '8c1b5000-ec9c-4a04-b509-4bc39062f3c1';
const endpoint = { pid: 7, scheme: 'http', port: 9, token: 'unit-test-only' };

function fixture(t, { busy = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-messenger-antigravity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const records = [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 1, created_at: new Date(Date.now() - 2_000).toISOString(), content: '<USER_REQUEST>Earlier request</USER_REQUEST>' },
  ];
  if (!busy) records.push({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: new Date(Date.now() - 1_000).toISOString(), status: 'DONE', content: 'Earlier answer' });
  fs.writeFileSync(transcript, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  const project = path.join(home, 'antigravity-project');
  const summary = { workspaces: [{ workspaceFolderAbsoluteUri: pathToFileURL(project).href }] };
  const calls = [];
  const request = async (target, method, params) => {
    calls.push({ target, method, params });
    if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { [id]: summary } };
    if (method === 'GetCascadeTrajectory') return { trajectory: { steps: [{ userInput: { userConfig: { plannerConfig: { planModel: 'MODEL_TEST' } } } }] } };
    if (method === 'GetUserStatus') return { userStatus: { cascadeModelConfigData: {} } };
    if (method === 'SendUserCascadeMessage') return {};
    throw new Error('unexpected method');
  };
  const adapter = new AntigravityAdapter({ home, data: path.join(home, 'data') }, {
    discover: async () => [endpoint],
    request,
  });
  return { home, transcript, project, adapter, calls };
}

test('lists transcripts with canonical ids, workspace and state', async t => {
  const { adapter, project } = fixture(t);
  const sessions = await adapter.list({ limit: 10 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'antigravity:' + id);
  assert.equal(sessions[0].title, 'Earlier request');
  assert.equal(sessions[0].project, project);
  assert.equal(sessions[0].state, 'idle');
  assert.equal(sessions[0].reachable, true);
  assert.equal(await adapter.get('not-a-uuid'), null);
});

test('delivers once to the cascade owner and reads its matching completed turn', async t => {
  const { adapter, transcript, calls } = fixture(t);
  const session = await adapter.get(id);
  const anchor = await adapter.capture(session);
  const prompt = '[Agent Messenger · from codex · source · m-test]\nDo the task.';
  const delivered = await adapter.deliver(session, prompt, 'm-test', anchor);
  assert.deepEqual(delivered, { state: 'queued' });
  const send = calls.filter(call => call.method === 'SendUserCascadeMessage');
  assert.equal(send.length, 1);
  assert.equal(send[0].params.cascadeId, id);
  assert.equal(send[0].params.deliveryStrategy, 'MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE');
  assert.deepEqual(send[0].params.items, [{ text: prompt }]);
  assert.equal(send[0].params.cascadeConfig.plannerConfig.planModel, 'MODEL_TEST');

  const now = new Date().toISOString();
  fs.appendFileSync(transcript, [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 2, created_at: now, content: prompt },
    { type: 'PLANNER_RESPONSE', step_index: 3, created_at: now, status: 'DONE', tool_calls: [{ name: 'run_command' }], content: 'Intermediate planner text.' },
    { type: 'PLANNER_RESPONSE', step_index: 4, created_at: now, status: 'DONE', content: 'Completed response.' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.equal((await adapter.current(session)).turnId, 'step-2');
  const observed = await adapter.read(session, { id: 'm-test', sentAt: Date.now(), state: 'queued', anchor });
  assert.deepEqual(observed, { state: 'done', answer: 'Completed response.', turn: 'step-2' });
});

test('does not guess the answer for an enqueue made during an active turn', async t => {
  const { adapter, calls } = fixture(t, { busy: true });
  const session = await adapter.get(id);
  assert.equal(session.state, 'running');
  const anchor = await adapter.capture(session);
  const delivered = await adapter.deliver(session, '[Agent Messenger · from codex · source · m-busy]\nDo the task.', 'm-busy', anchor);
  assert.deepEqual(delivered, { state: 'queued' });
  const observed = await adapter.read(session, { id: 'm-busy', state: 'queued', anchor });
  assert.equal(observed.state, 'queued');
  assert.match(observed.reason, /explicit reply_to/);
  assert.equal(calls.filter(call => call.method === 'SendUserCascadeMessage').length, 1);
});

test('an empty or failed terminal response ends the matched turn', async t => {
  const { adapter, transcript } = fixture(t);
  const session = await adapter.get(id), anchor = await adapter.capture(session);
  fs.appendFileSync(transcript, [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 2, content: '[Agent Messenger · m-empty]\nquestion' },
    { type: 'PLANNER_RESPONSE', step_index: 3, status: 'ERROR', content: '' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const observed = await adapter.read(session, { id: 'm-empty', state: 'queued', anchor });
  assert.equal(observed.state, 'done'); assert.equal(observed.answer, null); assert.match(observed.reason, /ERROR/);
});

test('returns unknown for a stale unfinished turn and refuses to correlate it', async t => {
  const { adapter, transcript } = fixture(t, { busy: true });
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 1, created_at: old, content: 'Still may be running.',
  }) + '\n');
  const session = await adapter.get(id);
  assert.equal(session.state, 'unknown');
  const anchor = await adapter.capture(session);
  assert.equal(anchor.correlationUnsafe, true);
});

test('matches only the envelope header, not an id mentioned in ordinary text', async t => {
  const { adapter, transcript } = fixture(t);
  const session = await adapter.get(id);
  const anchor = await adapter.capture(session);
  fs.appendFileSync(transcript, JSON.stringify({
    type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 2,
    created_at: new Date().toISOString(), content: 'Ordinary user text mentions m-exact.',
  }) + '\n');
  const observed = await adapter.read(session, { id: 'm-exact', state: 'queued', anchor });
  assert.deepEqual(observed, { state: 'queued' });
});

test('marks an unconfirmed send uncertain and never retries it', async t => {
  const { adapter, calls } = fixture(t);
  adapter.request = async (target, method, params) => {
    if (method === 'SendUserCascadeMessage') {
      calls.push({ method });
      throw new Error('connection lost after write');
    }
    return method === 'GetAllCascadeTrajectories'
      ? { trajectorySummaries: { [id]: {} } }
      : { trajectory: { steps: [] } };
  };
  const observed = await adapter.deliver({ id: 'antigravity:' + id }, 'prompt', 'm-uncertain', {});
  assert.equal(observed.state, 'uncertain');
  assert.equal(calls.filter(call => call.method === 'SendUserCascadeMessage').length, 1);
});

test('optional live test performs only read-only language-server calls', { skip: process.env.AGENT_MESSENGER_LIVE_ANTIGRAVITY !== '1' }, async () => {
  const home = process.env.USERPROFILE || os.homedir();
  const adapter = new AntigravityAdapter({ home, data: path.join(os.tmpdir(), 'agent-messenger-live-read-only') });
  const endpoints = await adapter.discover();
  assert.ok(endpoints.length, 'no authenticated running Antigravity language server was found');
  const metadata = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: 'unknown' } };
  const status = await adapter.request(endpoints[0], 'GetUserStatus', metadata);
  const summaries = await adapter.request(endpoints[0], 'GetAllCascadeTrajectories', {});
  const ids = Object.keys(summaries.trajectorySummaries || {});
  let trajectory = null;
  if (ids.length) trajectory = await adapter.request(endpoints[0], 'GetCascadeTrajectory', { cascadeId: ids[0] });
  const selected = ids.length ? await adapter.get(ids[0]) : null;
  const steps = trajectory?.trajectory?.steps || [];
  const lastStep = steps.at(-1) || {};
  const inputStep = steps.find(step => step.userInput || String(step.type || '').includes('USER_INPUT')) || {};
  const input = inputStep.userInput || {};
  const modelData = status.userStatus?.cascadeModelConfigData || {};
  process.stdout.write(JSON.stringify({
    readOnlyMethods: ['GetUserStatus', 'GetAllCascadeTrajectories', ...(trajectory ? ['GetCascadeTrajectory'] : [])],
    userStatusFields: Object.keys(status.userStatus || {}),
    modelConfigFields: Object.keys(modelData),
    clientModelConfigFields: Object.keys(modelData.clientModelConfigs?.[0] || {}),
    modelAliasFields: Object.keys(modelData.clientModelConfigs?.[0]?.modelOrAlias || {}),
    quotaInfoFields: Object.keys(modelData.clientModelConfigs?.[0]?.quotaInfo || {}),
    trajectoryListFields: Object.keys(summaries),
    summaryCount: ids.length,
    summaryFields: ids.length ? Object.keys(summaries.trajectorySummaries[ids[0]]) : [],
    workspaceFields: ids.length ? Object.keys(summaries.trajectorySummaries[ids[0]].workspaces?.[0] || {}) : [],
    session: selected && { id: selected.id, title: selected.title, project: selected.project, state: selected.state, reachable: selected.reachable },
    trajectoryKeys: trajectory ? Object.keys(trajectory) : [],
    trajectoryFields: trajectory ? Object.keys(trajectory.trajectory || {}) : [],
    stepCount: trajectory?.trajectory?.steps?.length ?? null,
    inputStep: {
      type: inputStep.type || null,
      status: inputStep.status || null,
      fields: Object.keys(inputStep),
      metadataFields: Object.keys(inputStep.metadata || {}),
      userInputFields: Object.keys(input),
      userConfigFields: Object.keys(input.userConfig || {}),
      plannerConfigFields: Object.keys(input.userConfig?.plannerConfig || {}),
    },
    lastStepFields: Object.keys(lastStep),
    lastStepType: lastStep.type || null,
    lastStepStatus: lastStep.status || null,
  }) + '\n');
});
