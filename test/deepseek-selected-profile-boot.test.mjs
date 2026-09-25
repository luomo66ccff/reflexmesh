import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { parseSelectedBootArgs, runSelectedProfileBoot, selectedWebHostArgs } from '../scripts/deepseek-selected-profile-boot.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-selected-boot-test-'));
  t.after(async () => {
    const target = realpathSync(root), base = realpathSync(tmpdir());
    const rel = relative(base, target);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
      && basename(target).startsWith('reflexmesh-selected-boot-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const home = join(root, 'home'), profile = join(home, 'profiles', 'web');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: existing-plugin\n');
  writeFileSync(join(profile, 'cordis.yml'), '# ORIGINAL\n');
  return { root, home, profile, options: { packageRoot: join(root, 'installed'), dshHome: home, profile: 'web' } };
}

const telemetry = { startupCommitted: true, observerEntryActivated: true,
  overlayArgPresent: true, profileTreeBound: true, webServerReady: true,
  observerDrainedAtExit: true, kernelClosedAtExit: true, naturalBeforeExit: true,
  agentTurnCompleted: true, finalFixtureMarker: true };
const synthetic = { isolatedProfileLoaded: true, loaderProfileBound: true,
  requests: 2, bodyCalls: 1, toolAdvertised: true, toolResultSeen: true,
  toolHadAgent: true, toolArgsExact: true, sessionConsistent: true, toolCount: 5,
  backgroundRequests: 1 };
const evidence = () => ({ oneLedgerDecision: true, shadowBindingOnly: true,
  nativeToolResultCorrelated: true, zeroLabels: true, hostIdentityBound: true });
const preflight = async () => ({ status: 'passed', reason: 'overlay_composed',
  currentObserver: 'absent', overlay: 'composed_in_isolation', sourceConfigurationUnchanged: true,
  temporaryProfileRemoved: true });

test('selected-profile boot requires explicit paths and one safe profile name', () => {
  assert.deepEqual(parseSelectedBootArgs(['--help']), { help: true });
  assert.equal(parseSelectedBootArgs(['--profile', 'web']).invalid, true);
  assert.equal(parseSelectedBootArgs(['--profile', '../web']).invalid, true);
  assert.equal(parseSelectedBootArgs(['--profile', 'tui']).invalid, true);
  assert.equal(parseSelectedBootArgs(['--profile', 'web', '--profile', 'other']).invalid, true);
  const invalid = spawnSync(process.execPath, ['scripts/deepseek-selected-profile-boot.mjs',
    '--deepseek-package-root', 'PRIVATE_INSTALL_PATH', '--json'],
  { encoding: 'utf8', timeout: 10_000 });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).reason, 'invalid_arguments');
  assert.equal(invalid.stdout.includes('PRIVATE_INSTALL_PATH'), false);
  assert.deepEqual(selectedWebHostArgs({ binPath: 'dsh', profile: 'web',
    overlayPath: 'observer', fixturePath: 'fixture' }),
  ['dsh', '--profile', 'web', '--patch', 'observer', '--patch', 'fixture',
    '--host', '127.0.0.1', '--port', '0', '--no-open']);
});

