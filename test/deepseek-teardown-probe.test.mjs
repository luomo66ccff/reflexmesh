import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEARDOWN_ASSERTIONS, TEARDOWN_EVIDENCE,
  evaluateTeardownProbeOutput } from '../scripts/deepseek-teardown-contract.mjs';
import { isolatedTeardownPatch, runDeepSeekTeardownProbe } from '../scripts/deepseek-teardown-probe.mjs';
import { parseArgs, runCompatibilityProbe } from '../scripts/real-host-compat.mjs';

const passed = () => ({ schemaVersion: 1, ...TEARDOWN_EVIDENCE, agentLoopExercised: true,
  hostVersion: '0.1.2-rc.1', status: 'passed', reason: 'cli_observer_teardown_passed',
  assertions: TEARDOWN_ASSERTIONS.map(name => ({ name, passed: true })) });
const cleanTemp = async root => {
  const target = await realpath(root);
  const rel = relative(await realpath(tmpdir()), target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
    && basename(target).startsWith('rm-teardown-'));
  await rm(target, { recursive: true, force: true });
};

test('teardown receipt accepts only a fixed sanitized installed-host claim', () => {
  const value = passed();
  const assessed = evaluateTeardownProbeOutput(JSON.stringify({ ...value, privatePrompt: 'DO_NOT_FORWARD',
    assertions: value.assertions.map(item => ({ ...item, private: 'DO_NOT_FORWARD' })) }));
  assert.equal(assessed.status, 'passed');
  assert.equal(JSON.stringify(assessed).includes('DO_NOT_FORWARD'), false);
  for (const replacement of [
    { agentE2E: true }, { modelInference: true }, { classification: 'calibrated' },
    { modelTransport: 'real_model' }, { agentLoopExercised: false }, { hostVersion: '0.1.3' },
    { assertions: value.assertions.slice(1) },
    { assertions: [...value.assertions, { name: 'extra', passed: true }] },
    { assertions: value.assertions.map((item, index) => index === 2 ? { ...item, passed: false } : item) },
  ]) assert.equal(evaluateTeardownProbeOutput(JSON.stringify({ ...value, ...replacement })), null);
  assert.equal(evaluateTeardownProbeOutput('not-json'), null);
  assert.equal(evaluateTeardownProbeOutput(JSON.stringify({ ...value,
    status: 'failed', reason: 'PRIVATE_ERROR', agentLoopExercised: false })), null);
  const failed = evaluateTeardownProbeOutput(JSON.stringify({ ...value,
    status: 'failed', reason: 'host_timeout', agentLoopExercised: false, hostVersion: 'PRIVATE_VERSION' }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.version, 'unknown');
  assert.ok(failed.assertions.every(item => item.passed === false));
});

test('teardown patch has only fixed synthetic rows and no readiness dependency on the observer', () => {
  const patch = isolatedTeardownPatch({ packageRoot: '/synthetic/packages/dsh', dbPath: '/synthetic/ledger.sqlite',
    telemetryPath: '/synthetic/receipt.json', homePath: '/synthetic/home', cwdPath: '/synthetic/cwd' });
  const rows = patch.split('\n').filter(line => line.startsWith('  - {')).map(line => JSON.parse(line.slice(4)));
  assert.deepEqual(rows.map(row => row.id), ['timer', 'llm', 'session', 'session-projection', 'system-prompt',
    'tools', 'agent', 'agent-loop', 'agent-default-model', 'headless-startup',
    'reflexmesh-observer', 'reflexmesh-teardown-fixture']);
  assert.equal(rows.find(row => row.id === 'tools').config.mode, 'native');
  assert.deepEqual(rows.find(row => row.id === 'reflexmesh-observer').config, {
    dbPath: '/synthetic/ledger.sqlite', tenantId: 'isolated-fixture', scope: 'teardown',
    intentMode: 'explicit-summary', shutdownResultWaitMs: 0,
  });
  assert.match(patch, /inject: \[headlessStartup, agentLoop, reflexmeshSyntheticFixtureReady\]/);
  assert.doesNotMatch(patch, /dsh-base|\.env|credentials|telemetry-plugin/);
});

test('missing installation gives fixed standalone and wrapper failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-teardown-missing-'));
  t.after(() => cleanTemp(directory));
  const missing = join(directory, 'missing');
  const standalone = await runDeepSeekTeardownProbe(missing);
  assert.equal(standalone.reason, 'host_package_missing');
  assert.equal(standalone.agentLoopExercised, false);
  assert.equal(standalone.modelInference, false);
  const script = fileURLToPath(new URL('../scripts/deepseek-teardown-probe.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, missing], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).reason, 'host_package_missing');
  const wrapped = await runCompatibilityProbe(parseArgs(['--host', 'deepseek', '--deepseek-mode', 'observer-teardown',
    '--deepseek-package-root', missing, '--node-command', process.execPath]));
  assert.equal(wrapped.status, 'failed');
  assert.equal(wrapped.reason, 'host_package_missing');
  assert.equal(wrapped.results[0].requestedEvidenceLevel, 'cli_agent_observer_teardown');
  assert.equal(wrapped.evidenceLevel, 'none');
  assert.equal(wrapped.agentE2E, false);
  assert.equal(wrapped.modelInference, false);
});

test('wrapper requires exact status and process-exit agreement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-teardown-transport-'));
  t.after(() => cleanTemp(directory));
  const childScript = join(directory, 'synthetic-receipt.mjs');
  const options = () => parseArgs(['--host', 'deepseek', '--deepseek-mode', 'observer-teardown',
    '--deepseek-package-root', directory, '--node-command', process.execPath, '--node-command-arg', childScript]);
  for (const [value, exitCode, expected] of [
    [{ ...passed(), private: 'DO_NOT_FORWARD' }, 0, 'cli_observer_teardown_passed'],
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
    assert.equal(report.evidenceLevel, expected === 'cli_observer_teardown_passed' ? 'cli_agent_observer_teardown' : 'none');
  }
});
