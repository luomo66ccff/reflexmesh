import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import plugin, { validateDeepSeekLoaderConfig } from '../adapters/deepseek-loader-plugin.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { TaskAwareBoundary } from '../adapters/task-boundary.mjs';
import { createDeepSeekStorageFence } from '../adapters/deepseek-storage-fence.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function cleanup(root) {
  const target = realpathSync(root);
  const rel = relative(realpathSync(tmpdir()), target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
    && basename(target).startsWith('reflexmesh-loader-test-'));
  rmSync(target, { recursive: true, force: true });
}

function mockContext() {
  const listeners = new Map();
  const agents = new Map();
  const services = new Map();
  const ctx = {
    agents: { get: id => agents.get(id) },
    logger: { warn() {} },
    provide: (name, value) => { services.set(name, value); return () => services.delete(name); },
    on(name, callback) {
      const group = listeners.get(name) ?? new Set();
      group.add(callback); listeners.set(name, group);
      return () => group.delete(callback);
    },
  };
  const emit = (name, ...args) => [...listeners.get(name) ?? []].map(callback => callback(...args));
  return { ctx, agents, services, listeners, emit };
}

test('Loader storage facade revokes every boundary method without exposing close', () => {
  const methods = ['registerPack', 'claim', 'append', 'complete', 'abandon', 'inspect', 'observe'];
  assert.throws(() => createDeepSeekStorageFence(Object.fromEntries(methods.map(name => [name, () => {}]))),
    /storage kernel required/);
  const raw = new SqliteKernel(':memory:');
  try {
    raw.observe = async () => { throw new Error('unsafe async override'); };
    assert.throws(() => createDeepSeekStorageFence(raw), /storage kernel required/);
    delete raw.observe;
    const fence = createDeepSeekStorageFence(raw);
    assert.equal(fence.revoked, false);
    assert.equal(Object.isFrozen(fence.kernel), true);
    assert.equal('close' in fence.kernel, false);
    raw.inspect = async () => { throw new Error('unsafe late override'); };
    assert.equal(fence.kernel.inspect('missing'), undefined);
    fence.revoke();
    fence.revoke();
    assert.equal(fence.revoked, true);
    for (const name of methods) assert.throws(() => fence.kernel[name](), /storage revoked/);
  } finally { raw.close(); }
});

test('opt-in Loader fence ends a forever-pending admission without a late SQLite write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'ledger.sqlite');
  const f = mockContext(), warnings = [];
  f.ctx.logger.warn = code => warnings.push(code);
  const agent = { id: 'agent-fenced-before', session: { id: 'agent-fenced-before' } };
  f.agents.set(agent.id, agent);
  const gate = deferred(), entered = deferred();
  const originalBefore = TaskAwareBoundary.prototype.before;
  let lateError, nextCalls = 0, dispose, pendingPre;
  TaskAwareBoundary.prototype.before = async function(...args) {
    entered.resolve();
    await gate.promise;
    try { return await originalBefore.call(this, ...args); }
    catch (error) { lateError = error; throw error; }
  };
  try {
    dispose = await plugin.apply(f.ctx, { dbPath, tenantId: 'isolated', scope: 'fixture',
      shutdownResultWaitMs: 0, shutdownDrainWaitMs: 0 });
    const exec = { agent, signal: new AbortController().signal, callId: 'fenced-before',
      name: 'fixture_read', arguments: {} };
    pendingPre = f.emit('tools/pre-execute', exec, () => { nextCalls++; })[0];
    await entered.promise;
    const ready = f.services.get('reflexmeshObserverReady');
    const closing = dispose();
    assert.strictEqual(dispose(), closing);
    await closing;
    await pendingPre;
    assert.equal(nextCalls, 1);
    assert.equal(ready.observerDrained, false);
    assert.equal(ready.kernelClosed, true);
    assert.equal(ready.storageRevoked, true);
    assert.equal(ready.shutdownMissingResults, 0);
    assert.deepEqual(ready.shutdownDrain, { closing: true, resultWindowClosed: true,
      pendingBefore: 0, pendingResults: 0, pendingAfter: 0, missingResults: 0,
      storageRevoked: true, detachedBefore: 1, detachedAfter: 0 });
    assert.deepEqual(warnings, ['reflexmesh_shadow_shutdown_drain_pending',
      'reflexmesh_shadow_shutdown_storage_revoked']);
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(lateError?.message ?? '', /storage revoked/);
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    try { assert.equal(kernel.listEvidence().items.length, 0); }
    finally { kernel.close(); }
    assert.equal(ready.shutdownDrain.detachedBefore, 1);
  } finally {
    gate.resolve();
    try { await pendingPre; } catch {}
    try { await dispose?.(); } catch {}
    TaskAwareBoundary.prototype.before = originalBefore;
    cleanup(root);
  }
});

