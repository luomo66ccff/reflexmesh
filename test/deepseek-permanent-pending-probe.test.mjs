import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PERMANENT_PENDING, permanentPendingEvidence,
  evaluatePermanentPendingProbeOutput } from '../scripts/deepseek-permanent-pending-contract.mjs';
import { isolatedTeardownPatch, runDeepSeekTeardownProbe } from '../scripts/deepseek-teardown-probe.mjs';
import { parseArgs, runCompatibilityProbe } from '../scripts/real-host-compat.mjs';

const scenarios = ['permanent-before', 'permanent-after'];
const modeFor = scenario => scenario === 'permanent-before' ? 'observer-pending-before' : 'observer-pending-after';
const passed = scenario => ({ schemaVersion: 1, ...permanentPendingEvidence(scenario),
  agentLoopExercised: true, hostVersion: '0.1.2-rc.1', status: 'passed',
  reason: PERMANENT_PENDING[scenario].reason,
  assertions: PERMANENT_PENDING[scenario].assertions.map(name => ({ name, passed: true })) });
const cleanTemp = async root => {
  const target = await realpath(root);
  const rel = relative(await realpath(tmpdir()), target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
    && basename(target).startsWith('rm-permanent-'));
  await rm(target, { recursive: true, force: true });
};

test('permanent-pending receipts require the exact scenario and fixed assertions', () => {
  for (const scenario of scenarios) {
    const value = passed(scenario);
    const assessed = evaluatePermanentPendingProbeOutput(JSON.stringify({ ...value, private: 'DO_NOT_FORWARD',
      assertions: value.assertions.map(item => ({ ...item, private: 'DO_NOT_FORWARD' })) }), scenario);
    assert.equal(assessed.status, 'passed');
    assert.equal(JSON.stringify(assessed).includes('DO_NOT_FORWARD'), false);
    const other = scenarios.find(item => item !== scenario);
    assert.equal(evaluatePermanentPendingProbeOutput(JSON.stringify(value), other), null);
    for (const replacement of [
      { agentE2E: true }, { modelInference: true }, { classification: 'calibrated' },
      { modelTransport: 'real_model' }, { agentLoopExercised: false }, { hostVersion: '0.1.3' },
      { assertions: value.assertions.slice(1) },
      { assertions: [...value.assertions, { name: 'extra', passed: true }] },
      { assertions: value.assertions.map((item, index) => index === 4 ? { ...item, passed: false } : item) },
    ]) assert.equal(evaluatePermanentPendingProbeOutput(JSON.stringify({ ...value, ...replacement }), scenario), null);
    assert.equal(evaluatePermanentPendingProbeOutput('not-json', scenario), null);
    assert.equal(evaluatePermanentPendingProbeOutput(JSON.stringify({ ...value,
      status: 'failed', reason: 'PRIVATE_ERROR', agentLoopExercised: false }), scenario), null);
    const failed = evaluatePermanentPendingProbeOutput(JSON.stringify({ ...value,
      status: 'failed', reason: 'host_timeout', agentLoopExercised: false,
      hostVersion: 'PRIVATE_VERSION' }), scenario);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.version, 'unknown');
    assert.ok(failed.assertions.every(item => item.passed === false));
  }
});

test('permanent-pending patches use only the isolated fixture and opt-in zero drain deadline', () => {
  for (const scenario of scenarios) {
    const patch = isolatedTeardownPatch({ packageRoot: '/synthetic/packages/dsh',
      dbPath: '/synthetic/ledger.sqlite', telemetryPath: '/synthetic/receipt.json',
      homePath: '/synthetic/home', cwdPath: '/synthetic/cwd', scenario });
    const rows = patch.split('\n').filter(line => line.startsWith('  - {')).map(line => JSON.parse(line.slice(4)));
    assert.equal(rows.find(row => row.id === 'reflexmesh-observer').config.shutdownDrainWaitMs, 0);
    assert.equal(rows.find(row => row.id === 'reflexmesh-observer').config.shutdownResultWaitMs, 0);
    assert.equal(rows.find(row => row.id === 'reflexmesh-teardown-fixture').config.scenario, scenario);
    assert.deepEqual(rows.map(row => row.id), ['timer', 'llm', 'session', 'session-projection',
      'system-prompt', 'tools', 'agent', 'agent-loop', 'agent-default-model',
      'headless-startup', 'reflexmesh-observer', 'reflexmesh-teardown-fixture']);
    assert.doesNotMatch(patch, /dsh-base|\.env|credentials|telemetry-plugin/);
  }
});

