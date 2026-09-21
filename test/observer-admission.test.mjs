import assert from 'node:assert/strict';
import test from 'node:test';
import { toolPreflightPack } from '../dist/index.js';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { TaskAwareBoundary } from '../adapters/task-boundary.mjs';
import { installDeepSeekObserver } from '../adapters/deepseek-plugin.mjs';
import { observeFunctionCall } from '../adapters/openai-compatible.mjs';
import { ABSTAIN_CAPABILITIES } from '../adapters/provider-binding.mjs';

// Synthetic ordering and real journal semantics; not a host restart certification.
function fixture(t, harness) {
  const kernel = new SqliteKernel(':memory:');
  t.after(() => kernel.close());
  const boundary = new TaskAwareBoundary({ kernel, pack: toolPreflightPack,
    provider: { id: 'abstain', capabilities: ABSTAIN_CAPABILITIES,
      evaluate() { throw new Error('Synthetic abstention'); } },
    binding: { providerId: 'abstain', modelId: 'not-configured', revision: 'abstain-v1',
      authorizationRevision: 'host-owned-shadow', toolsetRevision: 'host-owned-shadow' },
    tenantId: 'synthetic', scope: 'admission-regression', clock: () => 1500 });
  const call = { schemaVersion: 1, harness, sessionId: 'same-session', agentId: 'same-agent',
    callId: 'repeated-call', toolName: 'fixed_read', arguments: { key: 'same-key' } };
  const intent = id => ({ schemaVersion: 1, id, source: 'host-declared', summary: `Synthetic task ${id}`,
    scope: { harness, sessionId: call.sessionId, agentId: call.agentId }, issuedAt: 1000, expiresAt: 2000 });
  return { kernel, boundary, call, intent };
}

for (const harness of ['deepseek-harness', 'openai-compatible']) {
  test(`${harness}: rejected new task cannot attach its result to an older decision`, async t => {
    const { boundary, call, intent } = fixture(t, harness);
    await boundary.before(call, intent('old'));
    const original = boundary.inspect(call);
    assert.equal(original.observations.length, 0);
    await assert.rejects(boundary.before(call, intent('new')), /Idempotency conflict/);
    let hostCalls = 0;
    const warnings = [];
    if (harness === 'deepseek-harness') {
      const handlers = new Map();
      const observer = installDeepSeekObserver({ on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } }, {
        boundary, identity: () => ({ sessionId: call.sessionId, agentId: call.agentId }),
        resolveIntent: () => intent('new'), onError: value => warnings.push(value),
      });
      const exec = { callId: call.callId, name: call.toolName, arguments: call.arguments,
        signal: new AbortController().signal };
      const hostDecision = { kind: 'ask', reason: 'host policy remains authoritative' };
      try {
        assert.equal(await handlers.get('tools/pre-execute')(exec, () => { hostCalls++; return hostDecision; }), hostDecision);
        handlers.get('tools/result')(exec, { isError: false, content: [{ type: 'text', text: 'new-task-result' }] });
        await observer.flush();
      } finally { await observer.dispose(); }
    } else {
      const result = await observeFunctionCall({ boundary,
        call: { id: call.callId, type: 'function', function: { name: call.toolName, arguments: JSON.stringify(call.arguments) } },
        identity: { sessionId: call.sessionId, agentId: call.agentId }, resolveIntent: () => intent('new'),
        execute: () => { hostCalls++; return 'new-task-result'; }, onError: value => warnings.push(value) });
      assert.equal(result, 'new-task-result');
    }
    assert.equal(hostCalls, 1);
    assert.deepEqual(boundary.inspect(call), original);
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every(value => value === 'reflexmesh_shadow_observation_failed'));
  });
}

