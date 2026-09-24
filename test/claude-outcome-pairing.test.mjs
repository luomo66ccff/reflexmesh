import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { openLocalBoundary } from '../adapters/local-config.mjs';
import { fromClaudeHook } from '../dist/index.js';
import { formatEvidence } from '../adapters/evidence-cli.mjs';
import { diagnoseDoctor, formatDoctor } from '../adapters/doctor.mjs';

// Process startup and SQLite initialization can exceed five seconds on a loaded
// Windows CI runner; this bounds a correctness fixture, not hook latency.
const HOOK_CHILD_TIMEOUT_MS = 20_000;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-claude-pairing-'));
  t.after(() => {
    const target = realpathSync(root), rel = relative(realpathSync(tmpdir()), target);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
      && basename(target).startsWith('reflexmesh-claude-pairing-'));
    rmSync(target, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, REFLEXMESH_DB: join(root, 'ledger.sqlite'),
    REFLEXMESH_INTENT_DB: join(root, 'intents.sqlite'), REFLEXMESH_PROVIDER: 'abstain',
    REFLEXMESH_TENANT: 'synthetic', REFLEXMESH_SCOPE: 'hook-pairing', REFLEXMESH_INTENT_MODE: 'explicit-summary' };
  const payload = (name, fields = {}) => ({ hook_event_name: name, session_id: 'synthetic-session',
    tool_use_id: 'reused-call', tool_name: 'Read', tool_input: { path: 'synthetic-file' }, ...fields });
  const run = (name, fields = {}, entry = 'claude-task-hook', extraEnv = {}) => {
    const child = spawnSync(process.execPath, [`adapters/${entry}.mjs`], {
      env: { ...env, ...extraEnv }, input: JSON.stringify(payload(name, fields)), encoding: 'utf8',
      timeout: HOOK_CHILD_TIMEOUT_MS,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {});
    return child;
  };
  const rows = () => {
    const kernel = new SqliteKernel(env.REFLEXMESH_DB, { readOnly: true });
    try { return kernel.listEvidence().items.map(row => kernel.inspect(row.key)); }
    finally { kernel.close(); }
  };
  const view = () => {
    const kernel = new SqliteKernel(env.REFLEXMESH_DB, { readOnly: true });
    try { return kernel.listEvidence(); }
    finally { kernel.close(); }
  };
  return { env, payload, run, rows, view };
}

test('independent task-hook processes do not attach a conflicting new task result to an old row', t => {
  const f = fixture(t);
  f.run('UserPromptSubmit', { prompt: 'ReflexMesh-Intent: Synthetic old task' });
  f.run('PreToolUse');
  const old = f.rows()[0];
  assert.equal(old.observations.length, 0);
  f.run('UserPromptSubmit', { prompt: 'ReflexMesh-Intent: Synthetic new task' });
  assert.match(f.run('PreToolUse').stderr, /ReflexMesh task observation unavailable/);
  f.run('PostToolUse', { tool_response: { synthetic: 'new-task-result' } });
  assert.deepEqual(f.rows()[0].observations, []);
  assert.deepEqual(f.rows()[0].evidence, old.evidence);
  assert.deepEqual(f.rows()[0].labels, []);
});

test('legacy hook processes do not attach an outcome after conflicting deployment admission', t => {
  const f = fixture(t);
  f.run('PreToolUse', {}, 'claude-hook');
  const old = f.rows()[0];
  assert.match(f.run('PreToolUse', {}, 'claude-hook', { REFLEXMESH_TASK_EVIDENCE: 'true' }).stderr,
    /ReflexMesh shadow observation unavailable/);
  f.run('PostToolUse', { tool_response: { synthetic: 'changed-binding-result' } }, 'claude-hook',
    { REFLEXMESH_TASK_EVIDENCE: 'true' });
  assert.deepEqual(f.rows()[0].observations, []);
  assert.deepEqual(f.rows()[0].evidence, old.evidence);
});

test('normally admitted old tool result remains associated after a new prompt and cache clear', t => {
  const f = fixture(t);
  f.run('UserPromptSubmit', { prompt: 'ReflexMesh-Intent: Synthetic old task' });
  f.run('PreToolUse');
  const old = f.rows()[0];
  f.run('UserPromptSubmit', { prompt: 'ReflexMesh-Intent: Synthetic new task' });
  f.run('Stop');
  f.run('PostToolUse', { tool_response: { synthetic: 'old-task-result' } });
  const after = f.rows()[0];
  assert.deepEqual(after.evidence, old.evidence);
  assert.equal(after.observations.length, 1);
  assert.equal(after.observations[0].status, 'succeeded');
  assert.equal(after.observations[0].provenance, 'harness-reported');
  assert.equal(after.labels.length, 0);
});

test('a pre-existing unpaired journal row is not sufficient proof of hook admission', async t => {
  const f = fixture(t);
  const { boundary, kernel } = openLocalBoundary(f.env);
  try { await boundary.before(fromClaudeHook(f.payload('PreToolUse')).call); }
  finally { kernel.close(); }
  f.run('PostToolUse', { tool_response: { synthetic: 'unpaired-result' } }, 'claude-hook');
  assert.deepEqual(f.rows()[0].observations, []);
});

test('identical repeated pre is ambiguous even when it was only a duplicate delivery', t => {
  const f = fixture(t);
  f.run('PreToolUse', {}, 'claude-hook');
  f.run('PreToolUse', {}, 'claude-hook');
  f.run('PostToolUse', { tool_response: {} }, 'claude-hook');
  const item = f.view().items[0];
  assert.equal(item.hostOutcome.count, 0);
  assert.deepEqual(item.hostOutcome.hookPairing, { state: 'blocked', reasonCode: 'duplicate_pre' });
});

test('identical repeated post deduplicates; changed post blocks but preserves the original outcome', t => {
  const f = fixture(t);
  f.run('PreToolUse', {}, 'claude-hook');
  f.run('PostToolUse', { tool_response: { synthetic: 'original' } }, 'claude-hook');
  const original = f.rows()[0];
  f.run('PostToolUse', { tool_response: { synthetic: 'original' } }, 'claude-hook');
  assert.deepEqual(f.rows()[0], original);
  f.run('PostToolUseFailure', { error: 'synthetic different terminal report' }, 'claude-hook');
  assert.deepEqual(f.rows()[0], original);
  const item = f.view().items[0];
  assert.deepEqual(item.hostOutcome.hookPairing, { state: 'blocked', reasonCode: 'outcome_conflict' });
  assert.ok(item.notes.some(note => note.includes('unambiguous invocation association')));
});

test('post preceding pre cannot be healed by a later pre and repeated post', t => {
  const f = fixture(t);
  f.run('PostToolUse', { tool_response: {} }, 'claude-hook');
  f.run('PreToolUse', {}, 'claude-hook');
  f.run('PostToolUse', { tool_response: {} }, 'claude-hook');
  assert.deepEqual(f.rows(), []); // The blocked reservation does not invent a decision.
});

test('post must match the admitted deployment without reading a replacement task', t => {
  const f = fixture(t);
  f.run('PreToolUse', {}, 'claude-hook');
  f.run('PostToolUse', { tool_response: {} }, 'claude-hook', { REFLEXMESH_TASK_EVIDENCE: 'true' });
  assert.equal(f.view().items[0].hostOutcome.hookPairing.state, 'blocked');
  assert.deepEqual(f.rows()[0].observations, []);
  // Restoring old configuration does not erase an already observed ambiguity.
  f.run('PostToolUse', { tool_response: {} }, 'claude-hook');
  assert.deepEqual(f.rows()[0].observations, []);
});

test('mixing legacy and task-aware pre hooks for the same ID cannot bypass pairing', t => {
  const f = fixture(t);
  f.run('PreToolUse', {}, 'claude-hook');
  f.run('PreToolUse');
  f.run('PostToolUse', { tool_response: {} }, 'claude-hook');
  assert.equal(f.view().items[0].hostOutcome.hookPairing.state, 'blocked');
  assert.deepEqual(f.rows()[0].observations, []);
});

test('configuration failure before reservation remains outside the pairing guarantee', t => {
  const f = fixture(t);
  f.run('PreToolUse');
  const badEnv = { REFLEXMESH_INTENT_DB: f.env.REFLEXMESH_DB };
  // Configuration collision fails before reservation and is deliberately outside
  // the new guarantee; use an injected resolver failure below for the reserved case.
  assert.match(f.run('PreToolUse', {}, 'claude-task-hook', badEnv).stderr, /observation unavailable/);
  assert.equal(f.view().items[0].hostOutcome.hookPairing.state, 'ready');
});

test('actual cache-open failure after reservation cannot be retried into a ready pair', t => {
  const f = fixture(t);
  writeFileSync(f.env.REFLEXMESH_INTENT_DB, 'synthetic invalid database');
  assert.match(f.run('PreToolUse').stderr, /ReflexMesh task observation unavailable/);
  // Turning capture off does not heal the already blocked tool identity.
  f.run('PreToolUse', {}, 'claude-task-hook', { REFLEXMESH_INTENT_MODE: 'off' });
  f.run('PostToolUse', { tool_response: {} }, 'claude-task-hook', { REFLEXMESH_INTENT_MODE: 'off' });
  assert.deepEqual(f.rows(), []);
});

test('post-after-success duplicate pre visibly marks retained historical outcomes ambiguous', async t => {
  const f = fixture(t);
  f.run('PreToolUse', {}, 'claude-hook');
  f.run('PostToolUse', { tool_response: {} }, 'claude-hook');
  const original = f.rows()[0];
  f.run('PreToolUse', {}, 'claude-hook');
  assert.deepEqual(f.rows()[0], original);
  const page = f.view(), item = page.items[0];
  assert.equal(item.hostOutcome.status, 'succeeded'); // The historical claim is retained, not silently repaired.
  assert.equal(item.hostOutcome.hookPairing.state, 'blocked');
  assert.match(formatEvidence(page, 'list'), /hook pairing: blocked/);
  assert.match(formatEvidence(item, 'inspect'), /unambiguous invocation association/);
  const doctor = await diagnoseDoctor(['--db', f.env.REFLEXMESH_DB, '--tenant', 'synthetic', '--scope', 'hook-pairing', '--key', item.key]);
  assert.equal(doctor.report.historicalEvidence.hookPairingState, 'blocked');
  assert.ok(doctor.report.diagnostics.some(item => item.code === 'historical_hook_pairing_unavailable'));
  assert.match(formatDoctor(doctor.report), /关联未完成或有歧义/);
});

test('task resolver failure happens after persistent reservation and cannot manufacture a ready pair', async t => {
  const f = fixture(t);
  const { boundary, kernel } = openLocalBoundary(f.env, { taskAware: true });
  const call = fromClaudeHook(f.payload('PreToolUse')).call;
  try {
    await assert.rejects(boundary.beforeClaudeHook(call, () => { throw new Error('synthetic cache failure'); }), /synthetic cache failure/);
  } finally { kernel.close(); }
  f.run('PreToolUse');
  f.run('PostToolUse', { tool_response: {} });
  assert.deepEqual(f.rows(), []);
});

test('before failing after a completed decision leaves its outcome unpaired across processes', async t => {
  const f = fixture(t);
  const { boundary, kernel } = openLocalBoundary(f.env, { taskAware: true });
  const originalBefore = boundary.before.bind(boundary);
  boundary.before = async (...args) => {
    await originalBefore(...args);
    throw new Error('synthetic failure after decision commit');
  };
  try {
    await assert.rejects(boundary.beforeClaudeHook(fromClaudeHook(f.payload('PreToolUse')).call),
      /synthetic failure after decision commit/);
  } finally { kernel.close(); }
  f.run('PostToolUse', { tool_response: {} });
  const item = f.view().items[0];
  assert.equal(item.run.state, 'completed');
  assert.deepEqual(item.hostOutcome.hookPairing, { state: 'blocked', reasonCode: 'before_failed' });
  assert.equal(item.hostOutcome.count, 0);
  assert.deepEqual(f.rows()[0].labels, []);
});

test('injected completion and failure-marker errors leave pending evidence unsafe for a later post', async t => {
  const f = fixture(t);
  const { boundary, kernel } = openLocalBoundary(f.env, { taskAware: true });
  kernel.completeClaudeHookPairing = () => { throw new Error('synthetic completion storage failure'); };
  kernel.blockClaudeHookPairing = () => { throw new Error('synthetic failure-marker storage failure'); };
  try {
    await assert.rejects(boundary.beforeClaudeHook(fromClaudeHook(f.payload('PreToolUse')).call),
      /synthetic completion storage failure/);
    assert.equal(kernel.listEvidence().items[0].hostOutcome.hookPairing.state, 'pending');
  } finally { kernel.close(); }
  f.run('PostToolUse', { tool_response: {} });
  const item = f.view().items[0];
  assert.deepEqual(item.hostOutcome.hookPairing, { state: 'blocked', reasonCode: 'early_post' });
  assert.equal(item.hostOutcome.count, 0);
  assert.deepEqual(f.rows()[0].labels, []);
});
