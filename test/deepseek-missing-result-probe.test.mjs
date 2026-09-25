import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MISSING_RESULT_ASSERTIONS, MISSING_RESULT_EVIDENCE,
  evaluateMissingResultProbeOutput, validateMissingResultStage } from '../scripts/deepseek-missing-result-contract.mjs';
import { createProbeRoot, isolatedMissingResultPatch, missingResultFailureReason, missingResultStartHere,
  quoteProbeCommandArg, runDeepSeekMissingResultProbe,
  sameTelemetrySnapshot, superviseMissingResult, terminateExactChild } from '../scripts/deepseek-missing-result-probe.mjs';
import { parseArgs, runCompatibilityProbe } from '../scripts/real-host-compat.mjs';
import { marksNativeAgentCompletion } from '../scripts/fixtures/deepseek-missing-result-fixture.mjs';

const snapshot = { missing: true, key: 'synthetic-key', runState: 'completed',
  outcomeStatus: 'missing', outcomeCount: 0 };
const passed = () => ({ schemaVersion: 1, ...MISSING_RESULT_EVIDENCE,
  hostVersion: '0.1.2-rc.1', status: 'passed',
  reason: 'cli_observer_missing_result_isolated_passed',
  assertions: MISSING_RESULT_ASSERTIONS.map(name => ({ name, passed: true })),
  preStop: snapshot, postStop: snapshot, supervisor: { childPid: 123, closed: true, sequence: 3 } });

test('fixed receipt rejects completion claims, changed readbacks, and unverified supervisor state', () => {
  const receipt = passed();
  const assessed = evaluateMissingResultProbeOutput(JSON.stringify({ ...receipt, private: 'DO_NOT_FORWARD' }));
  assert.equal(assessed?.status, 'passed');
  assert.equal(JSON.stringify(assessed).includes('DO_NOT_FORWARD'), false);
  for (const change of [
    { agentE2E: true }, { modelInference: true }, { agentCompleted: true },
    { nativeResultReceived: true }, { nativeToolBodyEntered: false },
    { exitKind: 'natural_exit' }, { hostVersion: '0.1.3' },
    { preStop: { ...snapshot, outcomeStatus: 'succeeded' } },
    { postStop: { ...snapshot, key: 'other' } },
    { supervisor: { ...receipt.supervisor, closed: false } },
    { assertions: receipt.assertions.slice(1) },
  ]) assert.equal(evaluateMissingResultProbeOutput(JSON.stringify({ ...receipt, ...change })), null);
  assert.equal(evaluateMissingResultProbeOutput('not-json'), null);
});

test('IPC contract rejects spoofed, duplicated, missing, and cross-run stages', () => {
  const runId = 'run-a';
  const stages = ['fixture_ready', 'body_entered', 'observer_unloaded'];
  stages.forEach((stage, index) => assert.equal(validateMissingResultStage({ runId, seq: index + 1, stage }, runId, index), true));
  for (const bad of [
    { runId: 'run-b', seq: 1, stage: 'fixture_ready' },
    { runId, seq: 2, stage: 'fixture_ready' },
    { runId, seq: 1, stage: 'body_entered' },
    { runId, seq: 1, stage: 'fixture_ready', extra: true },
  ]) assert.equal(validateMissingResultStage(bad, runId, 0), false);
  assert.equal(validateMissingResultStage({ runId, seq: 4, stage: 'observer_unloaded' }, runId, 3), false);
});

test('post-stop telemetry must not hide a late native result or Agent completion', () => {
  const before = { nativeResults: 0, agentCompleted: false, bodyCalls: 1 };
  assert.equal(sameTelemetrySnapshot(before, { ...before }), true);
  assert.equal(sameTelemetrySnapshot(before, { ...before, nativeResults: 1 }), false);
  assert.equal(sameTelemetrySnapshot(before, { ...before, agentCompleted: true }), false);
  assert.equal(sameTelemetrySnapshot(null, before), false);
});

test('only a matching native session turn-end marks Agent completion', () => {
  assert.equal(marksNativeAgentCompletion({ id: 'session-a' }, { type: 'turn/end' }, 'session-a'), true);
  assert.equal(marksNativeAgentCompletion({ id: 'session-b' }, { type: 'turn/end' }, 'session-a'), false);
  assert.equal(marksNativeAgentCompletion({ id: 'session-a' }, { type: 'step/end' }, 'session-a'), false);
  assert.equal(marksNativeAgentCompletion({ id: 'session-a' }, { type: 'turn/end' }, null), false);
});

test('timeout and early-exit reasons remain distinct from failed cleanup', () => {
  assert.equal(missingResultFailureReason({ ok: false, reason: 'host_timeout' }, true,
    { closed: true, fault: null }), 'host_timeout');
  assert.equal(missingResultFailureReason({ ok: false, reason: 'host_exited_early' }, false,
    { closed: true, fault: null }), 'host_exited_early');
  assert.equal(missingResultFailureReason({ ok: false, reason: 'host_timeout' }, false,
    { closed: false, fault: null }), 'supervisor_termination_failed');
});

