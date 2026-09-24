import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeepSeekHostPlugin } from '../adapters/deepseek-host-plugin.mjs';

// Synthetic effect model only: Cordis 4.0.2 itself is covered by the opt-in
// installed-package probe, not by ordinary CI. This models collected cleanup
// callbacks running LIFO and a fiber cleanup racing the plugin disposer.
function syntheticEffectContext() {
  const handlers = new Map(), effects = [];
  const ctx = {
    on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); },
    effect(generator) {
      const iterator = generator(), cleanups = [];
      try {
        for (let step = iterator.next(); ; step = iterator.next()) {
          if (typeof step.value === 'function') cleanups.push(step.value);
          if (step.done) break;
        }
      } catch (error) {
        for (const cleanup of cleanups.reverse()) cleanup();
        throw error;
      }
      let draining;
      const dispose = () => {
        draining ??= (async () => { for (const cleanup of [...cleanups].reverse()) await cleanup(); })();
        return draining;
      };
      effects.push(dispose);
      return dispose;
    },
  };
  return { ctx, handlers, autoUnload: disposePlugin => Promise.all([disposePlugin(), ...effects.map(effect => effect())]) };
}

test('Cordis-shaped plugin delegates host policy and awaits outcome drain on unload', async () => {
  const handlers = new Map();
  const ctx = { on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); } };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let afterCalls = 0, kernelClosed = false;
  const boundary = {
    async before(_call, intent) { assert.equal(intent.summary, 'Synthetic task'); },
    async after() { await gate; afterCalls += 1; },
    close() { kernelClosed = true; },
  };
  const plugin = createDeepSeekHostPlugin({
    boundary,
    identity: () => ({ sessionId: 's1', agentId: 'a1' }),
    resolveIntent: () => ({ summary: 'Synthetic task' }),
  });
  const unload = plugin.apply(ctx);
  assert.equal(plugin.mounted, true);
  assert.throws(() => plugin.apply(ctx), /already mounted/);
  const exec = { callId: 'c1', name: 'synthetic_probe', arguments: {}, signal: new AbortController().signal };
  const decision = { kind: 'deny', reason: 'host policy' };
  assert.strictEqual(await handlers.get('tools/pre-execute')(exec, async () => decision), decision);
  assert.equal(handlers.get('tools/result')(exec, { isError: false, content: [] }), undefined);
  let unloaded = false;
  const pendingUnload = Promise.resolve(unload()).then(() => { unloaded = true; });
  await Promise.resolve();
  assert.equal(unloaded, false);
  assert.equal(handlers.size, 1);
  release();
  await pendingUnload;
  assert.equal(unloaded, true);
  assert.equal(afterCalls, 1);
  assert.equal(plugin.mounted, false);
  assert.equal(kernelClosed, false);
  assert.equal(handlers.size, 0);
});

test('plugin rejects missing boundary without mounting host hooks', () => {
  assert.throws(() => createDeepSeekHostPlugin({}), /Boundary required/);
});

test('unload waits for accepted pre through host result and ignores unrelated work', async () => {
  const handlers = new Map();
  const ctx = { on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); } };
  let enterBefore, releaseBefore, releaseAfter;
  const beforeEntered = new Promise(resolve => { enterBefore = resolve; });
  const beforeGate = new Promise(resolve => { releaseBefore = resolve; });
  const afterGate = new Promise(resolve => { releaseAfter = resolve; });
  let beforeCalls = 0, afterCalls = 0;
  const plugin = createDeepSeekHostPlugin({
    boundary: {
      async before() { beforeCalls += 1; enterBefore(); await beforeGate; },
      async after() { await afterGate; afterCalls += 1; },
    },
    identity: () => ({ sessionId: 's1', agentId: 'a1' }),
  });
  const unload = plugin.apply(ctx);
  const pre = handlers.get('tools/pre-execute');
  const exec = { callId: 'c1', name: 'synthetic_probe', arguments: {}, signal: new AbortController().signal };
  const runningPre = pre(exec, async () => ({ kind: 'allow' }));
  await beforeEntered;
  let settled = false;
  const disposing = Promise.resolve(unload()).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(handlers.size, 1);
  assert.deepEqual(await pre({ ...exec, callId: 'late' }, async () => ({ kind: 'deny', reason: 'host' })), { kind: 'deny', reason: 'host' });
  assert.equal(beforeCalls, 1);
  handlers.get('tools/result')({ ...exec, callId: 'unrelated' }, { isError: false, content: [] });
  releaseBefore();
  await runningPre;
  handlers.get('tools/result')(exec, { isError: false, content: [] });
  await Promise.resolve();
  assert.equal(settled, false);
  releaseAfter();
  await disposing;
  assert.equal(afterCalls, 1);
  assert.equal(handlers.size, 0);
});

test('result-listener setup failure removes already registered pre hook', () => {
  const handlers = new Map();
  const ctx = {
    on(name, callback) {
      if (name === 'tools/result') throw new Error('result unavailable');
      handlers.set(name, callback); return () => handlers.delete(name);
    },
  };
  const plugin = createDeepSeekHostPlugin({ boundary: { before() {}, after() {} }, identity: () => ({ sessionId: 's', agentId: 'a' }) });
  assert.throws(() => plugin.apply(ctx), /result unavailable/);
  assert.equal(handlers.size, 0);
  assert.equal(plugin.mounted, false);
});

