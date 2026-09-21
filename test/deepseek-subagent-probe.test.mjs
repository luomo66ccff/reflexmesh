import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SUBAGENT_ASSERTIONS, SUBAGENT_EVIDENCE,
  evaluateSubagentProbeOutput } from '../scripts/deepseek-subagent-contract.mjs';
import { inspectSubagentPackages, isolatedSubagentPatch, matchSubagentOutcome,
  runDeepSeekSubagentProbe } from '../scripts/deepseek-subagent-probe.mjs';
import { parseArgs, runCompatibilityProbe } from '../scripts/real-host-compat.mjs';
import { digest } from '../adapters/sqlite-kernel.mjs';

const passed = () => ({ schemaVersion: 1, ...SUBAGENT_EVIDENCE, agentLoopExercised: true,
  hostVersion: '0.1.2-rc.1', status: 'passed', reason: 'cli_subagent_isolation_passed',
  assertions: SUBAGENT_ASSERTIONS.map(name => ({ name, passed: true })) });
const cleanTemp = async root => {
  const target = await realpath(root);
  const rel = relative(await realpath(tmpdir()), target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
    && basename(target).startsWith('rm-subagent-'));
  await rm(target, { recursive: true, force: true });
};

test('subagent receipt is exact, fixed and cannot claim model inference', () => {
  const value = passed();
  const assessed = evaluateSubagentProbeOutput(JSON.stringify({ ...value, rawPrompt: 'DO_NOT_FORWARD',
    assertions: value.assertions.map(item => ({ ...item, private: 'DO_NOT_FORWARD' })) }));
  assert.equal(assessed.status, 'passed');
  assert.equal(JSON.stringify(assessed).includes('DO_NOT_FORWARD'), false);
  for (const replacement of [
    { agentE2E: true }, { modelInference: true }, { classification: 'calibrated' },
    { modelTransport: 'real_model' }, { agentLoopExercised: false }, { hostVersion: '0.1.3' },
    { assertions: value.assertions.slice(1) },
    { assertions: [...value.assertions, { name: 'extra', passed: true }] },
    { assertions: value.assertions.map((item, index) => index === 5 ? { ...item, passed: false } : item) },
  ]) assert.equal(evaluateSubagentProbeOutput(JSON.stringify({ ...value, ...replacement })), null);
  assert.equal(evaluateSubagentProbeOutput('not-json'), null);
  assert.equal(evaluateSubagentProbeOutput(JSON.stringify({ ...value, status: 'failed',
    reason: 'PRIVATE_ERROR', agentLoopExercised: false })), null);
  const failure = evaluateSubagentProbeOutput(JSON.stringify({ ...value, status: 'failed',
    reason: 'host_timeout', agentLoopExercised: false, hostVersion: 'PRIVATE_VERSION' }));
  assert.equal(failure.status, 'failed');
  assert.equal(failure.version, 'unknown');
  assert.ok(failure.assertions.every(item => item.passed === false));
});

test('isolated patch is a bounded official spawn composition with no inherited base bundle', () => {
  const patch = isolatedSubagentPatch({ packageRoot: '/synthetic/packages/dsh', dbPath: '/synthetic/ledger.sqlite',
    telemetryPath: '/synthetic/receipt.json', homePath: '/synthetic/home', cwdPath: '/synthetic/cwd' });
  const rows = patch.split('\n').filter(line => line.startsWith('  - {')).map(line => JSON.parse(line.slice(4)));
  assert.deepEqual(rows.map(row => row.id), ['timer', 'llm', 'session', 'session-projection', 'system-prompt',
    'tools', 'agent', 'agent-loop', 'subagent', 'subagent-spawn', 'agent-default-model',
    'headless-startup', 'reflexmesh-observer', 'reflexmesh-subagent-fixture']);
  assert.equal(rows.find(row => row.id === 'tools').config.mode, 'native');
  assert.deepEqual(rows.find(row => row.id === 'reflexmesh-observer').config, {
    dbPath: '/synthetic/ledger.sqlite', tenantId: 'isolated-fixture', scope: 'subagent-isolation',
    intentMode: 'explicit-summary',
  });
  assert.match(patch, /inject: \[headlessStartup, agentLoop, reflexmeshObserverReady, reflexmeshSyntheticFixtureReady\]/);
  assert.doesNotMatch(patch, /dsh-base|\.env|credentials|telemetry-plugin/);
});

