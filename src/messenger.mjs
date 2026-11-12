import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Journal } from './journal.mjs';
import { canonical, rawId, DeliveryError, envelopeMessageId, waitForChange } from './io.mjs';

const DEFAULT_CLIENTS = ['codex', 'antigravity', 'claude', 'deepseek', 'pi'];
const DEFAULT_REPLY_TOOLS = {
  codex: 'mcp__agent_messenger__send_message',
  antigravity: "agent-messenger's send_message tool",
  pi: 'mcp__agent_messenger__send_message',
};
const TERMINAL_STATES = new Set(['done', 'replied', 'refused', 'expired']);
const MAX_WAIT_MS = 30_000;

const cleanTitle = title => String(title || '').replace(/[\r\n\[\]]/g, ' ').slice(0, 60).trim();
const messageId = () => `m-${randomBytes(6).toString('hex')}`;
const ordered = value => Array.isArray(value)
  ? value.map(ordered)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])]))
    : value;
export const hash = value => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');

function normalizeProject(folder) {
  if (!folder) return '';
  const cleaned = String(folder).replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

export function callerIdentity(meta, env = process.env, allowedClients = DEFAULT_CLIENTS) {
  const turn = meta?.['x-codex-turn-metadata'];
  const thread = meta?.threadId || turn?.thread_id;
  if (typeof thread === 'string' && thread) return { client: 'codex', rawId: rawId('codex', thread), turnId: turn?.turn_id || null };
  const cascade = meta?.['antigravity.google/conversation_id'];
  if (typeof cascade === 'string' && cascade) return { client: 'antigravity', rawId: rawId('antigravity', cascade), turnId: null };
  if (env.CLAUDE_CODE_SESSION_ID) return { client: 'claude', rawId: env.CLAUDE_CODE_SESSION_ID, turnId: null };
  if (env.PI_SESSION_ID) return { client: 'pi', rawId: rawId('pi', env.PI_SESSION_ID), turnId: null };
  if (allowedClients.includes(env.AGENT_MESSENGER_CLIENT) && env.AGENT_MESSENGER_SESSION_ID) {
    return { client: env.AGENT_MESSENGER_CLIENT, rawId: rawId(env.AGENT_MESSENGER_CLIENT, env.AGENT_MESSENGER_SESSION_ID), turnId: null };
  }
  return null;
}

export function envelope(from, targetClientOrAdapter, id, replyTo, text) {
  const label = `[Agent Messenger · from ${from.client} · ${cleanTitle(from.title)} · ${id}${replyTo ? ` · re ${replyTo}` : ''}]`;
  const tool = typeof targetClientOrAdapter === 'object' && targetClientOrAdapter?.replyTool
    ? targetClientOrAdapter.replyTool
    : (DEFAULT_REPLY_TOOLS[targetClientOrAdapter] || 'mcp__agent-messenger__send_message');
  const footer = replyTo
    ? `This answers ${replyTo}. Only if more is needed, use ${tool} with reply_to: ${id}.`
    : `Reply using ${tool} with reply_to: ${id}. If that tool is unavailable, answer here; the sender can read this turn's final answer. Do not forward this request to another tool named send_message.`;
  return `${label}\n\n${text}\n\n${footer}`;
}

export class Messenger {
  constructor(config, adapters, env = process.env) {
    this.config = config;
    this.adapters = new Map(adapters.map(a => [a.client, a]));
    this.env = env;
    this.journal = new Journal(config.data);
  }

  get clientNames() {
    return [...this.adapters.keys()];
  }

  get startableClients() {
    return [...this.adapters.values()]
      .filter(a => a.canStart ?? typeof a.start === 'function')
      .map(a => a.client);
  }

  close() {
    this.journal.close();
  }

  async #resolveSemanticClient(clientName, caller) {
    const adapter = this.adapters.get(clientName);
    if (!adapter) return null;
    const list = await adapter.list({ limit: 25 });
    const reachable = list.filter(s => s.id !== caller?.id && s.reachable === true);
    if (!reachable.length) {
      throw new DeliveryError(`No reachable ${clientName} session found. Open ${clientName} or specify an exact session id from list_sessions.`);
    }
    const callerProj = normalizeProject(caller?.project);
    if (callerProj) {
      const sameProj = reachable.filter(s => normalizeProject(s.project) === callerProj);
      if (sameProj.length) return sameProj.find(s => s.state === 'idle') || sameProj[0];
    }
    return reachable.find(s => s.state === 'idle') || reachable[0];
  }

  async resolve(id, caller = null) {
    if (this.adapters.has(id)) return this.#resolveSemanticClient(id, caller);
    const split = id.indexOf(':');
    if (split !== -1) {
      const prefix = id.slice(0, split), rest = id.slice(split + 1);
      if (rest === 'latest' && this.adapters.has(prefix)) {
        return this.#resolveSemanticClient(prefix, caller);
      }
      const adapter = this.adapters.get(prefix);
      return adapter ? adapter.get(rest) : null;
    }
    const found = (await Promise.all([...this.adapters.values()].map(a => a.get(id)))).filter(Boolean);
    if (found.length > 1) throw new DeliveryError('Ambiguous session id; use the full id from list_sessions.');
    return found[0] || null;
  }

  #discoverCaller(meta, tool, args) {
    const direct = callerIdentity(meta, this.env, this.clientNames);
    if (direct && this.adapters.has(direct.client)) return direct;
    const ctx = { meta, env: this.env, ppid: process.ppid, tool, args, hash };
    for (const adapter of this.adapters.values()) {
      const identified = adapter.identifyCaller?.(ctx);
      if (identified) return identified;
    }
    return direct;
  }

  async caller(meta, tool, args, required = true) {
    const identity = this.#discoverCaller(meta, tool, args);
    if (!identity) {
      if (!required) return null;
      throw new DeliveryError('The client did not identify this session. Use client MCP metadata or bind AGENT_MESSENGER_CLIENT and AGENT_MESSENGER_SESSION_ID at launch.');
    }
    const id = canonical(identity.client, identity.rawId);
    const session = await this.adapters.get(identity.client)?.get(identity.rawId);
    if (!session && required) {
      throw new DeliveryError('The calling session is no longer discoverable. Refresh list_sessions in the intended client.');
    }
    return { ...session, ...identity, id };
  }

  async list(args, meta) {
    const caller = await this.caller(meta, 'list_sessions', args, false);
    const limit = args.limit ?? 30, offset = args.offset ?? 0;
    const adapters = [...this.adapters.values()].filter(a => !args.client || a.client === args.client);
    const results = await Promise.allSettled(adapters.map(a => a.list({ limit: limit + offset + 1 })));
    const warnings = [], all = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') all.push(...result.value);
      else warnings.push({ client: adapters[i].client, reason: result.reason.message });
    });
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const sessions = all.slice(offset, offset + limit).map(s => ({
      id: s.id, client: s.client, title: s.title, project: s.project || null,
      state: s.state || 'unknown', idle: s.state === 'idle' ? true : s.state === 'running' ? false : null,
      reachable: s.reachable ?? null, self: s.id === caller?.id,
    }));
    return {
      sessions,
      next_offset: all.length > offset + limit ? offset + limit : null,
      start_clients: this.startableClients,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  async nextPass(caller, reply) {
    const received = this.journal.received(caller.id);
    if (!received.length) return { chain: null, pass: 1 };
    const current = await this.adapters.get(caller.client).current(caller, caller.turnId);
    let parent;
    if (current) {
      const incomingId = envelopeMessageId(current.text);
      parent = received.find(m => m.id === incomingId);
      if (!parent && /^\[Agent (?:Messenger|HUD) ·/.test(current.text.trim())) parent = reply || received[0];
    } else {
      parent = reply || received[0];
    }
    return parent ? { chain: parent.chain, pass: parent.pass + 1 } : { chain: null, pass: 1 };
  }

  result(record) {
    return { id: record.id, state: record.state, pass: record.pass, ...(record.reason ? { reason: record.reason } : {}) };
  }

  async send(args, meta) {
    const from = await this.caller(meta, 'send_message', args);
    const reply = args.reply_to ? this.journal.get(args.reply_to) : null;
    if (args.reply_to && (!reply || reply.toId !== from.id)) {
      throw new DeliveryError('reply_to must name a message received by this session.');
    }
    const to = args.to || reply?.fromId;
    if (!to) throw new DeliveryError('Provide to, or reply_to for a message received by this session.');
    const target = await this.resolve(to, from);
    if (!target) throw new DeliveryError('Unknown session. Use an id from list_sessions.');
    if (from.id === target.id) throw new DeliveryError('A session cannot message itself.');
    if (target.reachable === false) throw new DeliveryError(target.reason || 'The target plugin or client is not running.');

    const fingerprint = hash({ to: target.id, text: args.text, replyTo: args.reply_to || null });
    const requestKey = `${from.id}:${args.request_id || messageId()}`;
    const existing = this.journal.request(requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new DeliveryError('request_id was already used with different content.');
      if (args.wait_ms > 0) return this.get({ id: existing.id, wait_ms: args.wait_ms }, meta);
      return this.result(existing);
    }

    const adapter = this.adapters.get(target.client);
    const anchor = await adapter.capture(target);
    const chain = await this.nextPass(from, reply);
    if (chain.pass > this.config.passLimit) {
      throw new DeliveryError(`The chain reached ${this.config.passLimit} passes. A new user prompt is required.`);
    }

    const id = messageId();
    const reservation = this.journal.reserve({
      id, requestKey, fingerprint, fromId: from.id, toId: target.id,
      fromClient: from.client, toClient: target.client, sentAt: Date.now(), chain: chain.chain || id,
      pass: chain.pass, kind: 'send', replyTo: args.reply_to || null, state: 'uncertain', reason: null, anchor,
    });
    if (!reservation.created) {
      if (args.wait_ms > 0) return this.get({ id: reservation.record.id, wait_ms: args.wait_ms }, meta);
      return this.result(reservation.record);
    }

    let delivery;
    try { delivery = await adapter.deliver(target, envelope(from, adapter, id, args.reply_to, args.text), id, anchor); }
    catch (error) { delivery = { state: error.state || 'uncertain', reason: error.message }; }

    let record;
    try {
      record = this.journal.update(id, { state: delivery.state, reason: delivery.reason || null });
      if (reply && reply.fromId === target.id && !['refused', 'uncertain'].includes(record.state)) {
        this.journal.settleReply(reply.id, id);
      }
    } catch (error) {
      return { id, state: 'uncertain', pass: chain.pass, reason: `Delivery may have happened; journal update failed: ${error.message}. Do not resend with a new request_id.` };
    }

    if (args.wait_ms > 0 && !TERMINAL_STATES.has(record.state) && record.state !== 'uncertain') {
      return this.get({ id: record.id, wait_ms: args.wait_ms }, meta);
    }
    return this.result(record);
  }

  async #inspectMessage(from, id) {
    let record = this.journal.get(id);
    if (!record || record.fromId !== from.id) {
      throw new DeliveryError('Unknown message for this sender. Use the id returned by send_message or start_session.');
    }
    let observed = {}, session = null;
    const adapter = this.adapters.get(record.toClient);
    if (record.state !== 'refused' && adapter) {
      session = await this.resolve(record.toId);
      if (session) {
        observed = await adapter.read(session, record);
        const patch = {};
        for (const field of ['state', 'reason', 'turn']) {
          if (observed[field] !== undefined) patch[field] = observed[field];
        }
        if (observed.replyId && !record.replyId) patch.replyId = observed.replyId;

        const hasCompletion = observed.state === 'done' || observed.state === 'replied' || observed.answer || observed.replyId || record.replyId;
        const isOffline = session.reachable === false || session.ended || session.state === 'closed' || session.state === 'offline';
        if (isOffline && !hasCompletion && !TERMINAL_STATES.has(record.state)) {
          if (!TERMINAL_STATES.has(patch.state || record.state)) {
            patch.state = 'expired';
            patch.reason = observed.reason
              ? `${observed.reason} (Target is offline; wait ended with delivery unconfirmed.)`
              : 'Target session is offline or unreachable; wait ended with delivery unconfirmed.';
          }
        }

        record = this.journal.update(record.id, patch);
      } else if (!TERMINAL_STATES.has(record.state)) {
        // Target session is no longer discoverable or has ended
        const patch = { state: 'expired', reason: 'Target session is no longer discoverable or has ended.' };
        record = this.journal.update(record.id, patch);
      }
    }
    if (record.replyTo && !['refused', 'uncertain'].includes(record.state)) {
      const parent = this.journal.get(record.replyTo);
      if (parent?.fromId === record.toId) this.journal.settleReply(parent.id, record.id);
    }
    const state = record.replyId && !(record.state === 'done' && observed.answer) ? 'replied' : record.state;
    return {
      session,
      record,
      response: {
        ...this.result(record),
        state,
        to: record.toId,
        reply: record.replyId || null,
        answer: observed.answer ?? null,
        sent_at: new Date(record.sentAt).toISOString(),
      },
    };
  }

  async get(args, meta) {
    const from = await this.caller(meta, 'get_message', args);
    let inspected = await this.#inspectMessage(from, args.id);
    const waitMs = Math.min(Math.max(0, Number(args.wait_ms || 0)), MAX_WAIT_MS);
    if (!waitMs || TERMINAL_STATES.has(inspected.response.state)) {
      return inspected.response;
    }

    const adapter = this.adapters.get(inspected.record.toClient);
    const targets = [
      ...this.journal.watchTargets(),
      ...(adapter?.watchPaths?.(inspected.session, inspected.record) || []),
    ];
    const settled = await waitForChange(targets, waitMs, async () => {
      inspected = await this.#inspectMessage(from, args.id);
      return TERMINAL_STATES.has(inspected.response.state) ? inspected.response : null;
    });
    return settled || inspected.response;
  }

  async start(args, meta) {
    const from = await this.caller(meta, 'start_session', args);
    const adapter = this.adapters.get(args.client);
    const startable = this.startableClients;
    if (!adapter || !startable.includes(args.client)) {
      throw new DeliveryError(`This version starts ${startable.join(' and ')} sessions only. Use send_message for an existing session of the other clients.`);
    }
    const folder = args.folder || from.project;
    if (!folder || !path.isAbsolute(folder) || !fs.statSync(folder).isDirectory()) {
      throw new DeliveryError('folder must be an existing absolute project directory.');
    }
    const requestKey = `${from.id}:start:${args.request_id || messageId()}`;
    const fingerprint = hash({ folder, text: args.text, client: args.client });
    const old = this.journal.request(requestKey);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new DeliveryError('request_id was already used with different content.');
      return { ...this.result(old), session_id: old.toId };
    }
    const chain = await this.nextPass(from, null);
    if (chain.pass > this.config.passLimit) {
      throw new DeliveryError(`The chain reached ${this.config.passLimit} passes. A new user prompt is required.`);
    }
    const id = messageId();
    const reservation = this.journal.reserve({
      id, requestKey, fingerprint, fromId: from.id, toId: `${args.client}:pending-${id}`,
      fromClient: from.client, toClient: args.client, sentAt: Date.now(), chain: chain.chain || id, pass: chain.pass,
      kind: 'start', replyTo: null, state: 'uncertain', reason: null, anchor: {},
    });
    if (!reservation.created) return { ...this.result(reservation.record), session_id: reservation.record.toId };
    try {
      const session = await adapter.start(folder, envelope(from, adapter, id, null, args.text), id);
      const record = this.journal.update(id, {
        toId: session.id,
        anchor: session.anchor || { offset: 0 },
        state: session.deliveryState || 'queued',
        reason: session.reason || null,
      });
      return { ...this.result(record), session_id: session.id };
    } catch (error) {
      const record = this.journal.update(id, { state: error.state || 'uncertain', reason: error.message });
      return this.result(record);
    }
  }
}