test('fenced Loader keeps an already committed outcome when its callback later hangs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'ledger.sqlite');
  const f = mockContext();
  const agent = { id: 'agent-committed-after', session: { id: 'agent-committed-after' } };
  f.agents.set(agent.id, agent);
  const gate = deferred(), entered = deferred();
  const originalAfter = TaskAwareBoundary.prototype.after;
  let dispose;
  TaskAwareBoundary.prototype.after = async function(...args) {
    const result = originalAfter.call(this, ...args);
    entered.resolve();
    await gate.promise;
    return result;
  };
  try {
    dispose = await plugin.apply(f.ctx, { dbPath, tenantId: 'isolated', scope: 'fixture',
      shutdownResultWaitMs: 0, shutdownDrainWaitMs: 0 });
    const exec = { agent, signal: new AbortController().signal, callId: 'committed-after',
      name: 'fixture_read', arguments: {} };
    await f.emit('tools/pre-execute', exec, () => undefined)[0];
    f.emit('tools/result', exec, { isError: false, content: [] });
    await entered.promise;
    const ready = f.services.get('reflexmeshObserverReady');
    await dispose();
    assert.equal(ready.observerDrained, false);
    assert.equal(ready.storageRevoked, true);
    assert.equal(ready.shutdownDrain.detachedAfter, 1);
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    try {
      const rows = kernel.listEvidence({ limit: 2 }).items;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hostOutcome.status, 'succeeded');
      assert.equal(rows[0].hostOutcome.count, 1);
      assert.equal(rows[0].labelCount, 0);
    } finally { kernel.close(); }
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready.shutdownDrain.detachedAfter, 1);
  } finally {
    gate.resolve();
    try { await dispose?.(); } catch {}
    TaskAwareBoundary.prototype.after = originalAfter;
    cleanup(root);
  }
});

test('nonzero fenced drain window preserves a callback that settles before its deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'ledger.sqlite');
  const f = mockContext(), warnings = [];
  f.ctx.logger.warn = code => warnings.push(code);
  const agent = { id: 'agent-in-window', session: { id: 'agent-in-window' } };
  f.agents.set(agent.id, agent);
  const gate = deferred(), entered = deferred();
  const originalAfter = TaskAwareBoundary.prototype.after;
  let dispose;
  TaskAwareBoundary.prototype.after = async function(...args) {
    entered.resolve();
    await gate.promise;
    return originalAfter.call(this, ...args);
  };
  try {
    dispose = await plugin.apply(f.ctx, { dbPath, tenantId: 'isolated', scope: 'fixture',
      shutdownResultWaitMs: 0, shutdownDrainWaitMs: 1000 });
    const exec = { agent, signal: new AbortController().signal, callId: 'in-window',
      name: 'fixture_read', arguments: {} };
    await f.emit('tools/pre-execute', exec, () => undefined)[0];
    f.emit('tools/result', exec, { isError: false, content: [] });
    await entered.promise;
    const ready = f.services.get('reflexmeshObserverReady');
    const closing = dispose();
    gate.resolve();
    await closing;
    assert.equal(ready.observerDrained, true);
    assert.equal(ready.kernelClosed, true);
    assert.equal(ready.storageRevoked, false);
    assert.equal(ready.shutdownDrain.detachedBefore, 0);
    assert.equal(ready.shutdownDrain.detachedAfter, 0);
    assert.deepEqual(warnings, ['reflexmesh_shadow_shutdown_drain_pending']);
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    try {
      const rows = kernel.listEvidence({ limit: 2 }).items;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hostOutcome.status, 'succeeded');
      assert.equal(rows[0].hostOutcome.count, 1);
    } finally { kernel.close(); }
  } finally {
    gate.resolve();
    try { await dispose?.(); } catch {}
    TaskAwareBoundary.prototype.after = originalAfter;
    cleanup(root);
  }
});

