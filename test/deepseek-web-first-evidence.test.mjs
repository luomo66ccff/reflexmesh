import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parseWebFirstArgs, runWebFirstEvidence } from '../scripts/deepseek-web-first-evidence.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-web-first-test-'));
  t.after(async () => {
    const target = realpathSync(root), base = realpathSync(tmpdir());
    const rel = relative(base, target);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
      && basename(target).startsWith('reflexmesh-web-first-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const home = join(root, 'home'), profile = join(home, 'profiles', 'web');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: selected-plugin\n');
  writeFileSync(join(profile, 'cordis.yml'), '# ORIGINAL\n');
  const options = { packageRoot: join(root, 'installed'), dshHome: home,
    profile: 'web', outDir: join(root, 'new-evidence'), ack: true };
  return { root, home, profile, options };
}

const preflight = async () => ({ status: 'passed', currentObserver: 'absent',
  overlay: 'composed_in_isolation', sourceConfigurationUnchanged: true,
  temporaryProfileRemoved: true });
const evidence = () => ({ oneLedgerDecision: true, shadowBindingOnly: true,
  nativeToolResultCorrelated: true, zeroLabels: true, hostIdentityBound: true });
const synthetic = { isolatedProfileLoaded: true, loaderProfileBound: true,
  requests: 2, bodyCalls: 1, toolAdvertised: true, toolResultSeen: true,
  toolHadAgent: true, toolArgsExact: true, sessionConsistent: true, toolCount: 5,
  backgroundRequests: 1 };
const ready = { startupCommitted: true, observerEntryActivated: true,
  overlayArgPresent: true, profileTreeBound: true, webServerReady: true,
  phase: 'ready_for_browser' };
const finished = { ...ready, webUserMessageSeen: true,
  agentTurnCompleted: true, finalFixtureMarker: true,
  naturalBeforeExit: true, observerDrainedAtExit: true,
  kernelClosedAtExit: true, phase: 'complete' };

function dependencies(f, { final = finished, onLaunch = () => {},
  awaitBrowser = async () => {}, retain = async () => true,
  readEvidence = evidence } = {}) {
  return {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    hostIdle: () => true,
    previewProfile: preflight,
    linkModules: async (_source, target) => { mkdirSync(target); },
    readEvidence, retain, awaitBrowser,
    output: { write() {} },
    launch: ({ home, overlayPath, fixturePath, env }) => {
      assert.equal(env.DSH_HOME, home);
      assert.equal(env.DSH_PERMISSION_MODE, 'read-only');
      assert.equal(env.SSH_TTY, 'reflexmesh-isolated-web-ui-probe');
      assert.match(readFileSync(overlayPath, 'utf8'), /reflexmesh-observer/);
      const patch = readFileSync(fixturePath, 'utf8');
      assert.match(patch, /reflexmesh-web-ui-fixture/);
      assert.match(patch, /reflexmesh-synthetic-fixture/);
      assert.match(patch, /provider: reflexmesh-synthetic/);
      assert.doesNotMatch(patch, /selected-profile-boot-fixture/);
      onLaunch(home);
      writeFileSync(join(home, 'web-ui-status.json'), JSON.stringify(ready));
      writeFileSync(join(home, 'browser-url.txt'), 'http://127.0.0.1:1234/?token=synthetic-test');
      writeFileSync(join(home, 'synthetic-receipt.json'), JSON.stringify(synthetic));
      const child = new EventEmitter();
      child.exitCode = null; child.signalCode = null; child.connected = true;
      child.send = () => {
        writeFileSync(join(home, 'web-ui-status.json'), JSON.stringify(final));
        child.connected = false; child.exitCode = final.webUserMessageSeen ? 0 : 1;
        child.emit('exit', child.exitCode, null);
      };
      child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); };
      return child;
    },
  };
}