test('function-call admission failure does not journal a thrown host body against an older task', async t => {
  const { boundary, call, intent } = fixture(t, 'openai-compatible');
  await boundary.before(call, intent('old'));
  const original = boundary.inspect(call), hostError = new Error('synthetic host error');
  let calls = 0;
  await assert.rejects(observeFunctionCall({ boundary,
    call: { id: call.callId, type: 'function', function: { name: call.toolName, arguments: JSON.stringify(call.arguments) } },
    identity: { sessionId: call.sessionId, agentId: call.agentId }, resolveIntent: () => intent('new'),
    execute: () => { calls++; throw hostError; },
  }), error => error === hostError);
  assert.equal(calls, 1);
  assert.deepEqual(boundary.inspect(call), original);
});

for (const change of ['callId', 'arguments', 'agent', 'session', 'identity']) {
  test(`DeepSeek result cannot retarget accepted evidence through changed ${change}`, async () => {
    const handlers = new Map(), outcomes = [], warnings = [];
    let resolvedAgent = 'original';
    const exec = { callId: 'original', name: 'fixed_read', arguments: { key: 'original' },
      agent: { id: 'original', session: { id: 'session' } }, signal: new AbortController().signal };
    const observer = installDeepSeekObserver({ on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } }, {
      boundary: { before() {}, after(call) { outcomes.push(call); } },
      identity: () => ({ sessionId: 'session', agentId: resolvedAgent }), onError: value => warnings.push(value),
    });
    try {
      await handlers.get('tools/pre-execute')(exec, () => ({ kind: 'allow' }));
      if (change === 'arguments') exec.arguments.key = 'other';
      else if (change === 'agent') exec.agent = { id: 'original' };
      else if (change === 'session') exec.agent.session = { id: 'session' };
      else if (change === 'identity') resolvedAgent = 'other';
      else exec.callId = 'other';
      handlers.get('tools/result')(exec, { isError: false, content: [] });
      await observer.flush();
      assert.equal(outcomes.length, 0);
      assert.deepEqual(warnings, ['reflexmesh_shadow_observation_failed']);
    } finally { await observer.dispose(); }
  });
}

test('rejected DeepSeek candidates release capacity and drain without awaiting a result', { timeout: 2000 }, async () => {
  const handlers = new Map();
  let reject = true, beforeCalls = 0, hostCalls = 0, outcomes = 0, diagnostics = 0;
  const observer = installDeepSeekObserver({ on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } }, {
    boundary: { before() { beforeCalls++; if (reject) throw new Error('PRIVATE'); }, after() { outcomes++; } },
    identity: () => ({ sessionId: 'session', agentId: 'agent' }),
    onError: value => { assert.equal(value, 'reflexmesh_shadow_observation_failed'); diagnostics++; },
  });
  const execution = callId => ({ callId, name: 'fixed_read', arguments: {}, signal: new AbortController().signal });
  try {
    for (let index = 0; index < 300; index++) {
      await handlers.get('tools/pre-execute')(execution(`rejected-${index}`), () => { hostCalls++; return { kind: 'deny', reason: 'host' }; });
    }
    await observer.flush();
    assert.equal(beforeCalls, 300);
    assert.equal(diagnostics, 300);
    reject = false;
    const accepted = execution('accepted');
    await handlers.get('tools/pre-execute')(accepted, () => { hostCalls++; return { kind: 'allow' }; });
    handlers.get('tools/result')(accepted, { isError: false, content: [] });
    await observer.flush();
    assert.equal(hostCalls, 301);
    assert.equal(beforeCalls, 301);
    assert.equal(outcomes, 1);
  } finally { await observer.dispose(); }
  assert.equal(handlers.size, 0);
});

test('accepted DeepSeek result retains its original task even after task selection changes', async t => {
  const { boundary, call, intent } = fixture(t, 'deepseek-harness');
  const handlers = new Map();
  let selected = intent('old'), resolutions = 0;
  const observer = installDeepSeekObserver({ on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } }, {
    boundary, identity: () => ({ sessionId: call.sessionId, agentId: call.agentId }),
    resolveIntent: () => { resolutions++; return selected; },
  });
  const exec = { callId: call.callId, name: call.toolName, arguments: call.arguments, signal: new AbortController().signal };
  try {
    await handlers.get('tools/pre-execute')(exec, () => ({ kind: 'allow' }));
    selected = intent('new');
    handlers.get('tools/result')(exec, { isError: false, content: [] });
    await observer.flush();
    const recorded = boundary.inspect(call);
    assert.equal(recorded.evidence.taskEvidence.id, 'old');
    assert.equal(recorded.observations.length, 1);
    assert.equal(recorded.observations[0].status, 'succeeded');
    assert.equal(recorded.labels.length, 0);
    assert.equal(resolutions, 1);
  } finally { await observer.dispose(); }
});