test('fenced Loader shares one shutdown across Cordis-shaped effect and manual disposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'ledger.sqlite');
  const f = mockContext(), effects = [], warnings = [];
  f.ctx.logger.warn = code => warnings.push(code);
  f.ctx.effect = generator => {
    const iterator = generator(), cleanups = [];
    for (let step = iterator.next(); ; step = iterator.next()) {
      if (typeof step.value === 'function') cleanups.push(step.value);
      if (step.done) break;
    }
    let stopping;
    const stop = () => stopping ??= (async () => {
      for (const cleanup of [...cleanups].reverse()) await cleanup();
    })();
    effects.push(stop);
    return stop;
  };
  const agent = { id: 'agent-dual-unload', session: { id: 'agent-dual-unload' } };
  f.agents.set(agent.id, agent);
  const gate = deferred(), entered = deferred();
  const originalAfter = TaskAwareBoundary.prototype.after;
  let dispose;
  TaskAwareBoundary.prototype.after = async function(...args) {
    entered.resolve();
    await gate.promise;
    return originalAfter.call(this, ...args);
  };
  try {
    dispose = await plugin.apply(f.ctx, { dbPath, tenantId: 'isolated', scope: 'fixture',
      shutdownResultWaitMs: 0, shutdownDrainWaitMs: 0 });
    assert.equal(effects.length, 1);
    const exec = { agent, signal: new AbortController().signal, callId: 'dual-unload',
      name: 'fixture_read', arguments: {} };
    await f.emit('tools/pre-execute', exec, () => undefined)[0];
    f.emit('tools/result', exec, { isError: false, content: [] });
    await entered.promise;
    const ready = f.services.get('reflexmeshObserverReady');
    await Promise.all([effects[0](), dispose(), dispose()]);
    assert.equal(ready.observerDrained, false);
    assert.equal(ready.kernelClosed, true);
    assert.equal(ready.shutdownDrain.detachedAfter, 1);
    assert.deepEqual(warnings, ['reflexmesh_shadow_shutdown_drain_pending',
      'reflexmesh_shadow_shutdown_storage_revoked']);
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings.length, 2);
  } finally {
    gate.resolve();
    try { await dispose?.(); } catch {}
    TaskAwareBoundary.prototype.after = originalAfter;
    cleanup(root);
  }
});

test('opt-in Loader fence ends a forever-pending result write without inventing an outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'ledger.sqlite');
  const f = mockContext(), warnings = [];
  f.ctx.logger.warn = code => warnings.push(code);
  const agent = { id: 'agent-fenced-after', session: { id: 'agent-fenced-after' } };
  f.agents.set(agent.id, agent);
  const gate = deferred(), entered = deferred();
  const originalAfter = TaskAwareBoundary.prototype.after;
  let lateError, dispose;
  TaskAwareBoundary.prototype.after = async function(...args) {
    entered.resolve();
    await gate.promise;
    try { return originalAfter.call(this, ...args); }
    catch (error) { lateError = error; throw error; }
  };
  try {
    dispose = await plugin.apply(f.ctx, { dbPath, tenantId: 'isolated', scope: 'fixture',
      shutdownResultWaitMs: 0, shutdownDrainWaitMs: 0 });
    const exec = { agent, signal: new AbortController().signal, callId: 'fenced-after',
      name: 'fixture_read', arguments: {} };
    await f.emit('tools/pre-execute', exec, () => undefined)[0];
    f.emit('tools/result', exec, { isError: false, content: [] });
    await entered.promise;
    const ready = f.services.get('reflexmeshObserverReady');
    await dispose();
    assert.equal(ready.observerDrained, false);
    assert.equal(ready.kernelClosed, true);
    assert.equal(ready.storageRevoked, true);
    assert.deepEqual(ready.shutdownDrain, { closing: true, resultWindowClosed: true,
      pendingBefore: 0, pendingResults: 0, pendingAfter: 0, missingResults: 0,
      storageRevoked: true, detachedBefore: 0, detachedAfter: 1 });
    assert.deepEqual(warnings, ['reflexmesh_shadow_shutdown_drain_pending',
      'reflexmesh_shadow_shutdown_storage_revoked']);
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(lateError?.message ?? '', /storage revoked/);
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    try {
      const rows = kernel.listEvidence({ limit: 2 }).items;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hostOutcome.status, 'missing');
      assert.equal(rows[0].hostOutcome.count, 0);
      assert.equal(rows[0].labelCount, 0);
    } finally { kernel.close(); }
    assert.equal(warnings.length, 2);
  } finally {
    gate.resolve();
    try { await dispose?.(); } catch {}
    TaskAwareBoundary.prototype.after = originalAfter;
    cleanup(root);
  }
});