test('Web first-evidence CLI refuses missing acknowledgement, unsafe profile and duplicate flags', () => {
  assert.deepEqual(parseWebFirstArgs(['--help']), { help: true });
  const args = ['--deepseek-package-root', join(tmpdir(), 'installed'),
    '--dsh-home', join(tmpdir(), 'home'), '--profile', 'web',
    '--out-dir', join(tmpdir(), 'output')];
  assert.equal(parseWebFirstArgs(args).invalid, true);
  assert.equal(parseWebFirstArgs([...args, '--ack-selected-plugins']).ack, true);
  assert.equal(parseWebFirstArgs([...args, '--ack-selected-plugins', '--ack-selected-plugins']).invalid, true);
  assert.equal(parseWebFirstArgs([...args.slice(0, 5), '../web', ...args.slice(6),
    '--ack-selected-plugins']).invalid, true);
  const bad = spawnSync(process.execPath, ['scripts/deepseek-web-first-evidence.mjs',
    '--out-dir', 'PRIVATE_OUTPUT_PATH'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout.includes('PRIVATE_OUTPUT_PATH'), false);
});

test('concurrent installed host and duplicate observer block Web startup before creating output', async t => {
  const f = fixture(t); let launches = 0;
  const base = dependencies(f, { onLaunch: () => { launches++; } });
  const concurrent = await runWebFirstEvidence(f.options, { ...base, hostIdle: () => false });
  assert.equal(concurrent.reason, 'installed_host_in_use');
  assert.equal(concurrent.hostBoot, 'not_started');
  const duplicate = await runWebFirstEvidence(f.options, { ...base,
    previewProfile: async () => ({ status: 'attention', currentObserver: 'present_in_composed_config' }),
  });
  assert.equal(duplicate.reason, 'profile_preflight_unavailable');
  assert.equal(launches, 0);
  assert.equal(existsSync(f.options.outDir), false);
});

test('new-only evidence destination refuses existing and live-home paths before boot', async t => {
  const f = fixture(t); let launches = 0;
  const deps = dependencies(f, { onLaunch: () => { launches++; } });
  mkdirSync(f.options.outDir);
  const existing = await runWebFirstEvidence(f.options, deps);
  assert.equal(existing.reason, 'output_already_exists');
  const inside = await runWebFirstEvidence({ ...f.options, outDir: join(f.home, 'bad-output') }, deps);
  assert.equal(inside.reason, 'output_overlaps_profile_home');
  assert.equal(launches, 0);
});

test('browser confirmation without matching Web user message never certifies evidence', async t => {
  const f = fixture(t); let retained = 0, temp;
  const report = await runWebFirstEvidence(f.options, dependencies(f, {
    final: { ...finished, webUserMessageSeen: false },
    onLaunch: home => { temp = home; },
    retain: async () => { retained++; return true; },
  }));
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'host_exit_unverified');
  assert.equal(retained, 0);
  assert.equal(report.temporaryProfileRemoved, true);
  assert.equal(existsSync(temp), false);
});

test('browser abort is fail-closed and does not publish a retained receipt', async t => {
  const f = fixture(t); let retained = 0, temp;
  const report = await runWebFirstEvidence(f.options, dependencies(f, {
    final: { ...finished, webUserMessageSeen: false },
    onLaunch: home => { temp = home; },
    awaitBrowser: async () => { throw new Error('browser_confirmation_unavailable'); },
    retain: async () => { retained++; return true; },
  }));
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'browser_confirmation_unavailable');
  assert.equal(report.temporaryProfileRemoved, true);
  assert.equal(existsSync(temp), false);
  assert.equal(retained, 0);
  assert.equal(existsSync(f.options.outDir), false);
});

test('a verified browser fixture turn keeps source files and closes the temporary host', async t => {
  const f = fixture(t); let temp, retained = 0, retainedAt;
  const report = await runWebFirstEvidence(f.options, dependencies(f, {
    onLaunch: home => { temp = home; },
    retain: async (_db, outDir) => { retained++; retainedAt = outDir; return true; },
  }));
  assert.equal(report.status, 'passed', JSON.stringify(report));
  assert.equal(report.assertions.length, 21);
  assert.ok(report.assertions.every(item => item.passed));
  assert.equal(report.webUserMessageSeen, true);
  assert.equal(report.sourceConfigurationUnchanged, true);
  assert.equal(report.temporaryProfileRemoved, true);
  assert.equal(retained, 1);
  assert.equal(statSync(dirname(retainedAt)).ino, statSync(f.root).ino);
  assert.equal(statSync(dirname(retainedAt)).dev, statSync(f.root).dev);
  assert.equal(basename(retainedAt), 'new-evidence');
  assert.equal(existsSync(temp), false);
  assert.equal(readFileSync(join(f.profile, 'cordis.yml'), 'utf8'), '# ORIGINAL\n');
});
