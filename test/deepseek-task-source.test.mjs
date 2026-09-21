import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekTaskSource } from '../adapters/deepseek-task-source.mjs';

function fixture() {
  const listeners = new Map();
  const agents = new Map();
  const ctx = {
    agents: { get: id => agents.get(id) },
    on(name, fn) {
      const group = listeners.get(name) ?? new Set();
      group.add(fn); listeners.set(name, group);
      return () => group.delete(fn);
    },
  };
  const emit = (name, ...args) => {
    for (const fn of listeners.get(name) ?? []) fn(...args);
  };
  const agent = id => {
    const value = { id, session: { id } };
    agents.set(id, value);
    return value;
  };
  const start = (value, turn) => emit('session/event', value.session, { type: 'turn/start', data: { turn } });
  const end = (value, turn) => emit('session/event', value.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  const claim = (value, turn, text, source = 'user', id = 'message-1') => emit('agent/inbox/claimed', {
    agent: value, turn, message: { id, role: 'user', source: { kind: source },
      content: [{ type: 'text', text }] },
  });
  const step = (value, turn, signal) => emit('agent/pre-step', { agent: value, turn, step: 1, signal, messages: [] }, () => ({ kind: 'enter' }));
  return { ctx, agent, start, end, claim, step, emit, listeners };
}

test('claimed user summary is exact-agent, turn, signal and TTL scoped', () => {
  const f = fixture();
  const left = f.agent('left');
  const right = f.agent('right');
  let now = 1000;
  const source = createDeepSeekTaskSource(f.ctx, { intentMode: 'explicit-summary', clock: () => now, ttlMs: 50 });
  const signal = new AbortController().signal;
  f.start(left, 1);
  f.start(right, 1);
  f.claim(left, 1, 'ReflexMesh-Intent: Check isolated fixture\nDo not read this transcript', 'user', 'left-1');
  f.step(left, 1, signal);
  const exec = { agent: left, signal };
  assert.equal(source.resolveIntent(exec)?.summary, 'Check isolated fixture');
  assert.deepEqual(source.identity(exec), { sessionId: 'left', agentId: 'left' });
  assert.equal(source.resolveIntent({ agent: right, signal }), null);
  assert.equal(source.resolveIntent({ agent: left, signal: new AbortController().signal }), null);
  f.end(left, 0); // stale turn-end must not clear the active turn
  assert.ok(source.resolveIntent(exec));
  now = 1050;
  assert.equal(source.resolveIntent(exec), null);
  f.end(left, 1);
  assert.equal(source.size, 1);
  source.dispose();
  assert.equal(source.size, 0);
  assert.equal(source.resolveIntent(exec), null);
});

test('each newly claimed user clears old summary, including invalid and sensitive text', () => {
  const f = fixture();
  const agent = f.agent('session');
  const source = createDeepSeekTaskSource(f.ctx, { intentMode: 'explicit-summary' });
  const signal = new AbortController().signal;
  const exec = { agent, signal };
  f.start(agent, 1);
  f.claim(agent, 1, 'ReflexMesh-Intent: First', 'user', 'one');
  f.step(agent, 1, signal);
  assert.equal(source.resolveIntent(exec)?.summary, 'First');
  f.claim(agent, 1, 'No explicit marker', 'user', 'two');
  assert.equal(source.resolveIntent(exec), null);
  f.claim(agent, 1, 'ReflexMesh-Intent: Second', 'user', 'three');
  f.claim(agent, 1, 'ReflexMesh-Intent: password=example-secret-value', 'user', 'four');
  assert.equal(source.resolveIntent(exec), null);
  f.claim(agent, 1, `ReflexMesh-Intent: ${'x'.repeat(2049)}`, 'user', 'five');
  assert.equal(source.resolveIntent(exec), null);
  f.claim(agent, 1, 'ReflexMesh-Intent: Third', 'plugin', 'six');
  assert.equal(source.resolveIntent(exec), null);
  f.claim(agent, 1, 'ReflexMesh-Intent: Valid', 'user', 'seven');
  assert.equal(source.resolveIntent(exec)?.summary, 'Valid');
  f.emit('agent/inbox/claimed', { agent, turn: 1, message: { id: 'bad-plugin', role: 'user',
    source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Plugin without id' }] } });
  assert.equal(source.resolveIntent(exec), null);
  f.claim(agent, 1, 'ReflexMesh-Intent: Valid again', 'user', 'eight');
  f.emit('agent/inbox/claimed', { agent, turn: 1, message: { id: 'plugin', role: 'user',
    source: { kind: 'plugin', plugin: 'trusted-host-plugin' }, content: [{ type: 'text', text: 'Context' }] } });
  assert.equal(source.resolveIntent(exec)?.summary, 'Valid again');
  f.end(agent, 1);
  assert.equal(source.resolveIntent(exec), null);
  source.dispose();
});

test('default off never reads message body; bounded active agents and disposal are fail closed', () => {
  const f = fixture();
  const first = f.agent('first');
  const second = f.agent('second');
  const source = createDeepSeekTaskSource(f.ctx, { maxAgents: 1 });
  f.start(first, 1);
  f.start(second, 1);
  assert.equal(source.size, 1);
  const message = { role: 'user', source: { kind: 'user' }, get content() { throw new Error('body accessed'); } };
  assert.doesNotThrow(() => f.emit('agent/inbox/claimed', { agent: first, message, turn: 1 }));
  assert.equal(source.resolveIntent({ agent: first, signal: new AbortController().signal }), null);
  f.emit('agent/disposed', { agent: first });
  assert.equal(source.size, 0);
  source.dispose();
  for (const callbacks of f.listeners.values()) assert.equal(callbacks.size, 0);
});
