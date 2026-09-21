import assert from 'node:assert/strict';
import test from 'node:test';
import { installDeepSeekObserver } from '../adapters/deepseek-plugin.mjs';
import { createDeepSeekTaskSource } from '../adapters/deepseek-task-source.mjs';

// Synthetic ordering regression. Installed-host behavior is tested separately.
function fixture() {
  const listeners = new Map(), agents = new Map();
  const ctx = { agents: { get: id => agents.get(id) },
    on(name, callback) {
      const group = listeners.get(name) ?? new Set();
      group.add(callback); listeners.set(name, group);
      return () => group.delete(callback);
    } };
  const emit = (name, ...args) => [...listeners.get(name) ?? []].map(callback => callback(...args));
  const agent = { id: 'synthetic-agent', session: { id: 'synthetic-agent' } };
  agents.set(agent.id, agent);
  const source = createDeepSeekTaskSource(ctx);
  const before = [], after = [], warnings = [];
  const observer = installDeepSeekObserver(ctx, { identity: source.identity,
    boundary: { before: call => { before.push(call); }, after: (call, status, evidence) => { after.push({ call, status, evidence }); } },
    onError: value => warnings.push(value) });
  const exec = { agent, callId: 'synthetic-call', name: 'synthetic_read',
    arguments: { key: 'synthetic-only' }, signal: new AbortController().signal };
  return { ctx, agents, emit, agent, source, before, after, warnings, observer, exec };
}

test('accepted result is not lost when a later result listener removes the Agent registry entry', async () => {
  const f = fixture();
  try {
    await f.emit('tools/pre-execute', f.exec, () => ({ kind: 'allow' }))[0];
    f.ctx.on('tools/result', () => f.agents.delete(f.agent.id));
    f.emit('tools/result', f.exec, { isError: false, content: [] });
    await f.observer.flush();
    assert.equal(f.before.length, 1);
    assert.equal(f.after.length, 1);
    assert.deepEqual(f.after[0], { call: f.before[0], status: 'succeeded', evidence: { isError: false, content: [] } });
    assert.deepEqual(f.warnings, []);
  } finally { f.source.dispose(); await f.observer.dispose(); }
});

test('native post-dispatch ABORTED is unknown, not a confirmed failed execution', async () => {
  const f = fixture();
  const result = { isError: true, content: [{ type: 'text', text: 'Error: tool call aborted' }],
    error: { message: 'tool call aborted', info: { name: 'AbortError', code: 'ABORTED' } } };
  try {
    await f.emit('tools/pre-execute', f.exec, () => ({ kind: 'allow' }))[0];
    assert.equal(f.emit('tools/result', f.exec, result)[0], undefined);
    await f.observer.flush();
    assert.equal(f.after[0]?.status, 'unknown');
    assert.deepEqual(f.after[0]?.evidence, result);
    assert.deepEqual(f.warnings, []);
  } finally { f.source.dispose(); await f.observer.dispose(); }
});

test('result-time call, status and evidence are not rewritten by a later listener', async () => {
  const f = fixture();
  const result = { isError: false, content: [{ type: 'text', text: 'synthetic-original' }] };
  try {
    await f.emit('tools/pre-execute', f.exec, () => ({ kind: 'allow' }))[0];
    f.ctx.on('tools/result', () => {
      f.exec.arguments.key = 'different-task';
      result.isError = true;
      result.content[0].text = 'changed-after-emission';
    });
    f.emit('tools/result', f.exec, result);
    await f.observer.flush();
    assert.deepEqual(f.after[0], { call: f.before[0], status: 'succeeded',
      evidence: { isError: false, content: [{ type: 'text', text: 'synthetic-original' }] } });
    assert.equal(result.content[0].text, 'changed-after-emission'); // Never freeze or mutate the host object.
  } finally { f.source.dispose(); await f.observer.dispose(); }
});

test('ordinary and before-dispatch failures remain host reports, without guessing from error text', async () => {
  for (const [result, status] of [
    [{ isError: true, error: { info: { code: 'ABORTED_BEFORE_DISPATCH' } } }, 'failed'],
    [{ isError: true, error: { message: 'ABORTED, timeout, possibly successful' } }, 'failed'],
    [{ isError: false, error: { info: { code: 'ABORTED' } } }, 'succeeded'],
    [{ content: [] }, 'unknown'],
  ]) {
    const f = fixture();
    try {
      await f.emit('tools/pre-execute', f.exec, () => ({ kind: 'ask', reason: 'host-owned' }))[0];
      f.emit('tools/result', f.exec, result);
      f.emit('tools/result', f.exec, result);
      await f.observer.flush();
      assert.equal(f.after.length, 1);
      assert.equal(f.after[0].status, status);
      assert.deepEqual(f.warnings, []);
    } finally { f.source.dispose(); await f.observer.dispose(); }
  }
});

test('identity already invalid at result delivery is not replaced by its old admission identity', async () => {
  const f = fixture();
  try {
    await f.emit('tools/pre-execute', f.exec, () => ({ kind: 'allow' }))[0];
    f.agents.delete(f.agent.id);
    assert.doesNotThrow(() => f.emit('tools/result', f.exec, { isError: false, content: [] }));
    await f.observer.flush();
    assert.equal(f.after.length, 0);
    assert.deepEqual(f.warnings, ['reflexmesh_shadow_observation_failed']);
  } finally { f.source.dispose(); await f.observer.dispose(); }
});

test('oversized, malformed and accessor results settle without throwing or leaking raw errors', async () => {
  let getterCalls = 0;
  const accessor = { get isError() { getterCalls++; throw new Error('SECRET'); } };
  for (const result of [null, [], { isError: false, content: 'SECRET'.repeat(170_000) }, accessor]) {
    const f = fixture();
    try {
      await f.emit('tools/pre-execute', f.exec, () => ({ kind: 'allow' }))[0];
      assert.equal(f.emit('tools/result', f.exec, result)[0], undefined);
      await f.observer.flush();
      assert.equal(f.after.length, 0);
      assert.deepEqual(f.warnings, ['reflexmesh_shadow_observation_failed']);
    } finally { f.source.dispose(); await f.observer.dispose(); }
  }
  assert.equal(getterCalls, 0);
});
