#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
import { loaderInsert } from '../adapters/doctor.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { boundedFile, previewDeepSeekProfile, safeCleanup, safePath, safeProfile, within } from './deepseek-profile-preview.mjs';
import { installedHostIdle } from './deepseek-real-profile-boot.mjs';
import { readSelectedEvidence, selectedToolAssertions } from './deepseek-selected-profile-boot.mjs';
import { WEB_UI_TASK } from './fixtures/deepseek-web-ui-fixture.mjs';

const PREFIX = 'reflexmesh-dsh-web-ui-';
const FLAGS = new Map([['--deepseek-package-root', 'packageRoot'],
  ['--dsh-home', 'dshHome'], ['--profile', 'profile'], ['--out-dir', 'outDir']]);
const REQUIRED = [...FLAGS.values()];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`;

export const WEB_FIRST_USAGE = `ReflexMesh selected DeepSeek Web first-evidence check (opt-in)
  node scripts/deepseek-web-first-evidence.mjs --deepseek-package-root ABS --dsh-home ABS --profile web --out-dir ABS_NEW --ack-selected-plugins
  node scripts/deepseek-web-first-evidence.mjs --help
Copies selected Web configuration to a disposable home, runs a fixed synthetic
model and one in-memory read tool, then waits for YOU to send the printed task
through the actual browser UI. It does not copy credential-store or sessions,
request a paid model, install an observer in the source profile or execute a
host tool on your behalf. Selected third-party plugins still execute with
ambient filesystem/network access; selected patch files may contain secrets.
The authenticated browser URL is kept in a private temporary file, not printed.
After the browser shows the fixture marker, press Enter here to close the host
and verify an inspectable synthetic ledger in a new output directory.
Do not run alongside another Harness process using the selected profile.
`;

export function parseWebFirstArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--ack-selected-plugins') {
      if (options.ack) return { invalid: true };
      options.ack = true;
      continue;
    }
    const field = FLAGS.get(name), value = argv[++i];
    if (!field || Object.hasOwn(options, field) || !value || value.startsWith('--'))
      return { invalid: true };
    options[field] = value;
  }
  if (REQUIRED.some(field => !options[field]) || options.ack !== true
    || !safeProfile(options.profile) || options.profile !== 'web'
    || !safePath(options.packageRoot) || !safePath(options.dshHome)
    || !safePath(options.outDir)) return { invalid: true };
  return options;
}

function fixedReport() {
  return { schemaVersion: 1, kind: 'deepseek_web_first_evidence', status: 'failed',
    reason: 'invalid_arguments', hostVersion: 'unknown', hostBoot: 'not_started',
    webUserMessageSeen: false, sourceConfigurationUnchanged: null,
    retainedEvidenceVerified: false, temporaryProfileRemoved: 'not_created',
    assertions: [] };
}

function browserOverlay(config) {
  const synthetic = { id: 'reflexmesh-synthetic-fixture',
    name: new URL('./fixtures/deepseek-agent-fixture.mjs', import.meta.url).href,
    config: { packageRoot: config.packageRoot, telemetryPath: config.syntheticTelemetryPath,
      homePath: config.homePath, cwdPath: config.homePath,
      overlayPath: config.observerOverlayPath, profileName: 'web' } };
  const ui = { id: 'reflexmesh-web-ui-fixture',
    name: new URL('./fixtures/deepseek-web-ui-fixture.mjs', import.meta.url).href,
    config };
  return `- insert:\n  - ${JSON.stringify(synthetic)}\n  - ${JSON.stringify(ui)}\n`
    + `- id: agent-default-model\n  config:\n    provider: reflexmesh-synthetic\n    model: fixture-v1\n`;
}

function launchHost({ binPath, home, profile, overlayPath, fixturePath, env }) {
  const child = spawn(process.execPath, [binPath, '--profile', profile,
    '--patch', overlayPath, '--patch', fixturePath,
    '--host', '127.0.0.1', '--port', '0', '--no-open'],
  { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 128 * 1024 && child.exitCode === null) child.kill();
  });
  child.on('error', () => {});
  return child;
}

async function waitReady(child, statusPath, urlPath, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('host_exited_before_web_ready');
    try {
      const status = JSON.parse((await boundedFile(statusPath, 4096, true)).bytes.toString('utf8'));
      if (status.phase === 'startup_failed') throw new Error('web_startup_failed');
      if (status.startupCommitted === true && status.phase === 'ready_for_browser') {
        const url = await boundedFile(urlPath, 4096, true);
        if (!url.bytes.toString('utf8').startsWith('http://127.0.0.1:'))
          throw new Error('web_url_unavailable');
        return status;
      }
    } catch (error) {
      if (['web_startup_failed', 'web_url_unavailable'].includes(error?.message)) throw error;
    }
    await sleep(100);
  }
  throw new Error('web_ready_timeout');
}

function waitForEnter(input, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.pause();
      error ? reject(error) : resolve();
    };
    const onData = () => done();
    const onEnd = () => done(new Error('browser_confirmation_unavailable'));
    const timer = setTimeout(() => done(new Error('browser_confirmation_timeout')), timeoutMs);
    input.once('data', onData);
    input.once('end', onEnd);
    input.resume();
  });
}

async function waitExit(child, timeoutMs = 30_000) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return new Promise(resolve => {
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve({ timeout: true });
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function verifyRetained(dbPath, outDir) {
  const kernel = new SqliteKernel(dbPath, { readOnly: true });
  let key;
  try {
    const page = kernel.listEvidence({ limit: 2 });
    if (page.items.length !== 1 || page.nextCursor !== null) return false;
    key = page.items[0].key;
  } finally { kernel.close(); }
  await mkdir(outDir, { mode: 0o700 });
  const retained = join(outDir, 'shadow.sqlite');
  await copyFile(dbPath, retained, constants.COPYFILE_EXCL);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  if (digest(await readFile(dbPath)) !== digest(await readFile(retained))) return false;
  const script = fileURLToPath(new URL('../adapters/evidence-cli.mjs', import.meta.url));
  const checked = spawnSync(process.execPath, [script, 'inspect', '--db', retained, '--key', key],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
  if (checked.status !== 0) return false;
  const guide = `# ReflexMesh synthetic Web evidence\n\nThis is fixture data, not a real model or user task.\n\n\`\`\`powershell\nnode ${quotePowerShell(script)} inspect --db ${quotePowerShell(retained)} --key ${quotePowerShell(key)}\n\`\`\`\n`;
  await writeFile(join(outDir, 'START-HERE.md'), guide, { flag: 'wx', mode: 0o600 });
  return true;
}