test('loader configuration fails before creating a database and never adopts provider env', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'private', 'ledger.sqlite');
  const f = mockContext();
  const base = { dbPath, tenantId: 'tenant', scope: 'scope' };
  try {
    assert.equal(validateDeepSeekLoaderConfig(base).intentMode, 'off');
    assert.throws(() => validateDeepSeekLoaderConfig({ ...base, dbPath: 'relative.sqlite' }));
    assert.throws(() => validateDeepSeekLoaderConfig({ ...base, intentMode: 'ambient' }));
    assert.throws(() => validateDeepSeekLoaderConfig({ ...base, provider: 'jev' }));
    for (const shutdownResultWaitMs of [-1, 60_001, 1.5, NaN, Infinity, '20']) {
      assert.throws(() => validateDeepSeekLoaderConfig({ ...base, shutdownResultWaitMs }));
    }
    for (const shutdownDrainWaitMs of [-1, 60_001, 1.5, NaN, Infinity, '20']) {
      assert.throws(() => validateDeepSeekLoaderConfig({ ...base, shutdownDrainWaitMs }));
    }
    assert.equal(validateDeepSeekLoaderConfig({ ...base, shutdownResultWaitMs: 0 }).shutdownResultWaitMs, 0);
    assert.equal(validateDeepSeekLoaderConfig({ ...base, shutdownDrainWaitMs: 0 }).shutdownDrainWaitMs, 0);
    await assert.rejects(plugin.apply(f.ctx, { ...base, shutdownResultWaitMs: -1 }));
    await assert.rejects(plugin.apply(f.ctx, { ...base, provider: 'jev' }));
    assert.equal(existsSync(join(root, 'private')), false);

    const oldProvider = process.env.REFLEXMESH_PROVIDER;
    const oldRemote = process.env.REFLEXMESH_ALLOW_REMOTE;
    process.env.REFLEXMESH_PROVIDER = 'jev';
    process.env.REFLEXMESH_ALLOW_REMOTE = 'true';
    try {
      const dispose = await plugin.apply(f.ctx, base);
      assert.equal(f.services.get('reflexmeshObserverReady')?.observerDrained, false);
      await dispose();
      assert.equal(f.services.get('reflexmeshObserverReady')?.kernelClosed, true);
    } finally {
      if (oldProvider === undefined) delete process.env.REFLEXMESH_PROVIDER;
      else process.env.REFLEXMESH_PROVIDER = oldProvider;
      if (oldRemote === undefined) delete process.env.REFLEXMESH_ALLOW_REMOTE;
      else process.env.REFLEXMESH_ALLOW_REMOTE = oldRemote;
    }
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    try { assert.deepEqual(kernel.listEvidence().items, []); }
    finally { kernel.close(); }
  } finally { cleanup(root); }
});

