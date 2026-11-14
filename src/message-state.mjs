const PROGRESS = { uncertain: 0, queued: 1, taken: 2, started: 3 };
const CONFIRMED = new Set(['queued', 'taken', 'started', 'done', 'replied']);
const TERMINAL = new Set(['done', 'replied', 'refused', 'expired']);

export function canTransition(oldState, newState) {
  if (!oldState || oldState === newState) return true;
  if (oldState === 'replied' || oldState === 'refused') return false;
  if (oldState === 'done') return newState === 'replied';
  if (oldState === 'expired') return ['done', 'replied', 'refused'].includes(newState);
  if (TERMINAL.has(newState)) return true;
  return PROGRESS[newState] >= PROGRESS[oldState];
}

export function isReplyFor(parent, reply) {
  return Boolean(reply && reply.replyTo === parent.id
    && reply.fromId === parent.toId && reply.toId === parent.fromId
    && CONFIRMED.has(reply.state));
}

// Used by both the MCP reader and the read-only dashboard snapshot.
export function messageState(record, observed, session, reply) {
  const verifiedReply = isReplyFor(record, reply) ? reply : null;
  let state = record.state;
  let reason = record.reason || null;
  if (state === 'replied' && !verifiedReply) {
    state = 'expired';
    reason = 'The historical reply link is invalid; waiting ended with the result unconfirmed.';
  }
  if (observed.state && observed.state !== 'replied' && canTransition(state, observed.state)) {
    state = observed.state;
    reason = observed.reason || null;
  }
  if (verifiedReply) {
    state = 'replied';
    reason = null;
  } else if (!TERMINAL.has(state) && !observed.answer
    && (session?.reachable === false || session?.ended || ['closed', 'offline'].includes(session?.state))) {
    state = 'expired';
    reason = 'Target is offline; waiting ended with delivery unconfirmed.';
  }
  return { state, reason, replyId: verifiedReply?.id || null };
}
