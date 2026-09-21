import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIFECYCLE_ASSERTIONS, LIFECYCLE_EVIDENCE,
  evaluateLifecycleProbeOutput } from '../scripts/deepseek-lifecycle-contract.mjs';
import { isolatedLifecyclePatch, runDeepSeekLifecycleProbe } from '../scripts/deepseek-lifecycle-probe.mjs';
import { parseArgs, runCompatibilityProbe } from '../scripts/real-host-compat.mjs';

const passed = () => ({ schemaVersion: 1, ...LIFECYCLE_EVIDENCE, agentLoopExercised: true,
  hostVersion: '0.1.2-rc.1', status: 'passed', reason: 'cli_lifecycle_matrix_passed',
  assertions: LIFECYCLE_ASSERTIONS.map(name => ({ name, passed: true })) });
const cleanTemp = async root => {
  const target = await realpath(root);
  const rel = relative(await realpath(tmpdir()), target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
    && basename(target).startsWith('rm-lifecycle-'));
  await rm(target, { recursive: true, force: true });
};

test('lifecycle receipt is an exact fixed claim and strips private child fields', () => {
  const value = passed();
  const assessed = evaluateLifecycleProbeOutput(JSON.stringify({ ...value, privatePrompt: 'DO_NOT_FORWARD',
    assertions: value.assertions.map(item => ({ ...item, private: 'DO_NOT_FORWARD' })) }));
  assert.equal(assessed.status, 'passed');
  assert.equal(JSON.stringify(assessed).includes('DO_NOT_FORWARD'), false);
  for (const replacement of [
    { agentE2E: true }, { modelInference: true }, { classification: 'calibrated' },
    { modelTransport: 'real_model' }, { agentLoopExercised: false }, { hostVersion: '0.1.3' },
    { assertions: value.assertions.slice(1) },
    { assertions: [...value.assertions, { name: 'extra', passed: true }] },
    { assertions: value.assertions.map((item, index) => index === 4 ? { ...item, passed: false } : item) },
  ]) assert.equal(evaluateLifecycleProbeOutput(JSON.stringify({ ...value, ...replacement })), null);
  assert.equal(evaluateLifecycleProbeOutput('not-json'), null);
  assert.equal(evaluateLifecycleProbeOutput(JSON.stringify({ ...value,
    status: 'failed', reason: 'PRIVATE_ERROR', agentLoopExercised: false })), null);
  const failed = evaluateLifecycleProbeOutput(JSON.stringify({ ...value,
    status: 'failed', reason: 'host_timeout', agentLoopExercised: false, hostVersion: 'PRIVATE_VERSION' }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.version, 'unknown');
  assert.ok(failed.assertions.every(item => item.passed === false));
});

test('lifecycle patch contains only fixed native Agent and synthetic fixture rows', () => {
  for (const scenario of ['parallel', 'cancel']) {
    const patch = isolatedLifecyclePatch({ packageRoot: '/synthetic/packages/dsh', dbPath: '/synthetic/ledger.sqlite',
      telemetryPath: '/synthetic/receipt.json', homePath: '/synthetic/home', cwdPath: '/synthetic/cwd', scenario });
    const rows = patch.split('\n').filter(line => line.startsWith('  - {')).map(line => JSON.parse(line.slice(4)));
    assert.deepEqual(rows.map(row => row.id), ['timer', 'llm', 'session', 'session-projection', 'system-prompt',
      'tools', 'agent', 'agent-loop', 'agent-default-model', 'headless-startup',
      'reflexmesh-observer', 'reflexmesh-lifecycle-fixture']);
    assert.equal(rows.find(row => row.id === 'agent-loop').config.maxParallelToolCalls, 2);
    assert.equal(rows.find(row => row.id === 'tools').config.mode, 'native');
    assert.deepEqual(rows.find(row => row.id === 'reflexmesh-observer').config, {
      dbPath: '/synthetic/ledger.sqlite', tenantId: 'isolated-fixture',
      scope: `lifecycle-${scenario}`, intentMode: 'explicit-summary',
    });
    assert.match(patch, /inject: \[headlessStartup, agentLoop, reflexmeshObserverReady, reflexmeshSyntheticFixtureReady\]/);
    assert.doesNotMatch(patch, /dsh-base|\.env|credentials|telemetry-plugin/);
  }
  assert.throws(() => isolatedLifecyclePatch({ scenario: 'other' }), /Unsupported synthetic scenario/);
});

test('missing installation has fixed standalone and wrapper failure without starting a host', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-lifecycle-missing-'));
  t.after(() => cleanTemp(directory));
  const missing = join(directory, 'missing');
  const standalone = await runDeepSeekLifecycleProbe(missing);
  assert.equal(standalone.reason, 'host_package_missing');
  assert.equal(standalone.agentLoopExercised, false);
  assert.equal(standalone.agentE2E, false);
  assert.equal(standalone.modelInference, false);
  const script = fileURLToPath(new URL('../scripts/deepseek-lifecycle-probe.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, missing], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1);
  // Node 22 emits exactly this built-in warning for node:sqlite; reject all other stderr.
  assert.match(child.stderr, /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/);
  assert.equal(JSON.parse(child.stdout).reason, 'host_package_missing');
  const wrapped = await runCompatibilityProbe(parseArgs(['--host', 'deepseek', '--deepseek-mode', 'lifecycle-matrix',
    '--deepseek-package-root', missing, '--node-command', process.execPath]));
  assert.equal(wrapped.status, 'failed');
  assert.equal(wrapped.reason, 'host_package_missing');
  assert.equal(wrapped.results[0].requestedEvidenceLevel, 'cli_agent_lifecycle_matrix');
  assert.equal(wrapped.evidenceLevel, 'none');
  assert.equal(wrapped.agentE2E, false);
  assert.equal(wrapped.modelInference, false);
});

test('wrapper requires status and exit agreement for synthetic lifecycle receipts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-lifecycle-transport-'));
  t.after(() => cleanTemp(directory));
  const childScript = join(directory, 'synthetic-receipt.mjs');
  const options = () => parseArgs(['--host', 'deepseek', '--deepseek-mode', 'lifecycle-matrix',
    '--deepseek-package-root', directory, '--node-command', process.execPath, '--node-command-arg', childScript]);
  for (const [value, exitCode, expected] of [
    [{ ...passed(), private: 'DO_NOT_FORWARD' }, 0, 'cli_lifecycle_matrix_passed'],
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
    if (expected !== 'cli_lifecycle_matrix_passed') assert.equal(report.evidenceLevel, 'none');
    else assert.equal(report.evidenceLevel, 'cli_agent_lifecycle_matrix');
  }
});
