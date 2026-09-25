import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { parsePreviewArgs, previewDeepSeekProfile } from '../scripts/deepseek-profile-preview.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-profile-preview-test-'));
  t.after(() => {
    const target = realpathSync(root), rel = relative(realpathSync(tmpdir()), target);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
      && basename(target).startsWith('reflexmesh-profile-preview-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  const home = join(root, '真实 profile'), profile = join(home, 'profiles', 'web');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'fixture-profile' }));
  writeFileSync(join(profile, 'cordis.patch.yml'), '- insert: []\n');
  writeFileSync(join(profile, 'cordis.yml'), '# ORIGINAL_GENERATED_ROOT\n');
  const options = { packageRoot: join(root, 'fake-installed-dsh'), dshHome: home,
    profile: 'web', db: join(root, 'future.sqlite'), tenant: 'local', scope: 'fixture' };
  return { root, home, profile, options };
}

test('preview arguments require explicit paths and reject duplicates or unsafe profile names', () => {
  assert.deepEqual(parsePreviewArgs(['--help']), { help: true });
  assert.equal(parsePreviewArgs(['--profile', 'web', '--out-overlay', 'new.yml']).invalid, true);
  assert.equal(parsePreviewArgs(['--profile', 'web', '--profile', 'again']).invalid, true);
  assert.equal(parsePreviewArgs(['--profile', '..']).invalid, true);
  assert.equal(parsePreviewArgs(['--profile', 'web/other']).invalid, true);
  assert.equal(parsePreviewArgs(['--unknown', 'PRIVATE']).invalid, true);
  const help = spawnSync(process.execPath, ['scripts/deepseek-profile-preview.mjs', '--help'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'PRIVATE_KEY' } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /isolated/);
  const invalid = spawnSync(process.execPath, ['scripts/deepseek-profile-preview.mjs', '--json'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'PRIVATE_KEY' } });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).reason, 'invalid_arguments');
  assert.ok(!invalid.stdout.includes('PRIVATE_KEY'));
});

test('isolated preview composes only a temporary overlay and preserves source config bytes', async t => {
  const f = fixture(t), original = readFileSync(join(f.profile, 'cordis.yml'));
  let temporaryHome, calls = 0;
  const report = await previewDeepSeekProfile(f.options, {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    linkModules: async (_source, target) => { mkdirSync(target); },
    runDump: ({ home, overlayPath }) => {
      temporaryHome = home; calls++;
      assert.notEqual(home, f.home);
      writeFileSync(join(home, 'profiles', 'web', 'cordis.yml'), '# GENERATED_IN_TEMP_ONLY\n');
      if (overlayPath) assert.match(readFileSync(overlayPath, 'utf8'), /reflexmesh-observer/);
      return { status: 0, stdout: overlayPath ? '- id: reflexmesh-observer\n' : '- id: existing-tool\n' };
    },
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.currentObserver, 'absent');
  assert.equal(report.overlay, 'composed_in_isolation');
  assert.equal(report.sourceConfigurationUnchanged, true);
  assert.equal(report.temporaryProfileRemoved, true);
  assert.equal(report.liveHost, 'not_started');
  assert.equal(calls, 2);
  assert.deepEqual(readFileSync(join(f.profile, 'cordis.yml')), original);
  assert.equal(existsSync(temporaryHome), false);
});

test('a verified preview may publish a new overlay outside the profile home', async t => {
  const f = fixture(t), outOverlay = join(f.root, 'new observer overlay.yml');
  const report = await previewDeepSeekProfile({ ...f.options, outOverlay }, {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    linkModules: async (_source, target) => { mkdirSync(target); },
    runDump: ({ overlayPath }) => ({ status: 0,
      stdout: overlayPath ? '- id: reflexmesh-observer\n' : '- id: existing-tool\n' }),
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.overlayFile?.status, 'created');
  assert.equal(report.overlayFile?.path, outOverlay);
  assert.match(report.overlayFile?.sha256, /^[a-f0-9]{64}$/);
  assert.match(readFileSync(outOverlay, 'utf8'), /reflexmesh-observer/);
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), '- insert: []\n');
});

