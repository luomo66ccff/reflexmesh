#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
import { loaderInsert } from '../adapters/doctor.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { boundedFile, previewDeepSeekProfile, safeCleanup, safePath, safeProfile, within } from './deepseek-profile-preview.mjs';
import { readSelectedEvidence, selectedFixtureOverlay, selectedToolAssertions,
  selectedWebHostArgs, SELECTED_TOOL_CHECKS } from './deepseek-selected-profile-boot.mjs';
import { processFailureReason, runBounded } from './real-host-compat.mjs';

const PREFIX = 'reflexmesh-dsh-real-home-';
const EXTRA_CHECKS = ['backupVerified', 'otherNonDependencyFilesUnchanged', 'temporaryFilesRemoved'];
const FLAGS = new Map([['--deepseek-package-root', 'packageRoot'],
  ['--dsh-home', 'dshHome'], ['--profile', 'profile'],
  ['--backup-archive', 'backupArchive'], ['--backup-sha256', 'backupSha256']]);
const REQUIRED = [...FLAGS.values()];
const MAX_INVENTORY_FILES = 2000;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_LIST_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = 16 * 1024 * 1024;

export const REAL_BOOT_USAGE = `ReflexMesh real DeepSeek web-profile synthetic tool check (opt-in)
  node scripts/deepseek-real-profile-boot.mjs --deepseek-package-root ABS --dsh-home ABS --profile web --backup-archive ABS_TAR --backup-sha256 SHA256 --ack-real-home-writes [--json]
  node scripts/deepseek-real-profile-boot.mjs --help
Requires a private, current data archive before booting the actual selected
DSH_HOME. The installed host can rewrite generated config and selected plugins
can access credentials, conversations, ambient files and network. A temporary
CLI overlay runs only a fixed synthetic in-memory tool and abstain-only
ReflexMesh observer; test ledger, session persistence, JSON storage and pet
state are redirected to a temporary directory. Other plugin side effects are
audited, not prevented.
Do not run while another DeepSeek Harness process is using the same home.
No archive, credentials, host output or conversation content is printed.
`;

export function parseRealBootArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--json' || name === '--ack-real-home-writes') {
      const field = name === '--json' ? 'json' : 'ack';
      if (options[field]) return { invalid: true, json: argv.includes('--json') };
      options[field] = true;
      continue;
    }
    const field = FLAGS.get(name), value = argv[++i];
    if (!field || Object.hasOwn(options, field) || !value || value.startsWith('--'))
      return { invalid: true, json: argv.includes('--json') };
    options[field] = value;
  }
  if (REQUIRED.some(field => !options[field]) || options.ack !== true
    || !safeProfile(options.profile) || options.profile !== 'web'
    || !/^[a-f\d]{64}$/iu.test(options.backupSha256))
    return { invalid: true, json: argv.includes('--json') };
  return options;
}

function fixedReport() {
  return { schemaVersion: 1, kind: 'deepseek_real_profile_synthetic_tool',
    status: 'failed', reason: 'invalid_arguments', hostVersion: 'unknown',
    hostBoot: 'not_started', modelInference: 'not_confirmed',
    harnessToolCalls: 'not_confirmed', backupVerified: false,
    otherNonDependencyFilesUnchanged: null, generatedRootChanged: null,
    temporaryFilesRemoved: 'not_created',
    assertions: [...SELECTED_TOOL_CHECKS, ...EXTRA_CHECKS]
      .map(name => ({ name, passed: false })) };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}