test('synthetic composite effect drains gated pre and outcome during concurrent auto/manual unload', async () => {
  const { ctx, handlers, autoUnload } = syntheticEffectContext();
  let enterPre, releasePre, enterAfter, releaseAfter;
  const preEntered = new Promise(resolve => { enterPre = resolve; });
  const preGate = new Promise(resolve => { releasePre = resolve; });
  const afterEntered = new Promise(resolve => { enterAfter = resolve; });
  const afterGate = new Promise(resolve => { releaseAfter = resolve; });
  let beforeCalls = 0, afterCalls = 0, hostNextCalls = 0;
  const plugin = createDeepSeekHostPlugin({
    boundary: {
      async before() { beforeCalls += 1; enterPre(); await preGate; },
      async after() { enterAfter(); await afterGate; afterCalls += 1; },
    },
    identity: () => ({ sessionId: 'synthetic-session', agentId: 'synthetic-agent' }),
  });
  const unload = plugin.apply(ctx);
  const pre = handlers.get('tools/pre-execute');
  const exec = { callId: 'synthetic-call', name: 'synthetic_probe', arguments: {}, signal: new AbortController().signal };
  const runningPre = pre(exec, async () => { hostNextCalls += 1; return { kind: 'allow' }; });
  await preEntered;
  let settled = false;
  const disposing = Promise.all([autoUnload(unload), unload()]).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(handlers.has('tools/pre-execute'), false);
  assert.equal(handlers.has('tools/result'), true);
  assert.deepEqual(await pre({ ...exec, callId: 'late' }, async () => { hostNextCalls += 1; return { kind: 'deny', reason: 'host' }; }), { kind: 'deny', reason: 'host' });
  assert.equal(beforeCalls, 1);
  releasePre();
  await runningPre;
  handlers.get('tools/result')(exec, { isError: false, content: [] });
  await afterEntered;
  assert.equal(settled, false);
  releaseAfter();
  await disposing;
  assert.equal(hostNextCalls, 2);
  assert.equal(afterCalls, 1);
  assert.equal(plugin.mounted, false);
  assert.equal(handlers.size, 0);
});

test('synthetic concurrent Cordis/manual unload shares a missing-result deadline', async () => {
  const { ctx, handlers, autoUnload } = syntheticEffectContext();
  const warnings = [];
  let afterCalls = 0;
  const plugin = createDeepSeekHostPlugin({
    boundary: { before() {}, after() { afterCalls++; } },
    identity: () => ({ sessionId: 'synthetic-session', agentId: 'synthetic-agent' }),
    onError: code => warnings.push(code), shutdownResultWaitMs: 0,
  });
  const unload = plugin.apply(ctx);
  const exec = { callId: 'missing-result', name: 'synthetic_probe', arguments: {},
    signal: new AbortController().signal };
  await handlers.get('tools/pre-execute')(exec, () => ({ kind: 'host-owned' }));
  const oldResult = handlers.get('tools/result');
  await Promise.all([autoUnload(unload), unload()]);
  oldResult(exec, { isError: false, content: [] });
  assert.deepEqual(warnings, ['reflexmesh_shadow_result_missing_on_shutdown']);
  assert.equal(afterCalls, 0);
  assert.equal(plugin.mounted, false);
  assert.equal(handlers.size, 0);
});

test('synthetic 257 accepted candidates cap at 256 observations without suppressing host next', async () => {
  const { ctx, handlers, autoUnload } = syntheticEffectContext();
  let beforeCalls = 0, afterCalls = 0, hostNextCalls = 0, diagnostics = 0;
  const plugin = createDeepSeekHostPlugin({
    boundary: { async before() { beforeCalls += 1; }, async after() { afterCalls += 1; } },
    identity: () => ({ sessionId: 'synthetic-session', agentId: 'synthetic-agent' }),
    onError: () => { diagnostics += 1; },
  });
  const unload = plugin.apply(ctx);
  const calls = [];
  for (let index = 0; index < 257; index += 1) {
    const exec = { callId: `synthetic-${index}`, name: 'synthetic_probe', arguments: {}, signal: new AbortController().signal };
    calls.push(exec);
    await handlers.get('tools/pre-execute')(exec, async () => { hostNextCalls += 1; return { kind: 'allow' }; });
  }
  assert.equal(beforeCalls, 256);
  assert.equal(hostNextCalls, 257);
  assert.equal(diagnostics, 1);
  for (const exec of calls) handlers.get('tools/result')(exec, { isError: false, content: [] });
  await plugin.flush();
  assert.equal(afterCalls, 256);
  await autoUnload(unload);
  assert.equal(handlers.size, 0);
});

test('synthetic composite registration failure removes pre hook', () => {
  const { ctx, handlers } = syntheticEffectContext();
  const register = ctx.on;
  ctx.on = (name, callback) => {
    if (name === 'tools/result') throw new Error('synthetic result registration failed');
    return register(name, callback);
  };
  const plugin = createDeepSeekHostPlugin({ boundary: { before() {}, after() {} }, identity: () => ({ sessionId: 's', agentId: 'a' }) });
  assert.throws(() => plugin.apply(ctx), /synthetic result registration failed/);
  assert.equal(handlers.size, 0);
  assert.equal(plugin.mounted, false);
});
