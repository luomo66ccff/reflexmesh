import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENT_ASSERTIONS, AGENT_EVIDENCE, evaluateAgentProbeOutput } from '../scripts/deepseek-agent-contract.mjs';
import { inspectAgentPackages, isolatedPatch, observerOverlay, runDeepSeekAgentProbe } from '../scripts/deepseek-agent-probe.mjs';

function cleanup(root) {
  const target = realpathSync(root);
  const rel = relative(realpathSync(tmpdir()), target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
    && basename(target).startsWith('reflexmesh-agent-test-'));
  rmSync(target, { recursive: true, force: true });
}

test('agent probe has a fixed sanitized failure contract without installed host packages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-agent-test-'));
  try {
    const report = await runDeepSeekAgentProbe(join(root, 'not-installed'));
    assert.equal(report.status, 'failed');
    assert.equal(report.reason, 'host_package_missing');
    assert.equal(report.agentLoopExercised, false);
    assert.equal(report.agentE2E, false);
    assert.equal(report.modelInference, false);
    assert.deepEqual(report.assertions.map(row => row.name), AGENT_ASSERTIONS);
    assert.ok(report.assertions.every(row => row.passed === false));
    assert.deepEqual(evaluateAgentProbeOutput(JSON.stringify(report)).assertions, report.assertions);

    const child = spawnSync(process.execPath, ['scripts/deepseek-agent-probe.mjs', join(root, 'not-installed')], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.status, 1);
    // Node 22 emits this built-in warning on import; reject every other stderr
    // byte instead of disabling warnings or allowing arbitrary error output.
    assert.match(child.stderr, /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/);
    assert.equal(JSON.parse(child.stdout).reason, 'host_package_missing');
    assert.equal(child.stdout.includes(root), false);
  } finally { cleanup(root); }
});

test('installed package inspection rejects unknown versions before any host import', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-agent-test-'));
  const dsh = join(root, 'dsh');
  try {
    mkdirSync(dsh);
    writeFileSync(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '99.0.0' }));
    assert.deepEqual(inspectAgentPackages(dsh), {
      ok: false, reason: 'unsupported_host_version', hostVersion: '99.0.0',
    });
  } finally { cleanup(root); }
});

test('isolated patch lists only fixed runtime rows and gate services', () => {
  const patch = isolatedPatch({ packageRoot: '/synthetic/packages/dsh',
    telemetryPath: '/synthetic/telemetry.json', homePath: '/synthetic/home', cwdPath: '/synthetic/cwd',
    overlayPath: '/synthetic/observer.patch.yml' });
  assert.equal(patch.startsWith('- insert:\n'), true);
  assert.doesNotMatch(patch, /reflexmesh-observer|deepseek-loader-plugin/);
  const overlay = observerOverlay('/synthetic/db.sqlite');
  assert.match(overlay, /"id":"reflexmesh-observer"/);
  assert.match(overlay, /"intentMode":"explicit-summary"/);
  assert.doesNotMatch(overlay, /reflexmesh-synthetic-fixture|headless-runner/);
  assert.ok(AGENT_ASSERTIONS.includes('observer_overlay_via_cli'));
  assert.match(patch, /reflexmeshObserverReady, reflexmeshSyntheticFixtureReady/);
  assert.match(patch, /task: !!js ctx\.headlessStartup\.task/);
  assert.doesNotMatch(patch, /dsh-base|dsh-persistence|session-telemetry|REFLEXMESH_PROVIDER|TYPESAFE_API_KEY/);
  assert.deepEqual(Object.keys(AGENT_EVIDENCE), ['evidenceLevel', 'agentE2E', 'modelInference', 'modelTransport', 'classification']);
});