test('accepted function-call host exception still records uncertainty and rethrows the same error', async t => {
  const { boundary, call, intent } = fixture(t, 'openai-compatible');
  const original = new Error('synthetic host error');
  let calls = 0;
  await assert.rejects(observeFunctionCall({ boundary,
    call: { id: call.callId, type: 'function', function: { name: call.toolName, arguments: JSON.stringify(call.arguments) } },
    identity: { sessionId: call.sessionId, agentId: call.agentId }, resolveIntent: () => intent('current'),
    execute: () => { calls++; throw original; },
  }), error => error === original);
  const recorded = boundary.inspect(call);
  assert.equal(calls, 1);
  assert.equal(recorded.observations.length, 1);
  assert.equal(recorded.observations[0].status, 'unknown');
  assert.equal(recorded.observations[0].provenance, 'harness-reported');
  assert.equal(recorded.labels.length, 0);
});

for (const harness of ['deepseek-harness', 'openai-compatible']) {
  for (const state of ['admitted', 'unknown']) {
    test(`${harness}: matching ${state} evidence can receive a report without resolving execution state`, async t => {
      const { kernel, boundary, call, intent } = fixture(t, harness);
      const originalClaim = kernel.claim.bind(kernel);
      // Controlled interruption after a real claim; not a process-crash test.
      kernel.claim = input => {
        const admission = originalClaim(input);
        assert.equal(admission.kind, 'claimed');
        if (state === 'unknown') kernel.abandon(admission.handle);
        throw new Error('synthetic interrupted observation');
      };
      await assert.rejects(boundary.before(call, intent('same')), /synthetic interrupted observation/);
      kernel.claim = originalClaim;
      const original = boundary.inspect(call);
      assert.equal(original.state, state);
      const expectedStatus = state === 'admitted' ? 'in_flight' : 'recovery_required';
      assert.equal((await boundary.before(call, intent('same'))).status, expectedStatus);
      await assert.rejects(boundary.before(call, intent('different')), /Idempotency conflict/);
      let hostCalls = 0;
      if (harness === 'deepseek-harness') {
        const handlers = new Map();
        const observer = installDeepSeekObserver({ on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } }, {
          boundary, identity: () => ({ sessionId: call.sessionId, agentId: call.agentId }), resolveIntent: () => intent('same'),
        });
        const exec = { callId: call.callId, name: call.toolName, arguments: call.arguments, signal: new AbortController().signal };
        try {
          await handlers.get('tools/pre-execute')(exec, () => { hostCalls++; return { kind: 'allow' }; });
          handlers.get('tools/result')(exec, { isError: false, content: [] });
          await observer.flush();
        } finally { await observer.dispose(); }
      } else {
        await observeFunctionCall({ boundary,
          call: { id: call.callId, type: 'function', function: { name: call.toolName, arguments: JSON.stringify(call.arguments) } },
          identity: { sessionId: call.sessionId, agentId: call.agentId }, resolveIntent: () => intent('same'),
          execute: () => { hostCalls++; return 'synthetic'; },
        });
      }
      const updated = boundary.inspect(call);
      assert.equal(hostCalls, 1);
      assert.equal(updated.observations.length, 1);
      assert.equal(updated.observations[0].status, 'succeeded');
      assert.equal(updated.observations[0].provenance, 'harness-reported');
      assert.deepEqual({ ...updated, observations: [] }, original);
      assert.equal((await boundary.before(call, intent('same'))).status, expectedStatus);
    });
  }
}