test('existing or profile-home destinations are refused before a dump', async t => {
  const f = fixture(t), existing = join(f.root, 'existing.yml');
  writeFileSync(existing, 'KEEP_THIS_FILE');
  let dumps = 0;
  const deps = {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    runDump: () => { dumps++; throw new Error('must not run'); },
  };
  const prior = await previewDeepSeekProfile({ ...f.options, outOverlay: existing }, deps);
  assert.equal(prior.status, 'failed');
  assert.equal(prior.reason, 'overlay_destination_exists');
  assert.equal(readFileSync(existing, 'utf8'), 'KEEP_THIS_FILE');
  const inside = join(f.home, 'observer.yml');
  const nested = await previewDeepSeekProfile({ ...f.options, outOverlay: inside }, deps);
  assert.equal(nested.status, 'failed');
  assert.equal(nested.reason, 'overlay_destination_inside_profile_home');
  assert.equal(existsSync(inside), false);
  const relativeTarget = await previewDeepSeekProfile({ ...f.options, outOverlay: 'relative.yml' }, deps);
  assert.equal(relativeTarget.reason, 'invalid_overlay_destination');
  const missingParent = await previewDeepSeekProfile({ ...f.options,
    outOverlay: join(f.root, 'missing-parent', 'observer.yml') }, deps);
  assert.equal(missingParent.reason, 'overlay_destination_unavailable');
  assert.equal(dumps, 0);
});

test('a profile that already contains the observer is not overlaid again', async t => {
  const f = fixture(t);
  let calls = 0;
  const report = await previewDeepSeekProfile(f.options, {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    linkModules: async (_source, target) => { mkdirSync(target); },
    runDump: () => { calls++; return { status: 0, stdout: '- id: reflexmesh-observer\n' }; },
  });
  assert.equal(report.status, 'attention');
  assert.equal(report.currentObserver, 'present_in_composed_config');
  assert.equal(report.overlay, 'not_attempted');
  assert.equal(calls, 1);
});

test('dump failure cannot leak private output and temporary profile is removed', async t => {
  const f = fixture(t);
  let temporaryHome;
  const report = await previewDeepSeekProfile(f.options, {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    linkModules: async (_source, target) => { mkdirSync(target); },
    runDump: ({ home }) => { temporaryHome = home;
      return { status: 1, stdout: 'PRIVATE_PROFILE_CONFIG', stderr: 'PRIVATE_ERROR' }; },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'composed_config_unavailable');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'));
  assert.equal(report.temporaryProfileRemoved, true);
  assert.equal(existsSync(temporaryHome), false);
});

test('a concurrent change to the source configuration is reported, never rolled back', async t => {
  const f = fixture(t), outOverlay = join(f.root, 'must-not-publish.yml');
  const report = await previewDeepSeekProfile({ ...f.options, outOverlay }, {
    inspectPackages: () => ({ ok: true, root: f.options.packageRoot, hostVersion: '0.1.2-rc.1' }),
    linkModules: async (_source, target) => { mkdirSync(target); },
    runDump: ({ overlayPath }) => {
      if (!overlayPath) writeFileSync(join(f.profile, 'cordis.yml'), '# CHANGED_DURING_PREVIEW\n');
      return { status: 0, stdout: overlayPath ? '- id: reflexmesh-observer\n' : '- id: existing-tool\n' };
    },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'source_configuration_changed');
  assert.equal(report.sourceConfigurationUnchanged, false);
  assert.equal(report.temporaryProfileRemoved, true);
  assert.equal(existsSync(outOverlay), false);
  assert.equal(readFileSync(join(f.profile, 'cordis.yml'), 'utf8'), '# CHANGED_DURING_PREVIEW\n');
});