test('loader closes owned kernel after missing accepted result without inventing a host outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'ledger.sqlite');
  const f = mockContext(), warnings = [];
  f.ctx.logger.warn = code => warnings.push(code);
  const agent = { id: 'agent-missing', session: { id: 'agent-missing' } };
  f.agents.set(agent.id, agent);
  let dispose;
  try {
    dispose = await plugin.apply(f.ctx, { dbPath, tenantId: 'isolated', scope: 'fixture',
      intentMode: 'explicit-summary', shutdownResultWaitMs: 0 });
    f.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } });
    f.emit('agent/inbox/claimed', { agent, turn: 1, message: { id: 'user-missing', role: 'user',
      source: { kind: 'user' }, content: [{ type: 'text', text: 'ReflexMesh-Intent: Fixed missing-result fixture' }] } });
    const signal = new AbortController().signal;
    await f.emit('agent/pre-step', { agent, turn: 1, step: 1, signal, messages: [] },
      () => Promise.resolve({ kind: 'enter' }))[0];
    const exec = { agent, signal, callId: 'missing-result', name: 'fixture_read', arguments: {} };
    await f.emit('tools/pre-execute', exec, () => Promise.resolve(undefined))[0];
    const ready = f.services.get('reflexmeshObserverReady');
    assert.equal(ready.kernelClosed, false);
    await dispose();
    assert.equal(ready.observerDrained, true);
    assert.equal(ready.kernelClosed, true);
    assert.equal(ready.shutdownMissingResults, 1);
    assert.deepEqual(warnings, ['reflexmesh_shadow_result_missing_on_shutdown']);
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    try {
      const rows = kernel.listEvidence({ limit: 2 }).items;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hostOutcome.status, 'missing');
      assert.equal(rows[0].hostOutcome.count, 0);
      assert.equal(rows[0].labelCount, 0);
      const attention = kernel.listAttention({ limit: 2 }).items;
      assert.equal(attention.length, 1);
      assert.deepEqual(attention[0].attention.reasons.map(reason => reason.code), ['shadow_outcome_missing']);
    } finally { kernel.close(); }
  } finally {
    try { await dispose?.(); } catch {}
    cleanup(root);
  }
});

test('loader reports live missing count while an admission still prevents safe closure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'ledger.sqlite');
  const f = mockContext(), warnings = [];
  f.ctx.logger.warn = code => warnings.push(code);
  const agent = { id: 'agent-pending', session: { id: 'agent-pending' } };
  f.agents.set(agent.id, agent);
  const gate = deferred(), entered = deferred();
  const originalBefore = TaskAwareBoundary.prototype.before;
  TaskAwareBoundary.prototype.before = async function(call, intent) {
    if (call.callId === 'blocked-admission') { entered.resolve(); await gate.promise; }
    return originalBefore.call(this, call, intent);
  };
  let dispose, pendingPre, closing;
  try {
    dispose = await plugin.apply(f.ctx, { dbPath, tenantId: 'isolated', scope: 'fixture',
      intentMode: 'explicit-summary', shutdownResultWaitMs: 0 });
    f.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } });
    f.emit('agent/inbox/claimed', { agent, turn: 1, message: { id: 'user-pending', role: 'user',
      source: { kind: 'user' }, content: [{ type: 'text', text: 'ReflexMesh-Intent: Fixed pending admission fixture' }] } });
    const signal = new AbortController().signal;
    await f.emit('agent/pre-step', { agent, turn: 1, step: 1, signal, messages: [] },
      () => Promise.resolve({ kind: 'enter' }))[0];
    const exec = callId => ({ agent, signal, callId, name: 'fixture_read', arguments: {} });
    await f.emit('tools/pre-execute', exec('missing-result'), () => undefined)[0];
    pendingPre = f.emit('tools/pre-execute', exec('blocked-admission'), () => undefined)[0];
    await entered.promise;
    const ready = f.services.get('reflexmeshObserverReady');
    closing = dispose();
    const snapshot = ready.shutdownDrain;
    assert.equal(Object.isFrozen(snapshot), true);
    assert.deepEqual(snapshot, { closing: true, resultWindowClosed: true,
      pendingBefore: 1, pendingResults: 0, pendingAfter: 0, missingResults: 1,
      storageRevoked: false, detachedBefore: 0, detachedAfter: 0 });
    assert.equal(ready.shutdownMissingResults, 1);
    assert.equal(ready.observerDrained, false);
    assert.equal(ready.kernelClosed, false);
    assert.deepEqual(warnings, ['reflexmesh_shadow_result_missing_on_shutdown',
      'reflexmesh_shadow_shutdown_drain_pending']);
    gate.resolve();
    await pendingPre;
    await closing;
    assert.equal(ready.shutdownMissingResults, 2);
    assert.deepEqual(ready.shutdownDrain, { closing: true, resultWindowClosed: true,
      pendingBefore: 0, pendingResults: 0, pendingAfter: 0, missingResults: 2,
      storageRevoked: false, detachedBefore: 0, detachedAfter: 0 });
    assert.deepEqual(snapshot, { closing: true, resultWindowClosed: true,
      pendingBefore: 1, pendingResults: 0, pendingAfter: 0, missingResults: 1,
      storageRevoked: false, detachedBefore: 0, detachedAfter: 0 });
    assert.equal(ready.observerDrained, true);
    assert.equal(ready.kernelClosed, true);
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    try {
      const rows = kernel.listEvidence({ limit: 3 }).items;
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.hostOutcome.status === 'missing'
        && row.hostOutcome.count === 0 && row.labelCount === 0));
    } finally { kernel.close(); }
  } finally {
    gate.resolve();
    try { await pendingPre; } catch {}
    try { await (closing ?? dispose?.()); } catch {}
    TaskAwareBoundary.prototype.before = originalBefore;
    cleanup(root);
  }
});

