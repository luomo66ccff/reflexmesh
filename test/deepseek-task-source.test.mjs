import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekTaskSource } from '../adapters/deepseek-task-source.mjs';
import { inspectTaskIntent } from '../adapters/task-evidence.mjs';

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

test('parent hints and shared signals do not transfer selected summaries between Agents', () => {
  const f = fixture();
  const parent = f.agent('parent');
  const child = f.agent('child');
  child.parent = parent;
  child.session.parentId = parent.id;
  const source = createDeepSeekTaskSource(f.ctx, { intentMode: 'explicit-summary' });
  const signal = new AbortController().signal;
  const parentExec = { agent: parent, signal };
  const childExec = { agent: child, signal };
  f.start(parent, 1);
  f.start(child, 1);
  f.claim(parent, 1, 'ReflexMesh-Intent: Parent selected task');
  f.claim(child, 1, 'Child task without selected summary');
  f.step(parent, 1, signal);
  f.step(child, 1, signal);
  const parentIntent = source.resolveIntent(parentExec);
  assert.equal(parentIntent.summary, 'Parent selected task');
  assert.equal(source.resolveIntent(childExec), null);

  f.claim(child, 1, 'ReflexMesh-Intent: Child selected task');
  const childIntent = source.resolveIntent(childExec);
  assert.equal(childIntent.summary, 'Child selected task');
  assert.notEqual(childIntent.id, parentIntent.id);
  assert.deepEqual(childIntent.scope, { harness: 'deepseek-harness', sessionId: 'child', agentId: 'child' });
  assert.deepEqual(source.resolveIntent(parentExec), parentIntent);
  // A projection returned to one caller cannot mutate the retained selection.
  childIntent.scope.agentId = 'parent';
  childIntent.summary = 'Changed outside task source';
  assert.equal(source.resolveIntent(childExec).scope.agentId, 'child');
  assert.equal(source.resolveIntent(childExec).summary, 'Child selected task');
  f.emit('agent/disposed', { agent: child });
  assert.equal(source.resolveIntent(childExec), null);
  assert.deepEqual(source.resolveIntent(parentExec), parentIntent);
  source.dispose();
});

test('a replacement Agent with the same public IDs cannot inherit prior in-memory task evidence', () => {
  const f = fixture();
  const original = f.agent('reused-id');
  const source = createDeepSeekTaskSource(f.ctx, { intentMode: 'explicit-summary' });
  const signal = new AbortController().signal;
  f.start(original, 1);
  f.claim(original, 1, 'ReflexMesh-Intent: Original task');
  f.step(original, 1, signal);
  assert.ok(source.resolveIntent({ agent: original, signal }));
  const copy = { ...original };
  assert.equal(source.resolveIntent({ agent: copy, signal }), null);
  assert.throws(() => source.identity({ agent: copy }), /Live DeepSeek agent required/);

  const replacement = f.agent('reused-id');
  assert.equal(source.resolveIntent({ agent: original, signal }), null);
  assert.throws(() => source.identity({ agent: original }), /Live DeepSeek agent required/);
  assert.equal(source.resolveIntent({ agent: replacement, signal }), null);
  f.start(replacement, 1);
  f.step(replacement, 1, signal);
  assert.equal(source.resolveIntent({ agent: replacement, signal }), null);
  f.claim(replacement, 1, 'ReflexMesh-Intent: Replacement task');
  // Late disposal of the old object must not clear the new object's task.
  f.emit('agent/disposed', { agent: original });
  f.emit('session/disposed', original.session);
  assert.equal(source.resolveIntent({ agent: replacement, signal }).summary, 'Replacement task');
  source.dispose();
});

test('delegated user-shaped prompts remain model-reported with a private TTL', () => {
  for (const header of [
    { origin: 'subagent', parentSession: 'parent' },
    { origin: 'subagent' },
    { parentSession: 'parent' },
  ]) {
    const f = fixture();
    const agent = f.agent('child');
    agent.session.header = header;
    let now = 1000;
    const source = createDeepSeekTaskSource(f.ctx, { intentMode: 'explicit-summary', clock: () => now, ttlMs: 50 });
    const signal = new AbortController().signal;
    const exec = { agent, signal };
    f.start(agent, 1);
    f.claim(agent, 1, 'ReflexMesh-Intent: Independently selected child text');
    f.step(agent, 1, signal);
    const intent = source.resolveIntent(exec);
    assert.equal(intent.source, 'model-reported');
    assert.equal(intent.issuedAt, null);
    assert.equal(intent.expiresAt, null);
    const receipt = inspectTaskIntent(intent, intent.scope, now).receipt;
    assert.equal(receipt.status, 'ready');
    assert.equal(receipt.freshness, 'unverified');
    now = 999;
    assert.equal(source.resolveIntent(exec), null);
    now = 1049;
    assert.ok(source.resolveIntent(exec));
    now = 1050;
    assert.equal(source.resolveIntent(exec), null);
    f.claim(agent, 1, 'Unmarked replacement invalidates the delegated summary');
    assert.equal(source.resolveIntent(exec), null);
    source.dispose();
  }
});
