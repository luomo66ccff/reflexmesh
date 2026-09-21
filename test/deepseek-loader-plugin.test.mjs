import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import plugin, { validateDeepSeekLoaderConfig } from '../adapters/deepseek-loader-plugin.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';

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
