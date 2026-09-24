import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDeepSeekObserver } from '../adapters/deepseek-plugin.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture({ before = () => {}, after = () => {}, wait = 0 } = {}) {
  const handlers = new Map(), warnings = [];
  let identityCalls = 0;
  const observer = installDeepSeekObserver({
    on(name, callback) {
      handlers.set(name, callback);
      return () => handlers.delete(name);
    },
  }, {
    boundary: { before, after },
    identity: () => { identityCalls++; return { sessionId: 'session', agentId: 'agent' }; },
    onError: code => warnings.push(code), shutdownResultWaitMs: wait,
  });
  const exec = id => ({ callId: id, name: 'fixed_read', arguments: { key: id },
    signal: new AbortController().signal });
  const pre = async call => handlers.get('tools/pre-execute')(call, () => ({ kind: 'host-owned' }));
  return { observer, handlers, warnings, exec, pre, identityCalls: () => identityCalls };
}

test('missing accepted result reaches a bounded shutdown without fabricating an outcome', async () => {
  const outcomes = [];
  const f = fixture({ after: (...args) => outcomes.push(args), wait: 20 });
  const call = f.exec('missing');
  await f.pre(call);
  const oldResult = f.handlers.get('tools/result');
  const receipt = await f.observer.dispose();
  assert.deepEqual(receipt, { missingResults: 1 });
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(f.warnings, ['reflexmesh_shadow_result_missing_on_shutdown']);
  assert.equal(f.handlers.size, 0);
  const identities = f.identityCalls();
  assert.equal(oldResult(call, { isError: false, content: [] }), undefined);
  assert.equal(f.identityCalls(), identities);
  assert.deepEqual(outcomes, []);
  assert.strictEqual(await f.observer.dispose(), receipt);
});

test('an authoritative result arriving inside the shutdown window is drained exactly once', async () => {
  const outcomes = [];
  const f = fixture({ after: (...args) => outcomes.push(args), wait: 1000 });
  const call = f.exec('within-budget');
  await f.pre(call);
  const closing = f.observer.dispose();
  f.handlers.get('tools/result')(call, { isError: false, content: [] });
  const receipt = await closing;
  assert.deepEqual(receipt, { missingResults: 0 });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0][1], 'succeeded');
  assert.deepEqual(f.warnings, []);
});

test('queued or running after work cannot be abandoned at the result deadline', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ after: async () => { entered.resolve(); await gate.promise; } });
  const call = f.exec('after-in-flight');
  await f.pre(call);
  f.handlers.get('tools/result')(call, { isError: false, content: [] });
  let closed = false;
  const closing = f.observer.dispose().then(receipt => { closed = true; return receipt; });
  await entered.promise;
  assert.equal(closed, false);
  gate.resolve();
  assert.deepEqual(await closing, { missingResults: 0 });
  assert.equal(f.handlers.size, 0);
});

test('a pending before write remains owned after deadline and later becomes missing', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ before: async () => { entered.resolve(); await gate.promise; } });
  const call = f.exec('before-in-flight');
  const pre = f.pre(call);
  await entered.promise;
  let closed = false;
  const closing = f.observer.dispose().then(receipt => { closed = true; return receipt; });
  await Promise.resolve();
  assert.equal(closed, false);
  gate.resolve();
  await pre;
  assert.deepEqual(await closing, { missingResults: 1 });
  assert.equal(f.handlers.size, 0);
});

test('early result cannot release pending before or attach a later replacement result', async () => {
  const gate = deferred(), entered = deferred(), outcomes = [];
  const f = fixture({ before: async () => { entered.resolve(); await gate.promise; },
    after: (...args) => outcomes.push(args) });
  const call = f.exec('early-result');
  const pre = f.pre(call);
  await entered.promise;
  const oldResult = f.handlers.get('tools/result');
  oldResult(call, { isError: false, content: [] });
  assert.deepEqual(f.warnings, ['reflexmesh_shadow_observation_failed']);
  let closed = false;
  const closing = f.observer.dispose().then(receipt => { closed = true; return receipt; });
  await Promise.resolve();
  assert.equal(closed, false);
  oldResult(call, { isError: false, content: [] });
  gate.resolve();
  await pre;
  assert.deepEqual(await closing, { missingResults: 0 });
  assert.deepEqual(outcomes, []);
  assert.equal(f.handlers.size, 0);
});

test('mixed valid, missing and in-flight results drain without losing accepted writes', async () => {
  const gate = deferred(), entered = deferred(), outcomes = [];
  const f = fixture({ after: async (call, status) => {
    outcomes.push([call.callId, status]);
    if (call.callId === 'gated') { entered.resolve(); await gate.promise; }
  } });
  const gated = f.exec('gated'), missing = f.exec('missing'), completed = f.exec('completed');
  for (const call of [gated, missing, completed]) await f.pre(call);
  const result = f.handlers.get('tools/result');
  result(gated, { isError: false, content: [] });
  result(completed, { isError: true, error: { info: { code: 'ABORTED' } } });
  let closed = false;
  const closing = f.observer.dispose().then(receipt => { closed = true; return receipt; });
  await entered.promise;
  assert.equal(closed, false);
  gate.resolve();
  assert.deepEqual(await closing, { missingResults: 1 });
  assert.deepEqual(outcomes, [['gated', 'succeeded'], ['completed', 'unknown']]);
  assert.deepEqual(f.warnings, ['reflexmesh_shadow_result_missing_on_shutdown']);
});

test('zero-budget warning reentry shares one shutdown and counts one missing result', async () => {
  const handlers = new Map(), warnings = [];
  let observer, nestedDispose;
  observer = installDeepSeekObserver({ on(name, callback) {
    handlers.set(name, callback);
    return () => handlers.delete(name);
  } }, {
    boundary: { before() {}, after() { assert.fail('No result was accepted'); } },
    identity: () => ({ sessionId: 'session', agentId: 'agent' }),
    shutdownResultWaitMs: 0,
    onError: code => {
      warnings.push(code);
      if (code === 'reflexmesh_shadow_result_missing_on_shutdown') nestedDispose = observer.dispose();
    },
  });
  const exec = { callId: 'reentrant', name: 'fixed_read', arguments: {},
    signal: new AbortController().signal };
  await handlers.get('tools/pre-execute')(exec, () => ({ kind: 'host-owned' }));
  const receipt = await observer.dispose();
  assert.ok(nestedDispose);
  assert.strictEqual(await nestedDispose, receipt);
  assert.deepEqual(receipt, { missingResults: 1 });
  assert.deepEqual(warnings, ['reflexmesh_shadow_result_missing_on_shutdown']);
  assert.equal(handlers.size, 0);
});

test('shutdown budget validation fails before any host listener is registered', () => {
  for (const value of [-1, 60_001, 1.5, NaN, Infinity, '20']) {
    let listeners = 0;
    assert.throws(() => installDeepSeekObserver({ on() { listeners++; return () => {}; } }, {
      boundary: { before() {}, after() {} }, identity: () => ({}), shutdownResultWaitMs: value,
    }), /Invalid DeepSeek shutdown result wait/);
    assert.equal(listeners, 0);
  }
});
