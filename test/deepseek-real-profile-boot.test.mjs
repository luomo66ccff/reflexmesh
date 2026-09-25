import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { parseRealBootArgs, runRealProfileBoot } from '../scripts/deepseek-real-profile-boot.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-real-home-test-'));
  t.after(async () => {
    const target = realpathSync(root), base = realpathSync(tmpdir());
    const rel = relative(base, target);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
      && basename(target).startsWith('reflexmesh-real-home-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const home = join(root, 'data'), profile = join(home, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(home, '.credentials.yaml'), 'synthetic-credential-only\n');
  writeFileSync(join(home, 'settings.yaml'), 'synthetic-setting-only\n');
  writeFileSync(join(profile, 'package.json'), '{"private":true}\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: selected-plugin\n');
  writeFileSync(join(profile, 'cordis.yml'), '# generated root\n');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'attachments'), { recursive: true });
  writeFileSync(join(home, 'sessions', 'fixture.zstd'), 'synthetic-session-only\n');
  writeFileSync(join(home, 'attachments', 'fixture.bin'), 'synthetic-attachment-only\n');
  const archive = join(root, 'backup.tar');
  const packed = spawnSync('tar', ['-cf', archive, '-C', root, 'data'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, 'test backup archive must be creatable');
  const backupSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const options = { packageRoot: join(root, 'installed'), dshHome: home,
    profile: 'web', backupArchive: archive, backupSha256, ack: true };
  return { root, home, profile, options };
}

const preflight = async () => ({ status: 'passed', currentObserver: 'absent',
  overlay: 'composed_in_isolation', sourceConfigurationUnchanged: true,
  temporaryProfileRemoved: true });
const installed = options => ({ ok: true, root: options.packageRoot, hostVersion: '0.1.2-rc.1' });
const bootReceipt = { startupCommitted: true, observerEntryActivated: true,
  overlayArgPresent: true, profileTreeBound: true, webServerReady: true,
  observerDrainedAtExit: true, kernelClosedAtExit: true, naturalBeforeExit: true,
  agentTurnCompleted: true, finalFixtureMarker: true };
const toolReceipt = { isolatedProfileLoaded: true, loaderProfileBound: true,
  requests: 2, bodyCalls: 1, toolAdvertised: true, toolResultSeen: true,
  toolHadAgent: true, toolArgsExact: true, sessionConsistent: true,
  toolCount: 5, backgroundRequests: 1 };
const evidence = () => ({ oneLedgerDecision: true, shadowBindingOnly: true,
  nativeToolResultCorrelated: true, zeroLabels: true, hostIdentityBound: true });

test('real-home CLI requires explicit acknowledgement, archive and digest', () => {
  assert.deepEqual(parseRealBootArgs(['--help']), { help: true });
  const basic = ['--deepseek-package-root', 'C:/installed', '--dsh-home', 'C:/data',
    '--profile', 'web', '--backup-archive', 'C:/backup.tar', '--backup-sha256', 'a'.repeat(64)];
  assert.equal(parseRealBootArgs(basic).invalid, true);
  assert.equal(parseRealBootArgs([...basic, '--ack-real-home-writes']).ack, true);
  assert.equal(parseRealBootArgs([...basic, '--ack-real-home-writes', '--ack-real-home-writes']).invalid, true);
  assert.equal(parseRealBootArgs([...basic.slice(0, 5), '../web', ...basic.slice(6), '--ack-real-home-writes']).invalid, true);
  const bad = spawnSync(process.execPath, ['scripts/deepseek-real-profile-boot.mjs',
    '--backup-archive', 'PRIVATE_BACKUP_PATH', '--json'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).reason, 'invalid_arguments');
  assert.equal(bad.stdout.includes('PRIVATE_BACKUP_PATH'), false);
});

test('backup digest and source readback fail before real host boot', async t => {
  const f = fixture(t); let boots = 0;
  const dependencies = { inspectPackages: () => installed(f.options),
    hostIdle: () => true,
    previewProfile: preflight,
    runHost: async () => { boots++; return { ok: true }; } };
  const missing = await runRealProfileBoot({ ...f.options,
    backupArchive: join(f.root, 'missing-backup.tar') }, dependencies);
  assert.equal(missing.reason, 'backup_unavailable');
  const wrongDigest = await runRealProfileBoot({ ...f.options, backupSha256: '0'.repeat(64) }, dependencies);
  assert.equal(wrongDigest.reason, 'backup_digest_mismatch');
  writeFileSync(join(f.home, 'sessions', 'fixture.zstd'), 'changed-after-backup\n');
  const stale = await runRealProfileBoot(f.options, dependencies);
  assert.equal(stale.reason, 'backup_source_mismatch');
  assert.equal(boots, 0);
  assert.equal(stale.hostBoot, 'not_started');
});

test('an archive inside the live home or a duplicate observer blocks host boot', async t => {
  const f = fixture(t); let boots = 0;
  const inside = join(f.home, 'backup.tar');
  copyFileSync(f.options.backupArchive, inside);
  const dependencies = { inspectPackages: () => installed(f.options),
    hostIdle: () => true,
    previewProfile: preflight, runHost: async () => { boots++; return { ok: true }; } };
  const unsafe = await runRealProfileBoot({ ...f.options, backupArchive: inside }, dependencies);
  assert.equal(unsafe.reason, 'backup_inside_real_home');
  const g = fixture(t);
  const duplicate = await runRealProfileBoot(g.options, { ...dependencies,
    inspectPackages: () => installed(g.options),
    previewProfile: async () => ({ status: 'attention', currentObserver: 'present_in_composed_config' }),
  });
  assert.equal(duplicate.reason, 'profile_preflight_unavailable');
  assert.equal(boots, 0);
});

test('a concurrently running installed host refuses the real-home probe before backup or boot', async t => {
  const f = fixture(t); let checkedBackup = 0, boots = 0;
  const report = await runRealProfileBoot(f.options, {
    inspectPackages: () => installed(f.options),
    hostIdle: () => false,
    backupCheck: async () => { checkedBackup++; return true; },
    runHost: async () => { boots++; return { ok: true }; },
  });
  assert.equal(report.reason, 'real_home_in_use');
  assert.equal(report.hostBoot, 'not_started');
  assert.equal(checkedBackup, 0);
  assert.equal(boots, 0);
});

test('a host appearing after archive verification still blocks startup', async t => {
  const f = fixture(t); let checks = 0, boots = 0;
  const report = await runRealProfileBoot(f.options, {
    inspectPackages: () => installed(f.options), previewProfile: preflight,
    hostIdle: () => ++checks === 1,
    runHost: async () => { boots++; return { ok: true }; },
  });
  assert.equal(report.reason, 'real_home_in_use');
  assert.equal(checks, 2);
  assert.equal(boots, 0);
});

test('real-home probe uses actual selected home but redirects fixture data and audits it', async t => {
  const f = fixture(t); let temp, hostError;
  const report = await runRealProfileBoot(f.options, {
    inspectPackages: () => installed(f.options), previewProfile: preflight,
    hostIdle: () => true,
    readEvidence: evidence,
    runHost: async ({ home, cwd, overlayPath, fixturePath, env }) => { try {
      assert.equal(env.DSH_HOME, home);
      assert.notEqual(cwd, home);
      temp = cwd;
      assert.match(readFileSync(overlayPath, 'utf8'), /reflexmesh-observer/);
      const patch = readFileSync(fixturePath, 'utf8');
      assert.match(patch, /reflexmesh-synthetic-fixture/);
      assert.match(patch, /session-persistence-jsonl/);
      assert.match(patch, /storage-json/);
      assert.match(patch, /persistDir/);
      assert.match(patch, /sessions/);
      writeFileSync(join(cwd, 'startup-receipt.json'), JSON.stringify(bootReceipt));
      writeFileSync(join(cwd, 'synthetic-receipt.json'), JSON.stringify(toolReceipt));
      return { ok: true, stdout: '' };
    } catch (error) { hostError = error; throw error; } },
  });
  assert.ifError(hostError);
  assert.equal(report.status, 'passed', JSON.stringify(report));
  assert.equal(report.assertions.length, 20);
  assert.ok(report.assertions.every(item => item.passed));
  assert.equal(report.backupVerified, true);
  assert.equal(report.otherNonDependencyFilesUnchanged, true);
  assert.equal(report.generatedRootChanged, false);
  assert.equal(report.temporaryFilesRemoved, true);
  assert.equal(existsSync(temp), false);
});

test('real-home mutation outside generated root cannot pass even with good tool evidence', async t => {
  const f = fixture(t);
  const report = await runRealProfileBoot(f.options, {
    inspectPackages: () => installed(f.options), previewProfile: preflight,
    hostIdle: () => true,
    readEvidence: evidence,
    runHost: async ({ cwd }) => {
      writeFileSync(join(f.home, 'settings.yaml'), 'changed-by-host\n');
      writeFileSync(join(cwd, 'startup-receipt.json'), JSON.stringify(bootReceipt));
      writeFileSync(join(cwd, 'synthetic-receipt.json'), JSON.stringify(toolReceipt));
      return { ok: true, stdout: '' };
    },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'real_home_other_files_changed');
  assert.equal(report.otherChangedCount, 1);
  assert.equal(report.assertions.find(item => item.name === 'otherNonDependencyFilesUnchanged').passed, false);
});
