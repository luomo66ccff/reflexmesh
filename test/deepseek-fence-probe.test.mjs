import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FENCE_ASSERTIONS, FENCE_EVIDENCE,
  evaluateFenceProbeOutput } from '../scripts/deepseek-fence-contract.mjs';
import { isolatedTeardownPatch, runDeepSeekTeardownProbe } from '../scripts/deepseek-teardown-probe.mjs';
import { parseArgs, runCompatibilityProbe } from '../scripts/real-host-compat.mjs';

const passed = () => ({ schemaVersion: 1, ...FENCE_EVIDENCE, agentLoopExercised: true,
  hostVersion: '0.1.2-rc.1', status: 'passed', reason: 'cli_observer_fence_passed',
  assertions: FENCE_ASSERTIONS.map(name => ({ name, passed: true })) });
const cleanTemp = async root => {
  const target = await realpath(root);
  const rel = relative(await realpath(tmpdir()), target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
    && basename(target).startsWith('rm-fence-'));
  await rm(target, { recursive: true, force: true });
};

test('fence receipt accepts only fixed sanitized installed-host evidence', () => {
  const value = passed();
  const assessed = evaluateFenceProbeOutput(JSON.stringify({ ...value, privatePrompt: 'DO_NOT_FORWARD',
    assertions: value.assertions.map(item => ({ ...item, private: 'DO_NOT_FORWARD' })) }));
  assert.equal(assessed.status, 'passed');
  assert.equal(JSON.stringify(assessed).includes('DO_NOT_FORWARD'), false);
  for (const replacement of [
    { agentE2E: true }, { modelInference: true }, { classification: 'calibrated' },
    { modelTransport: 'real_model' }, { agentLoopExercised: false }, { hostVersion: '0.1.3' },
    { assertions: value.assertions.slice(1) },
    { assertions: [...value.assertions, { name: 'extra', passed: true }] },
    { assertions: value.assertions.map((item, index) => index === 4 ? { ...item, passed: false } : item) },
  ]) assert.equal(evaluateFenceProbeOutput(JSON.stringify({ ...value, ...replacement })), null);
  assert.equal(evaluateFenceProbeOutput('not-json'), null);
  assert.equal(evaluateFenceProbeOutput(JSON.stringify({ ...value,
    status: 'failed', reason: 'PRIVATE_ERROR', agentLoopExercised: false })), null);
  const failed = evaluateFenceProbeOutput(JSON.stringify({ ...value,
    status: 'failed', reason: 'host_timeout', agentLoopExercised: false, hostVersion: 'PRIVATE_VERSION' }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.version, 'unknown');
  assert.ok(failed.assertions.every(item => item.passed === false));
});

test('fence patch opts in to zero drain wait in an isolated synthetic profile', () => {
  const patch = isolatedTeardownPatch({ packageRoot: '/synthetic/packages/dsh', dbPath: '/synthetic/ledger.sqlite',
    telemetryPath: '/synthetic/receipt.json', homePath: '/synthetic/home', cwdPath: '/synthetic/cwd',
    scenario: 'fenced-after' });
  const rows = patch.split('\n').filter(line => line.startsWith('  - {')).map(line => JSON.parse(line.slice(4)));
  assert.equal(rows.find(row => row.id === 'reflexmesh-observer').config.shutdownDrainWaitMs, 0);
  assert.equal(rows.find(row => row.id === 'reflexmesh-observer').config.shutdownResultWaitMs, 0);
  assert.equal(rows.find(row => row.id === 'reflexmesh-teardown-fixture').config.scenario, 'fenced-after');
  assert.deepEqual(rows.map(row => row.id), ['timer', 'llm', 'session', 'session-projection', 'system-prompt',
    'tools', 'agent', 'agent-loop', 'agent-default-model', 'headless-startup',
    'reflexmesh-observer', 'reflexmesh-teardown-fixture']);
  assert.match(patch, /inject: \[headlessStartup, agentLoop, reflexmeshSyntheticFixtureReady\]/);
  assert.doesNotMatch(patch, /dsh-base|\.env|credentials|telemetry-plugin/);
  assert.throws(() => isolatedTeardownPatch({ scenario: 'unknown' }), /Unsupported probe scenario/);
});

test('missing installation gives fixed standalone and wrapper fence failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-fence-missing-'));
  t.after(() => cleanTemp(directory));
  const missing = join(directory, 'missing');
  const standalone = await runDeepSeekTeardownProbe(missing, 'fenced-after');
  assert.equal(standalone.reason, 'host_package_missing');
  assert.equal(standalone.evidenceLevel, 'cli_agent_observer_fence');
  assert.equal(standalone.agentLoopExercised, false);
  const script = fileURLToPath(new URL('../scripts/deepseek-teardown-probe.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, missing, 'fenced-after'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).reason, 'host_package_missing');
  const wrapped = await runCompatibilityProbe(parseArgs(['--host', 'deepseek', '--deepseek-mode', 'observer-fence',
    '--deepseek-package-root', missing, '--node-command', process.execPath]));
  assert.equal(wrapped.status, 'failed');
  assert.equal(wrapped.reason, 'host_package_missing');
  assert.equal(wrapped.results[0].requestedEvidenceLevel, 'cli_agent_observer_fence');
  assert.equal(wrapped.evidenceLevel, 'none');
  assert.equal(wrapped.agentE2E, false);
  assert.equal(wrapped.modelInference, false);
  assert.throws(() => parseArgs(['--deepseek-mode', 'observer-fence']), /deepseek_package_root_required/);
});

test('fence wrapper requires exact status and process-exit agreement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-fence-transport-'));
  t.after(() => cleanTemp(directory));
  const childScript = join(directory, 'synthetic-receipt.mjs');
  const options = () => parseArgs(['--host', 'deepseek', '--deepseek-mode', 'observer-fence',
    '--deepseek-package-root', directory, '--node-command', process.execPath, '--node-command-arg', childScript]);
  for (const [value, exitCode, expected] of [
    [{ ...passed(), private: 'DO_NOT_FORWARD' }, 0, 'cli_observer_fence_passed'],
    [passed(), 1, 'probe_exit_mismatch'],
    [{ ...passed(), status: 'failed', reason: 'evidence_assertion_failed', agentLoopExercised: false }, 1, 'evidence_assertion_failed'],
    [{ ...passed(), modelInference: true }, 0, 'probe_output_invalid'],
  ]) {
    await writeFile(childScript, `process.stdout.write(${JSON.stringify(JSON.stringify(value))}); process.exitCode=${exitCode};`);
    const report = await runCompatibilityProbe(options());
    assert.equal(report.reason, expected);
    assert.equal(report.agentE2E, false);
    assert.equal(report.modelInference, false);
    assert.equal(JSON.stringify(report).includes('DO_NOT_FORWARD'), false);
    assert.equal(report.evidenceLevel, expected === 'cli_observer_fence_passed' ? 'cli_agent_observer_fence' : 'none');
  }
});