test('supervisor recognizes ordered child IPC, timeouts, early exit, and cross-run stages', { timeout: 20_000 }, async () => {
  const emit = (stage, seq, runId = 'run-a') => `require('node:fs').writeSync(3, JSON.stringify({runId:${JSON.stringify(runId)},seq:${seq},stage:${JSON.stringify(stage)}})+'\\n');`;
  const cases = [
    { code: `${emit('fixture_ready', 1)}${emit('body_entered', 2)}${emit('observer_unloaded', 3)}setInterval(()=>{},1000);`, expected: { ok: true } },
    { code: `${emit('fixture_ready', 1)}${emit('fixture_ready', 1)}setInterval(()=>{},1000);`, expected: { ok: false, reason: 'ipc_sequence_invalid' } },
    { code: `${emit('fixture_ready', 1)}${emit('body_entered', 2)}${emit('observer_unloaded', 3)}${emit('observer_unloaded', 3)}setInterval(()=>{},1000);`,
      expected: { ok: true }, invalidAfterReady: true },
    { code: `${emit('fixture_ready', 1, 'run-b')}setInterval(()=>{},1000);`, expected: { ok: false, reason: 'ipc_sequence_invalid' } },
    { code: `${emit('fixture_ready', 1)}process.exit(0);`, expected: { ok: false, reason: 'host_exited_early' } },
    { code: 'setInterval(()=>{},1000);', expected: { ok: false, reason: 'host_timeout' } },
  ];
  for (const { code, expected, invalidAfterReady } of cases) {
    const supervisor = superviseMissingResult(process.execPath, ['-e', code], {
      cwd: process.cwd(), env: process.env, runId: 'run-a', timeoutMs: 300,
    });
    try {
      assert.deepEqual(await supervisor.ready, expected);
      if (invalidAfterReady) {
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(supervisor.state().fault, 'ipc_sequence_invalid');
      }
    } finally {
      supervisor.clearTimer();
      if (!supervisor.state().closed) assert.equal(await terminateExactChild(supervisor), true);
    }
  }
});

test('new-only retained directory and fixed isolated patch preserve synthetic scope', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'rm-missing-result-test-'));
  try {
    const outDir = join(parent, 'retained');
    assert.equal(createProbeRoot(outDir), outDir);
    assert.equal(existsSync(outDir), true);
    assert.throws(() => createProbeRoot(outDir), /output_directory_exists/);
    assert.throws(() => createProbeRoot('relative-path'), /output_directory_invalid/);
    const patch = isolatedMissingResultPatch({ packageRoot: '/synthetic/dsh', dbPath: '/synthetic/db',
      telemetryPath: '/synthetic/telemetry', homePath: '/synthetic/home', cwdPath: '/synthetic/cwd', runId: 'run-a' });
    const rows = patch.split('\n').filter(line => line.startsWith('  - {')).map(line => JSON.parse(line.slice(4)));
    assert.deepEqual(rows.map(row => row.id).slice(-2), ['reflexmesh-observer', 'reflexmesh-missing-result-fixture']);
    assert.equal(rows.find(row => row.id === 'reflexmesh-observer').config.shutdownResultWaitMs, 0);
    assert.equal(rows.find(row => row.id === 'tools').config.mode, 'native');
    assert.doesNotMatch(patch, /dsh-base|\.env|credentials/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('START-HERE preserves Windows paths and quotes through PowerShell', { skip: process.platform !== 'win32' }, () => {
  const dbPath = "C:\\Users\\fixture\\folder's space\\ledger.sqlite";
  const quoted = quoteProbeCommandArg(dbPath);
  assert.equal(quoted, "'C:\\Users\\fixture\\folder''s space\\ledger.sqlite'");
  const result = spawnSync('powershell', ['-NoProfile', '-Command', `[Console]::Write(${quoted})`],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, dbPath);
  const guide = missingResultStartHere({ dbPath, installedRoot: 'D:\\DeepSeekHarness\\dsh', key: 'fixture-key' });
  assert.match(guide, /evidence-cli\.mjs list --db 'C:\\Users\\fixture\\folder''s space\\ledger\.sqlite'/);
  assert.match(guide, /doctor-cli\.mjs --deepseek-package-root 'D:\\DeepSeekHarness\\dsh'/);
  assert.doesNotMatch(guide, /C:\\\\Users/);
});

test('wrapper limits out-dir to missing-result mode and missing package stays account-free', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'rm-missing-result-test-'));
  try {
    const missing = join(parent, 'missing');
    const outDir = join(parent, 'evidence');
    assert.throws(() => parseArgs(['--out-dir', outDir]), /out_dir_requires_missing_result_mode/);
    assert.throws(() => parseArgs(['--host', 'deepseek', '--deepseek-mode', 'agent-cli',
      '--deepseek-package-root', missing, '--out-dir', outDir]), /out_dir_requires_missing_result_mode/);
    assert.throws(() => parseArgs(['--host', 'deepseek', '--deepseek-mode', 'observer-missing-result',
      '--deepseek-package-root', missing, '--out-dir', 'relative-evidence']), /invalid_out_dir/);
    const options = parseArgs(['--host', 'deepseek', '--deepseek-mode', 'observer-missing-result',
      '--deepseek-package-root', missing, '--out-dir', outDir]);
    assert.equal(options.outDir, outDir);
    const direct = await runDeepSeekMissingResultProbe(missing, outDir);
    assert.equal(direct.reason, 'host_package_missing');
    assert.equal(existsSync(outDir), false);
    const wrapped = await runCompatibilityProbe(options);
    assert.equal(wrapped.reason, 'host_package_missing');
    assert.equal(wrapped.results[0].requestedEvidenceLevel, MISSING_RESULT_EVIDENCE.evidenceLevel);
    assert.equal(wrapped.agentCompleted, null);
    assert.equal(wrapped.nativeResultReceived, null);
    assert.equal(wrapped.exitKind, 'unverified');
    const noNode = await runCompatibilityProbe({ ...options, nodeCommand: join(parent, 'missing-node') });
    assert.equal(noNode.reason, 'node_command_not_found');
    assert.equal(noNode.nativeToolBodyEntered, false);
    assert.equal(noNode.nativeResultReceived, null);
    assert.equal(noNode.agentCompleted, null);
    assert.equal(noNode.exitKind, 'unverified');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