test('optional subagent packages are pinned by manifest and entrypoint before import', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rm-subagent-packages-'));
  t.after(() => cleanTemp(root));
  const dsh = join(root, 'dsh');
  assert.equal(inspectSubagentPackages(dsh), false);
  for (const name of ['dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-subagent-in-process-driver']) {
    const dir = join(root, name, 'lib');
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, name, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`,
      version: '0.1.2-rc.1' }));
    await writeFile(join(dir, 'index.js'), "throw new Error('DO_NOT_IMPORT');\n");
  }
  assert.equal(inspectSubagentPackages(dsh), true);
  await writeFile(join(root, 'dsh-subagent', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-subagent', version: 'PRIVATE_VERSION',
  }));
  assert.equal(inspectSubagentPackages(dsh), false);
});

test('same call id cannot accept another Agent result digest or altered observation identity', () => {
  const call = 'same-call-id';
  const name = 'reflexmesh_subagent_read';
  const row = (agent, evidenceDigest) => ({ agent, call, name,
    raw: { observations: [{ id: digest([call, 'outcome']), status: 'succeeded',
      provenance: 'harness-reported', evidenceDigest }] } });
  const native = (agent, evidenceDigest) => ({ agentId: agent, callId: call, name,
    isError: false, evidenceDigest });
  const parent = row('parent', 'a'.repeat(64));
  const child = row('child', 'b'.repeat(64));
  assert.equal(matchSubagentOutcome(parent, native('parent', 'a'.repeat(64))), true);
  assert.equal(matchSubagentOutcome(child, native('child', 'b'.repeat(64))), true);
  assert.equal(matchSubagentOutcome(parent, native('child', 'b'.repeat(64))), false);
  assert.equal(matchSubagentOutcome(parent, native('parent', 'b'.repeat(64))), false);
  assert.equal(matchSubagentOutcome(child, native('child', 'a'.repeat(64))), false);
  assert.equal(matchSubagentOutcome({ ...parent, raw: { observations: [{
    ...parent.raw.observations[0], id: 'c'.repeat(64),
  }] } }, native('parent', 'a'.repeat(64))), false);
  assert.equal(matchSubagentOutcome({ ...parent, raw: { observations: [{
    ...parent.raw.observations[0], provenance: 'model-reported',
  }] } }, native('parent', 'a'.repeat(64))), false);
});

test('missing installation fails standalone and wrapper without starting a host', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rm-subagent-missing-'));
  t.after(() => cleanTemp(root));
  const missing = join(root, 'missing');
  const direct = await runDeepSeekSubagentProbe(missing);
  assert.equal(direct.reason, 'host_package_missing');
  assert.equal(direct.agentLoopExercised, false);
  assert.equal(direct.agentE2E, false);
  assert.equal(direct.modelInference, false);
  const script = fileURLToPath(new URL('../scripts/deepseek-subagent-probe.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, missing], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/);
  assert.equal(JSON.parse(child.stdout).reason, 'host_package_missing');
  const wrapped = await runCompatibilityProbe(parseArgs(['--host', 'deepseek', '--deepseek-mode', 'subagent-isolation',
    '--deepseek-package-root', missing, '--node-command', process.execPath]));
  assert.equal(wrapped.status, 'failed');
  assert.equal(wrapped.reason, 'host_package_missing');
  assert.equal(wrapped.results[0].requestedEvidenceLevel, 'cli_agent_subagent_isolation');
  assert.equal(wrapped.evidenceLevel, 'none');
  assert.equal(wrapped.agentE2E, false);
  assert.equal(wrapped.modelInference, false);
});

test('wrapper validates child status against exit code and strips extra fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rm-subagent-transport-'));
  t.after(() => cleanTemp(root));
  const childScript = join(root, 'synthetic-receipt.mjs');
  const options = () => parseArgs(['--host', 'deepseek', '--deepseek-mode', 'subagent-isolation',
    '--deepseek-package-root', root, '--node-command', process.execPath, '--node-command-arg', childScript]);
  for (const [value, exitCode, expected] of [
    [{ ...passed(), private: 'DO_NOT_FORWARD' }, 0, 'cli_subagent_isolation_passed'],
    [passed(), 1, 'probe_exit_mismatch'],
    [{ ...passed(), status: 'failed', reason: 'evidence_assertion_failed', agentLoopExercised: false }, 1,
      'evidence_assertion_failed'],
    [{ ...passed(), modelInference: true }, 0, 'probe_output_invalid'],
  ]) {
    await writeFile(childScript, `process.stdout.write(${JSON.stringify(JSON.stringify(value))}); process.exitCode=${exitCode};`);
    const report = await runCompatibilityProbe(options());
    assert.equal(report.reason, expected);
    assert.equal(report.agentE2E, false);
    assert.equal(report.modelInference, false);
    assert.equal(JSON.stringify(report).includes('DO_NOT_FORWARD'), false);
    if (expected !== 'cli_subagent_isolation_passed') assert.equal(report.evidenceLevel, 'none');
    else assert.equal(report.evidenceLevel, 'cli_agent_subagent_isolation');
  }
});
