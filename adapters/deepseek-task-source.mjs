import { intentDigest, MAX_INTENT_TTL_MS, selectExplicitSummary } from './task-evidence.mjs';

const DEFAULT_MAX_AGENTS = 256;
const DEFAULT_TTL_MS = 60_000;

/** A bounded, live-only projection of explicitly selected inbox claims. */
export function createDeepSeekTaskSource(ctx, {
  intentMode = 'off', clock = Date.now, maxAgents = DEFAULT_MAX_AGENTS, ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (typeof ctx?.on !== 'function' || typeof ctx?.agents?.get !== 'function') throw new TypeError('DeepSeek agent context required');
  if (!['off', 'explicit-summary'].includes(intentMode)) throw new TypeError('Unsupported intent mode');
  if (typeof clock !== 'function' || !Number.isSafeInteger(maxAgents) || maxAgents < 1 || maxAgents > DEFAULT_MAX_AGENTS
    || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_INTENT_TTL_MS) throw new TypeError('Invalid task source bounds');

  const active = new Map();
  const listeners = [];
  let closed = false;
  const live = agent => agent && typeof agent === 'object' && agent.session?.id === agent.id
    && ctx.agents.get(agent.id) === agent;
  const time = () => {
    const value = clock();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const forgetSession = (session, turn) => {
    for (const [agent, state] of active) {
      if (state.session === session && (turn === undefined || state.turn === turn)) active.delete(agent);
    }
  };
  const register = (name, listener) => listeners.push(ctx.on(name, listener));

  try {
    register('session/event', (session, event) => {
      if (closed || !session || !event || !Number.isSafeInteger(event.data?.turn)) return;
      const { turn } = event.data;
      if (event.type === 'turn/end') { forgetSession(session, turn); return; }
      if (event.type !== 'turn/start') return;
      // A new turn invalidates the previous selection even if no input is claimed.
      forgetSession(session);
      const agent = ctx.agents.get(session.id);
      if (live(agent) && agent.session === session && active.size < maxAgents) {
        active.set(agent, { session, turn, signal: null, intent: null, capturedAt: null, localExpiresAt: null });
      }
    });
    register('agent/inbox/claimed', ({ agent, message, turn } = {}) => {
      if (closed || intentMode === 'off' || !live(agent) || !Number.isSafeInteger(turn)) return;
      const state = active.get(agent);
      if (!state || state.session !== agent.session || state.turn !== turn) return;
      // A known plugin continuation does not replace the current user task.
      // Unknown or malformed claimed input does: fail closed instead of inheriting.
      if (message?.role === 'user' && message.source?.kind === 'plugin'
        && typeof message.source.plugin === 'string' && message.source.plugin.length > 0) return;
      state.intent = null;
      // The host producer supplies source.kind. It is not human authentication.
      if (message?.role !== 'user' || message.source?.kind !== 'user') return;
      const first = Array.isArray(message.content) ? message.content[0] : null;
      const selected = selectExplicitSummary(first?.type === 'text' ? first.text : null);
      const issuedAt = time();
      if (selected.status !== 'ready' || issuedAt === null || issuedAt > Number.MAX_SAFE_INTEGER - ttlMs
        || typeof message.id !== 'string'
        || message.id.length < 1 || message.id.length > 256) return;
      // The official subagent driver wraps delegated prompts as source:user.
      // That wrapper is not proof that a human supplied the selected text.
      const header = agent.session.header;
      const delegated = header?.origin === 'subagent' || header?.parentSession !== undefined;
      state.capturedAt = issuedAt;
      state.localExpiresAt = issuedAt + ttlMs;
      state.intent = {
        schemaVersion: 1,
        id: intentDigest([agent.id, turn, message.id, 'deepseek-claimed-summary']),
        scope: { harness: 'deepseek-harness', sessionId: agent.session.id, agentId: agent.id },
        source: delegated ? 'model-reported' : 'host-declared', summary: selected.summary,
        issuedAt: delegated ? null : issuedAt, expiresAt: delegated ? null : state.localExpiresAt,
      };
    });
    register('agent/pre-step', (payload, next) => {
      if (!closed && live(payload?.agent)) {
        const state = active.get(payload.agent);
        if (state && state.turn === payload.turn && state.session === payload.agent.session) state.signal = payload.signal;
      }
      return next();
    });
    register('agent/disposed', ({ agent } = {}) => { if (agent) active.delete(agent); });
    register('session/disposed', session => { if (session) forgetSession(session); });
  } catch (error) {
    for (const off of listeners.reverse()) off();
    throw error;
  }

  const identity = exec => {
    const agent = exec?.agent;
    if (!live(agent)) throw new TypeError('Live DeepSeek agent required');
    return { sessionId: agent.session.id, agentId: agent.id };
  };
  const resolveIntent = exec => {
    if (closed || intentMode === 'off' || exec?.signal?.aborted) return null;
    const agent = exec?.agent;
    if (!live(agent)) return null;
    const state = active.get(agent);
    const now = time();
    if (!state || now === null || state.session !== agent.session || state.signal !== exec.signal
      || !state.intent || now < state.capturedAt || now >= state.localExpiresAt) return null;
    return { ...state.intent, scope: { ...state.intent.scope } };
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const off of listeners.reverse()) off();
    active.clear();
  };
  return { identity, resolveIntent, dispose, get size() { return active.size; } };
}