async function verifyBackup(home, archive, expectedHash) {
  const source = await realpath(home);
  const target = await realpath(archive).catch(() => { throw new Error('backup_unavailable'); });
  if (target === source || within(source, target)) throw new Error('backup_inside_real_home');
  const info = await lstat(target);
  if (!info.isFile() || info.size < 1024 || info.size > 2 * 1024 * 1024 * 1024)
    throw new Error('backup_unavailable');
  if (await sha256File(target) !== expectedHash.toLowerCase())
    throw new Error('backup_digest_mismatch');
  const listed = spawnSync('tar', ['-tf', target],
    { windowsHide: true, timeout: 30_000, maxBuffer: MAX_ARCHIVE_LIST_BYTES });
  if (listed.status !== 0) throw new Error('backup_unavailable');
  const archiveEntries = new Set(listed.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean));
  if ([...archiveEntries].some(name => !name.startsWith('data/')
    || name.split('/').some(part => part === '..' || part === '.')))
    throw new Error('backup_unavailable');
  const sourceInventory = await mutableInventory(source);
  for (const [name, identity] of sourceInventory) {
    if (identity.startsWith('link:')) continue;
    const path = join(source, ...name.split('/'));
    const current = await lstat(path);
    if (!current.isFile() || current.size > MAX_BACKUP_FILE_BYTES
      || !archiveEntries.has(`data/${name}`)) throw new Error('backup_source_mismatch');
    const result = spawnSync('tar', ['-xOf', target, `data/${name}`],
      { windowsHide: true, timeout: 15_000, maxBuffer: MAX_BACKUP_FILE_BYTES + 4096 });
    if (result.status !== 0 || !result.stdout?.equals(await readFile(path)))
      throw new Error('backup_source_mismatch');
  }
  return sourceInventory;
}

async function mutableInventory(root) {
  const entries = new Map();
  let bytes = 0;
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules') continue;
      const path = join(dir, item.name);
      const info = await lstat(path);
      const name = relative(root, path).split(sep).join('/');
      if (info.isSymbolicLink()) {
        entries.set(name, `link:${info.dev}:${info.ino}:${info.mtimeMs}`);
        continue;
      }
      if (info.isDirectory()) { await visit(path); continue; }
      if (!info.isFile()) throw new Error('inventory_unavailable');
      bytes += info.size;
      if (entries.size >= MAX_INVENTORY_FILES || bytes > MAX_INVENTORY_BYTES)
        throw new Error('inventory_unavailable');
      entries.set(name, `file:${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}:${await sha256File(path)}`);
    }
  }
  await visit(root);
  return entries;
}

function inventoryDelta(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  const changed = [...names].filter(name => before.get(name) !== after.get(name));
  return { generatedRootChanged: changed.includes('profiles/web/cordis.yml'),
    otherNonDependencyFilesUnchanged: changed.every(name => name === 'profiles/web/cordis.yml'),
    otherChangedCount: changed.filter(name => name !== 'profiles/web/cordis.yml').length };
}

function defaultRunHost({ binPath, home, cwd, profile, overlayPath, fixturePath, env }) {
  return runBounded(process.execPath, selectedWebHostArgs({ binPath, profile, overlayPath, fixturePath }), {
    cwd, env, timeoutMs: 45_000,
    stdoutLimitBytes: 64 * 1024, stderrLimitBytes: 64 * 1024,
  });
}

export function installedHostIdle(binPath) {
  if (process.platform !== 'win32') throw new Error('host_idle_unverified');
  const quoted = binPath.replaceAll("'", "''");
  const command = `$ErrorActionPreference='Stop';$needle='${quoted}';`
    + `$found=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"`
    + ` | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) });`
    + `[Console]::Out.Write($found.Count)`;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 });
  if (result.status !== 0 || !/^\d+$/u.test(result.stdout?.trim() ?? ''))
    throw new Error('host_idle_unverified');
  return Number(result.stdout.trim()) === 0;
}