test('missing installation fails closed in both permanent-pending modes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-permanent-missing-'));
  t.after(() => cleanTemp(directory));
  const missing = join(directory, 'missing');
  const script = fileURLToPath(new URL('../scripts/deepseek-teardown-probe.mjs', import.meta.url));
  for (const scenario of scenarios) {
    const standalone = await runDeepSeekTeardownProbe(missing, scenario);
    assert.equal(standalone.reason, 'host_package_missing');
    assert.equal(standalone.evidenceLevel, PERMANENT_PENDING[scenario].evidenceLevel);
    const child = spawnSync(process.execPath, [script, missing, scenario], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout).reason, 'host_package_missing');
    const wrapped = await runCompatibilityProbe(parseArgs(['--host', 'deepseek',
      '--deepseek-mode', modeFor(scenario), '--deepseek-package-root', missing,
      '--node-command', process.execPath]));
    assert.equal(wrapped.status, 'failed');
    assert.equal(wrapped.reason, 'host_package_missing');
    assert.equal(wrapped.results[0].requestedEvidenceLevel, PERMANENT_PENDING[scenario].evidenceLevel);
    assert.equal(wrapped.evidenceLevel, 'none');
    assert.equal(wrapped.modelInference, false);
    assert.throws(() => parseArgs(['--deepseek-mode', modeFor(scenario)]), /deepseek_package_root_required/);
  }
});

test('wrapper rejects permanent-pending receipt spoofing, exit mismatch and timeout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-permanent-transport-'));
  t.after(() => cleanTemp(directory));
  const childScript = join(directory, 'synthetic-receipt.mjs');
  for (const scenario of scenarios) {
    const options = () => parseArgs(['--host', 'deepseek', '--deepseek-mode', modeFor(scenario),
      '--deepseek-package-root', directory, '--node-command', process.execPath,
      '--node-command-arg', childScript, '--timeout-ms', '1000']);
    for (const [value, exitCode, expected] of [
      [{ ...passed(scenario), private: 'DO_NOT_FORWARD' }, 0, PERMANENT_PENDING[scenario].reason],
      [passed(scenario), 1, 'probe_exit_mismatch'],
      [{ ...passed(scenario), status: 'failed', reason: 'evidence_assertion_failed', agentLoopExercised: false }, 1, 'evidence_assertion_failed'],
      [{ ...passed(scenario), scenario: scenarios.find(item => item !== scenario) }, 0, 'probe_output_invalid'],
    ]) {
      await writeFile(childScript, `process.stdout.write(${JSON.stringify(JSON.stringify(value))}); process.exitCode=${exitCode};`);
      const report = await runCompatibilityProbe(options());
      assert.equal(report.reason, expected);
      assert.equal(report.modelInference, false);
      assert.equal(JSON.stringify(report).includes('DO_NOT_FORWARD'), false);
      assert.equal(report.evidenceLevel, expected === PERMANENT_PENDING[scenario].reason
        ? PERMANENT_PENDING[scenario].evidenceLevel : 'none');
    }
    await writeFile(childScript, 'setInterval(() => {}, 1000);');
    const timedOut = await runCompatibilityProbe(options());
    assert.equal(timedOut.status, 'failed');
    assert.equal(timedOut.reason, 'host_timeout');
    assert.equal(timedOut.evidenceLevel, 'none');
  }
});