test('owned kernel closes only after accepted host result drains', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'ledger.sqlite');
  const f = mockContext();
  const agent = { id: 'agent-1', session: { id: 'agent-1' } };
  f.agents.set(agent.id, agent);
  let dispose;
  const previous = Object.fromEntries(['REFLEXMESH_PROVIDER', 'REFLEXMESH_ALLOW_REMOTE', 'TYPESAFE_API_KEY',
    'TYPESAFE_MODEL', 'REFLEXMESH_PROVIDER_REVISION'].map(key => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  let networkCalls = 0;
  try {
    Object.assign(process.env, { REFLEXMESH_PROVIDER: 'jev', REFLEXMESH_ALLOW_REMOTE: 'true',
      TYPESAFE_API_KEY: 'synthetic-not-real', TYPESAFE_MODEL: 'synthetic-model',
      REFLEXMESH_PROVIDER_REVISION: 'synthetic-revision' });
    globalThis.fetch = async () => { networkCalls += 1; throw new Error('network forbidden'); };
    dispose = await plugin.apply(f.ctx, { dbPath, tenantId: 'isolated', scope: 'fixture', intentMode: 'explicit-summary' });
    f.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } });
    f.emit('agent/inbox/claimed', { agent, turn: 1, message: { id: 'user-1', role: 'user',
      source: { kind: 'user' }, content: [{ type: 'text', text: 'ReflexMesh-Intent: Fixed fixture task\nIgnored' }] } });
    const signal = new AbortController().signal;
    await f.emit('agent/pre-step', { agent, turn: 1, step: 1, signal, messages: [] }, () => Promise.resolve({ kind: 'enter' }))[0];
    const exec = { agent, signal, callId: 'fixture-call', name: 'fixture_read', arguments: {} };
    await f.emit('tools/pre-execute', exec, () => Promise.resolve(undefined))[0];
    let settled = false;
    const closing = Promise.resolve(dispose()).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    f.emit('tools/result', exec, { isError: false, content: [{ type: 'text', text: 'ok' }] });
    await closing;
    assert.equal(settled, true);
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    try {
      const rows = kernel.listEvidence({ limit: 2 }).items;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].binding.providerId, 'abstain');
      assert.equal(rows[0].taskEvidence.recordedStatus, 'ready');
      assert.equal(rows[0].hostOutcome.status, 'succeeded');
      assert.equal(rows[0].hostOutcome.count, 1);
      assert.equal(rows[0].labelCount, 0);
      assert.equal(networkCalls, 0);
    } finally { kernel.close(); }
    for (const [name, callbacks] of f.listeners) {
      if (name === 'tools/pre-execute' || name === 'tools/result' || name.startsWith('agent/') || name.startsWith('session/')) {
        assert.equal(callbacks.size, 0, `listener leaked: ${name}`);
      }
    }
  } finally {
    try { await dispose?.(); } catch {}
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(root);
  }
});

test('failed ready registration removes observer hooks before closing owned kernel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-loader-test-'));
  const dbPath = join(root, 'ledger.sqlite');
  const f = mockContext();
  f.ctx.provide = () => { throw new Error('synthetic readiness failure'); };
  try {
    await assert.rejects(plugin.apply(f.ctx, { dbPath, tenantId: 'tenant', scope: 'scope' }), /synthetic readiness failure/);
    for (const callbacks of f.listeners.values()) assert.equal(callbacks.size, 0);
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    kernel.close();
  } finally { cleanup(root); }
});