export async function runWebFirstEvidence(options, {
  inspectPackages = inspectAgentPackages,
  previewProfile = previewDeepSeekProfile,
  hostIdle = installedHostIdle,
  linkModules = (source, target) => symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir'),
  launch = launchHost,
  awaitBrowser = () => waitForEnter(process.stdin),
  readEvidence = readSelectedEvidence,
  retain = verifyRetained,
  output = process.stdout,
} = {}) {
  const report = fixedReport();
  let tempRoot = null, tempModules = null, tempIdentity = null, sourceFiles = null;
  let child = null, urlPath = null, keepTemporary = false;
  try {
    if (!options || parseWebFirstArgs([
      '--deepseek-package-root', options.packageRoot ?? '', '--dsh-home', options.dshHome ?? '',
      '--profile', options.profile ?? '', '--out-dir', options.outDir ?? '',
      ...(options.ack ? ['--ack-selected-plugins'] : []),
    ]).invalid) return report;
    const installed = inspectPackages(options.packageRoot);
    report.hostVersion = installed.hostVersion ?? 'unknown';
    if (!installed.ok) { report.reason = installed.reason; return report; }
    const binPath = join(installed.root, 'lib', 'bin.js');
    if (!hostIdle(binPath)) throw new Error('installed_host_in_use');
    const sourceHome = await realpath(options.dshHome);
    const outParent = await realpath(dirname(options.outDir));
    const outTarget = join(outParent, basename(options.outDir));
    if (within(sourceHome, outTarget) || within(outTarget, sourceHome))
      throw new Error('output_overlaps_profile_home');
    try { await lstat(outTarget); throw new Error('output_already_exists'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const preflight = await previewProfile({ ...options,
      db: join(tmpdir(), 'reflexmesh-web-ui-preflight.sqlite'),
      tenant: 'isolated-fixture', scope: 'web-ui-first-evidence' });
    if (preflight?.status !== 'passed' || preflight.currentObserver !== 'absent'
      || preflight.overlay !== 'composed_in_isolation'
      || preflight.sourceConfigurationUnchanged !== true
      || preflight.temporaryProfileRemoved !== true)
      throw new Error('profile_preflight_unavailable');
    const profileDir = await realpath(join(sourceHome, 'profiles', options.profile));
    if (!within(sourceHome, profileDir)) throw new Error('profile_path_outside_home');
    const modules = await realpath(join(profileDir, 'node_modules'));
    if (!(await stat(modules)).isDirectory()) throw new Error('profile_modules_unavailable');
    const specs = [
      { name: 'package.json', path: join(profileDir, 'package.json'), limit: 1024 * 1024, required: true },
      { name: 'cordis.patch.yml', path: join(profileDir, 'cordis.patch.yml'), limit: 128 * 1024 },
      { name: 'cordis.yml', path: join(profileDir, 'cordis.yml'), limit: 1024 * 1024 },
      { name: 'home.patch.yml', path: join(sourceHome, 'cordis.patch.yml'), limit: 128 * 1024 },
    ];
    sourceFiles = await Promise.all(specs.map(async spec => ({ ...spec,
      original: await boundedFile(spec.path, spec.limit, spec.required) })));
    tempRoot = await mkdtemp(join(tmpdir(), PREFIX));
    const info = await lstat(tempRoot);
    tempIdentity = { dev: info.dev, ino: info.ino };
    const tempProfile = join(tempRoot, 'profiles', options.profile);
    await mkdir(tempProfile, { recursive: true, mode: 0o700 });
    for (const file of sourceFiles) {
      if (!file.original || file.name === 'cordis.yml') continue;
      await writeFile(file.name === 'home.patch.yml' ? join(tempRoot, 'cordis.patch.yml')
        : join(tempProfile, file.name), file.original.bytes, { flag: 'wx', mode: 0o600 });
    }
    tempModules = join(tempProfile, 'node_modules');
    await linkModules(modules, tempModules);
    const dbPath = join(tempRoot, 'ledger', 'shadow.sqlite');
    const overlayPath = join(tempRoot, 'observer.patch.yml');
    const fixturePath = join(tempRoot, 'fixture.patch.yml');
    const statusPath = join(tempRoot, 'web-ui-status.json');
    urlPath = join(tempRoot, 'browser-url.txt');
    const syntheticTelemetryPath = join(tempRoot, 'synthetic-receipt.json');
    const observer = loaderInsert({ dbPath, tenantId: 'isolated-fixture',
      scope: 'web-ui-first-evidence', intentMode: 'explicit-summary' });
    await writeFile(overlayPath, observer.yamlInsert, { flag: 'wx', mode: 0o600 });
    await writeFile(fixturePath, browserOverlay({ statusPath, urlPath,
      syntheticTelemetryPath, packageRoot: installed.root, homePath: tempRoot,
      profile: options.profile, observerOverlayPath: overlayPath,
      fixtureOverlayPath: fixturePath }), { flag: 'wx', mode: 0o600 });
    const env = Object.fromEntries(Object.entries({ DSH_HOME: tempRoot,
      DSH_TELEMETRY_DISABLED: '1', PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      DSH_PERMISSION_MODE: 'read-only',
      // The installed host's auto picker uses its browser-capable UI in SSH mode.
      SSH_TTY: 'reflexmesh-isolated-web-ui-probe',
      TEMP: tempRoot, TMP: tempRoot,
    }).filter(([, value]) => typeof value === 'string'));
    if (!hostIdle(binPath)) throw new Error('installed_host_in_use');
    report.hostBoot = 'attempted';
    child = launch({ binPath, home: tempRoot,
      profile: options.profile, overlayPath, fixturePath, env });
    await waitReady(child, statusPath, urlPath);
    report.hostBoot = 'ready_for_browser';
    output.write(`Isolated Web UI ready. Private URL file: ${urlPath}\n`
      + `Send this exact two-line task in the browser:\n${WEB_UI_TASK}\n`
      + 'After the browser displays REFLEXMESH_SYNTHETIC_AGENT_OK, press Enter here.\n');
    await awaitBrowser();
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('host_exited_before_browser_confirmation');
    child.send({ type: 'reflexmesh-web-ui-finish' });
    const ended = await waitExit(child);
    if (ended.timeout) { keepTemporary = true; throw new Error('host_shutdown_timeout'); }
    if (ended.code !== 0 || ended.signal !== null) throw new Error('host_exit_unverified');
    const received = JSON.parse((await boundedFile(statusPath, 4096, true)).bytes.toString('utf8'));
    const synthetic = JSON.parse((await boundedFile(syntheticTelemetryPath, 4096, true)).bytes.toString('utf8'));
    report.webUserMessageSeen = received.webUserMessageSeen === true;
    report.assertions = selectedToolAssertions(received, synthetic,
      readEvidence(dbPath, synthetic));
    report.assertions.push({ name: 'webUserMessageSeen', passed: report.webUserMessageSeen });
    if (!report.assertions.every(item => item.passed)) throw new Error('web_evidence_unverified');
    report.retainedEvidenceVerified = await retain(dbPath, outTarget);
    if (!report.retainedEvidenceVerified) throw new Error('retained_evidence_unverified');
    report.status = 'passed'; report.reason = 'web_first_evidence_passed';
  } catch (error) {
    report.status = 'failed';
    report.reason = ['output_overlaps_profile_home', 'output_already_exists',
      'installed_host_in_use', 'host_idle_unverified',
      'profile_preflight_unavailable', 'profile_path_outside_home',
      'profile_modules_unavailable', 'host_exited_before_web_ready',
      'web_startup_failed', 'web_url_unavailable', 'web_ready_timeout',
      'browser_confirmation_unavailable', 'browser_confirmation_timeout',
      'host_exited_before_browser_confirmation', 'host_shutdown_timeout',
      'host_exit_unverified', 'web_evidence_unverified',
      'retained_evidence_unverified'].includes(error?.message)
      ? error.message : 'web_first_evidence_unavailable';
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'reflexmesh-web-ui-finish' });
      const ended = await waitExit(child, 5_000);
      if (ended.timeout) { child.kill(); await waitExit(child, 5_000); keepTemporary = true; }
    }
    if (keepTemporary && urlPath) {
      try { await unlink(urlPath); } catch {}
    }
    if (sourceFiles) {
      try {
        const after = await Promise.all(sourceFiles.map(file => boundedFile(file.path, file.limit, file.required)));
        report.sourceConfigurationUnchanged = sourceFiles.every((file, index) =>
          file.original === null ? after[index] === null : after[index] !== null
            && file.original.bytes.equals(after[index].bytes)
            && file.original.mtimeMs === after[index].mtimeMs
            && file.original.dev === after[index].dev && file.original.ino === after[index].ino);
      } catch { report.sourceConfigurationUnchanged = false; }
      if (!report.sourceConfigurationUnchanged) {
        report.status = 'failed'; report.reason = 'source_configuration_changed';
      }
    }
    if (tempRoot) {
      report.temporaryProfileRemoved = keepTemporary ? false
        : await safeCleanup(tempRoot, tempModules, tempIdentity, PREFIX);
      if (!report.temporaryProfileRemoved) {
        report.status = 'failed';
        if (!keepTemporary) report.reason = 'temporary_profile_cleanup_unverified';
        report.cleanupPath = tempRoot;
      }
    }
    report.assertions.push({ name: 'sourceConfigurationUnchanged',
      passed: report.sourceConfigurationUnchanged === true },
    { name: 'retainedEvidenceVerified', passed: report.retainedEvidenceVerified === true },
    { name: 'temporaryProfileRemoved', passed: report.temporaryProfileRemoved === true });
    if (report.status === 'passed' && !report.assertions.every(item => item.passed)) {
      report.status = 'failed'; report.reason = 'web_first_evidence_unverified';
    }
  }
  return report;
}

export async function webFirstMain(argv = process.argv.slice(2), output = process.stdout) {
  const options = parseWebFirstArgs(argv);
  if (options.help) { output.write(WEB_FIRST_USAGE); return 0; }
  const report = options.invalid ? fixedReport()
    : await runWebFirstEvidence(options, { output });
  output.write(`ReflexMesh Web first evidence: ${report.status}; ${report.reason}.\n`
    + `Checks: ${report.assertions.filter(item => item.passed).length}/${report.assertions.length}; `
    + `source config unchanged: ${report.sourceConfigurationUnchanged ?? 'unverified'}; `
    + `temporary home removed: ${report.temporaryProfileRemoved}.\n`
    + (report.cleanupPath ? `Inspect temporary directory privately: ${report.cleanupPath}\n` : ''));
  return report.status === 'passed' ? 0 : 1;
}

if (isDirectRun(import.meta.url)) process.exitCode = await webFirstMain();