test('preflight refuses an observer already composed before any host boot', async t => {
  const f = fixture(t); let boots = 0;
  const report = await runSelectedProfileBoot(f.options, {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    previewProfile: async () => ({ status: 'attention', reason: 'observer_already_present',
      currentObserver: 'present_in_composed_config', sourceConfigurationUnchanged: true,
      temporaryProfileRemoved: true }),
    runHost: async () => { boots++; return { ok: true }; },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'observer_already_present');
  assert.equal(report.hostBoot, 'not_started');
  assert.equal(boots, 0);
});

test('selected-profile boot copies bounded config, applies CLI overlay, and cleans up', async t => {
  const f = fixture(t); let tempHome;
  const report = await runSelectedProfileBoot(f.options, {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    previewProfile: preflight,
    linkModules: async (_source, target) => { mkdirSync(target); },
    readEvidence: evidence,
    runHost: async ({ home, overlayPath, fixturePath, telemetryPath }) => {
      tempHome = home;
      assert.match(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /existing-plugin/);
      assert.match(readFileSync(overlayPath, 'utf8'), /reflexmesh-observer/);
      assert.match(readFileSync(fixturePath, 'utf8'), /reflexmesh-selected-profile-boot-fixture/);
      assert.match(readFileSync(fixturePath, 'utf8'), /reflexmesh-synthetic-fixture/);
      writeFileSync(telemetryPath, JSON.stringify(telemetry));
      writeFileSync(join(home, 'synthetic-receipt.json'), JSON.stringify(synthetic));
      return { ok: true, stdout: '' };
    },
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.kind, 'deepseek_selected_profile_synthetic_tool');
  assert.equal(report.assertions.length, 17);
  assert.equal(report.harnessToolCalls, 'one_fixture_read');
  assert.ok(report.assertions.every(item => item.passed));
  assert.equal(report.sourceConfigurationUnchanged, true);
  assert.equal(report.temporaryProfileRemoved, true);
  assert.equal(existsSync(tempHome), false);
  assert.equal(readFileSync(join(f.profile, 'cordis.yml'), 'utf8'), '# ORIGINAL\n');
});

test('changed source or missing startup receipt cannot be certified', async t => {
  const f = fixture(t);
  const dependencies = {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    previewProfile: preflight,
    linkModules: async (_source, target) => { mkdirSync(target); },
    readEvidence: evidence,
  };
  const changed = await runSelectedProfileBoot(f.options, { ...dependencies,
    runHost: async ({ telemetryPath }) => {
      writeFileSync(join(f.profile, 'cordis.yml'), '# CHANGED\n');
      writeFileSync(telemetryPath, JSON.stringify(telemetry));
      writeFileSync(join(telemetryPath, '..', 'synthetic-receipt.json'), JSON.stringify(synthetic));
      return { ok: true, stdout: '' };
    },
  });
  assert.equal(changed.status, 'failed');
  assert.equal(changed.reason, 'source_configuration_changed');
  assert.equal(changed.sourceConfigurationUnchanged, false);
  const missing = await runSelectedProfileBoot(f.options, { ...dependencies,
    runHost: async () => ({ ok: true, stdout: '' }),
  });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.reason, 'startup_receipt_unavailable');
  const unsafeListener = await runSelectedProfileBoot(f.options, { ...dependencies,
    runHost: async ({ telemetryPath }) => {
      writeFileSync(telemetryPath, JSON.stringify({ ...telemetry, webServerReady: false }));
      writeFileSync(join(telemetryPath, '..', 'synthetic-receipt.json'), JSON.stringify(synthetic));
      return { ok: true, stdout: '' };
    },
  });
  assert.equal(unsafeListener.status, 'failed');
  assert.equal(unsafeListener.reason, 'selected_profile_assertion_failed');
  assert.equal(unsafeListener.assertions.find(item => item.name === 'webServerReady').passed, false);
});

test('missing tool-result evidence fails instead of certifying a startup-only boot', async t => {
  const f = fixture(t);
  const report = await runSelectedProfileBoot(f.options, {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    previewProfile: preflight,
    linkModules: async (_source, target) => { mkdirSync(target); },
    readEvidence: () => ({ ...evidence(), nativeToolResultCorrelated: false }),
    runHost: async ({ home, telemetryPath }) => {
      writeFileSync(telemetryPath, JSON.stringify(telemetry));
      writeFileSync(join(home, 'synthetic-receipt.json'), JSON.stringify(synthetic));
      return { ok: true, stdout: '' };
    },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'selected_profile_assertion_failed');
  assert.equal(report.assertions.find(item => item.name === 'nativeToolResultCorrelated').passed, false);
});