/** Start an actual selected home only after exact private archive readback. */
export async function runRealProfileBoot(options, {
  inspectPackages = inspectAgentPackages,
  previewProfile = previewDeepSeekProfile,
  backupCheck = verifyBackup,
  inventory = mutableInventory,
  runHost = defaultRunHost,
  readEvidence = readSelectedEvidence,
  hostIdle = installedHostIdle,
} = {}) {
  const report = fixedReport();
  let tempRoot = null, tempIdentity = null, home = null, before = null;
  let keepTemporary = false;
  try {
    if (!options || !safePath(options.packageRoot) || !safePath(options.dshHome)
      || !safePath(options.backupArchive) || !safeProfile(options.profile)
      || options.profile !== 'web' || options.ack !== true
      || !/^[a-f\d]{64}$/iu.test(options.backupSha256)) return report;
    const installed = inspectPackages(options.packageRoot);
    report.hostVersion = installed.hostVersion ?? 'unknown';
    if (!installed.ok) { report.reason = installed.reason; return report; }
    home = await realpath(options.dshHome);
    if (!(await lstat(home)).isDirectory()) throw new Error('real_home_unavailable');
    const binPath = join(installed.root, 'lib', 'bin.js');
    if (!hostIdle(binPath)) throw new Error('real_home_in_use');
    const backupSnapshot = await backupCheck(home, options.backupArchive, options.backupSha256);
    report.backupVerified = backupSnapshot === true || backupSnapshot instanceof Map;
    if (!report.backupVerified) throw new Error('backup_unverified');
    const preflight = await previewProfile({ ...options,
      db: join(tmpdir(), 'reflexmesh-real-home-preflight.sqlite'),
      tenant: 'isolated-fixture', scope: 'real-profile-preflight' });
    if (preflight?.status !== 'passed' || preflight.currentObserver !== 'absent'
      || preflight.overlay !== 'composed_in_isolation'
      || preflight.sourceConfigurationUnchanged !== true
      || preflight.temporaryProfileRemoved !== true)
      throw new Error('profile_preflight_unavailable');
    before = await inventory(home);
    if (backupSnapshot instanceof Map && (backupSnapshot.size !== before.size
      || [...before].some(([name, identity]) => backupSnapshot.get(name) !== identity)))
      throw new Error('backup_source_changed_since_check');
    if (!hostIdle(binPath)) throw new Error('real_home_in_use');
    tempRoot = await mkdtemp(join(tmpdir(), PREFIX));
    const tempInfo = await lstat(tempRoot);
    tempIdentity = { dev: tempInfo.dev, ino: tempInfo.ino };
    for (const name of ['sessions', 'storages', 'pet'])
      await mkdir(join(tempRoot, name), { recursive: true, mode: 0o700 });
    const dbPath = join(tempRoot, 'ledger', 'shadow.sqlite');
    const overlayPath = join(tempRoot, 'observer.patch.yml');
    const fixturePath = join(tempRoot, 'fixture.patch.yml');
    const telemetryPath = join(tempRoot, 'startup-receipt.json');
    const syntheticTelemetryPath = join(tempRoot, 'synthetic-receipt.json');
    const observer = loaderInsert({ dbPath, tenantId: 'isolated-fixture',
      scope: 'real-profile-boot', intentMode: 'explicit-summary' });
    await writeFile(overlayPath, observer.yamlInsert, { flag: 'wx', mode: 0o600 });
    const fixture = selectedFixtureOverlay({ telemetryPath, syntheticTelemetryPath,
      packageRoot: installed.root, homePath: home, cwdPath: tempRoot,
      profile: options.profile, observerOverlayPath: overlayPath,
      fixtureOverlayPath: fixturePath });
    const stateOverrides = [
      `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(join(tempRoot, 'sessions'))}\n`,
      `- id: storage-json\n  config:\n    root: ${JSON.stringify(join(tempRoot, 'storages'))}\n`,
      `- id: pet\n  config:\n    persistDir: ${JSON.stringify(join(tempRoot, 'pet'))}\n`,
    ].join('');
    await writeFile(fixturePath, fixture + stateOverrides, { flag: 'wx', mode: 0o600 });
    const env = Object.fromEntries(Object.entries({ DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1', PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: tempRoot, TMP: tempRoot,
    }).filter(([, value]) => typeof value === 'string'));
    report.hostBoot = 'attempted';
    const child = await runHost({ binPath,
      home, cwd: tempRoot, profile: options.profile, overlayPath, fixturePath, env });
    if (!child?.ok) {
      report.reason = processFailureReason(child);
      keepTemporary = child?.kind === 'timeout';
      return report;
    }
    let received, synthetic;
    try {
      received = JSON.parse((await boundedFile(telemetryPath, 4096, true)).bytes.toString('utf8'));
      synthetic = JSON.parse((await boundedFile(syntheticTelemetryPath, 4096, true)).bytes.toString('utf8'));
    } catch { throw new Error('startup_receipt_unavailable'); }
    report.assertions = selectedToolAssertions(received, synthetic, readEvidence(dbPath, synthetic));
    report.hostBoot = received.startupCommitted === true ? 'startup_committed' : 'attempted';
    if (report.assertions.every(item => item.passed)) {
      report.modelInference = 'synthetic_adapter_only';
      report.harnessToolCalls = 'one_fixture_read';
      report.status = 'passed';
      report.reason = 'real_profile_synthetic_tool_passed';
    } else report.reason = 'real_profile_assertion_failed';
  } catch (error) {
    report.status = 'failed';
    report.reason = ['backup_inside_real_home', 'backup_unavailable',
      'backup_digest_mismatch', 'backup_source_mismatch', 'backup_unverified',
      'backup_source_changed_since_check',
      'real_home_in_use', 'host_idle_unverified',
      'profile_preflight_unavailable', 'real_home_unavailable',
      'inventory_unavailable', 'startup_receipt_unavailable']
      .includes(error?.message) ? error.message : 'real_profile_probe_unavailable';
  } finally {
    let otherUnchanged = null;
    if (before && home) {
      try {
        const delta = inventoryDelta(before, await inventory(home));
        report.generatedRootChanged = delta.generatedRootChanged;
        report.otherChangedCount = delta.otherChangedCount;
        otherUnchanged = delta.otherNonDependencyFilesUnchanged;
        const root = await boundedFile(join(home, 'profiles', 'web', 'cordis.yml'), 1024 * 1024, true);
        if (root.bytes.includes(Buffer.from('reflexmesh-observer', 'utf8'))) {
          report.status = 'failed'; report.reason = 'generated_root_contains_observer';
        }
      } catch { otherUnchanged = false; }
      report.otherNonDependencyFilesUnchanged = otherUnchanged;
      if (!otherUnchanged) { report.status = 'failed'; report.reason = 'real_home_other_files_changed'; }
    }
    if (tempRoot) {
      report.temporaryFilesRemoved = keepTemporary ? false
        : await safeCleanup(tempRoot, null, tempIdentity, PREFIX);
      if (!report.temporaryFilesRemoved) {
        report.status = 'failed'; report.reason = 'temporary_cleanup_unverified';
        report.cleanupPath = tempRoot;
      }
    }
    report.assertions = [
      ...report.assertions.filter(item => SELECTED_TOOL_CHECKS.includes(item.name)),
      { name: 'backupVerified', passed: report.backupVerified === true },
      { name: 'otherNonDependencyFilesUnchanged', passed: report.otherNonDependencyFilesUnchanged === true },
      { name: 'temporaryFilesRemoved', passed: report.temporaryFilesRemoved === true },
    ];
    if (report.status === 'passed' && !report.assertions.every(item => item.passed)) {
      report.status = 'failed'; report.reason = 'real_profile_assertion_failed';
    }
  }
  return report;
}

export async function realProfileBootMain(argv = process.argv.slice(2), output = process.stdout) {
  const options = parseRealBootArgs(argv);
  if (options.help) { output.write(REAL_BOOT_USAGE); return 0; }
  const report = options.invalid ? fixedReport() : await runRealProfileBoot(options);
  output.write(options.json ? `${JSON.stringify(report)}\n`
    : `ReflexMesh real-home Web tool check: ${report.status}; ${report.reason}.\n`
      + `Checks: ${report.assertions.filter(item => item.passed).length}/${report.assertions.length}; backup verified: ${report.backupVerified}.\n`
      + `Other non-dependency files unchanged: ${report.otherNonDependencyFilesUnchanged ?? 'unverified'}; generated root changed: ${report.generatedRootChanged ?? 'unverified'}; temporary files removed: ${report.temporaryFilesRemoved}.\n`
      + 'Synthetic model and fixed in-memory read only; selected plugins did execute.\n'
      + (report.cleanupPath ? `Inspect temporary directory privately: ${JSON.stringify(report.cleanupPath)}\n` : ''));
  return report.status === 'passed' ? 0 : 1;
}

if (isDirectRun(import.meta.url)) process.exitCode = await realProfileBootMain();
