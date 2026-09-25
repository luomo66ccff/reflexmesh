#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
import { loaderInsert } from '../adapters/doctor.mjs';
import { validateDeepSeekLoaderConfig } from '../adapters/deepseek-loader-config.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

const PREFIX = 'reflexmesh-dsh-profile-preview-';
const MAX_PATCH_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DUMP_BYTES = 1024 * 1024;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const OBSERVER_ROW = /^\s*-\s+id:\s*['"]?reflexmesh-observer['"]?\s*$/mu;
const OPTIONS = new Map([
  ['--deepseek-package-root', 'packageRoot'], ['--dsh-home', 'dshHome'],
  ['--profile', 'profile'], ['--db', 'db'], ['--tenant', 'tenant'], ['--scope', 'scope'],
]);

export const PREVIEW_USAGE = `ReflexMesh DeepSeek profile composition preview (isolated; no host boot)
  node scripts/deepseek-profile-preview.mjs --deepseek-package-root ABS --dsh-home ABS --profile NAME --db ABS --tenant ID --scope ID [--json]
  node scripts/deepseek-profile-preview.mjs --help
Copies bounded profile configuration to a temporary home and runs the installed
host's boot-free config dump there. It does not prove the plugin loads or run a model.
`;

export function parsePreviewArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--json') {
      if (parsed.json) return { invalid: true, json: true };
      parsed.json = true;
      continue;
    }
    const field = OPTIONS.get(name), value = argv[++i];
    if (!field || Object.hasOwn(parsed, field) || !value || value.startsWith('--'))
      return { invalid: true, json: argv.includes('--json') };
    parsed[field] = value;
  }
  if ([...OPTIONS.values()].some(field => !parsed[field]) || !safeProfile(parsed.profile))
    return { invalid: true, json: argv.includes('--json') };
  return parsed;
}

const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && isAbsolute(value) && !UNSAFE.test(value) && !value.startsWith('\\\\');
const safeProfile = value => typeof value === 'string' && value.length <= 64
  && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) && value !== '.' && value !== '..';
const within = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
async function boundedFile(path, limit, required = false) {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    throw new Error('profile_file_unavailable');
  }
  if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error('profile_file_unavailable');
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used < 1 || used > limit) throw new Error('profile_file_unavailable');
    const opened = await file.stat();
    if (!opened.isFile() || opened.size !== used) throw new Error('profile_file_unavailable');
    return { bytes: bytes.subarray(0, used), mtimeMs: opened.mtimeMs,
      dev: opened.dev, ino: opened.ino };
  } finally { await file.close(); }
}

function dumpConfig({ binPath, home, profile, overlayPath }) {
  const args = [binPath, '--profile', profile,
    ...(overlayPath ? ['--patch', overlayPath] : []), '--dump-config'];
  const env = { DSH_HOME: home, PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}) };
  return spawnSync(process.execPath, args, { cwd: home, env, encoding: 'utf8',
    windowsHide: true, shell: false, timeout: 20_000, maxBuffer: MAX_DUMP_BYTES });
}

async function safeCleanup(root, modulesLink, identity) {
  if (!root) return true;
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.dev !== identity.dev || rootInfo.ino !== identity.ino)
      return false;
    const parent = await realpath(tmpdir());
    const target = await realpath(root);
    const rel = relative(parent, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)
      || !basename(target).startsWith(PREFIX)) return false;
    if (modulesLink) {
      let link;
      try { link = await lstat(modulesLink); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (link?.isSymbolicLink()) await unlink(modulesLink);
      else if (link) {
        const linked = await realpath(modulesLink);
        if (!within(target, linked)) return false;
      }
    }
    await rm(target, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

/** Compose a real profile's bounded config in a disposable home; never boot the host. */
export async function previewDeepSeekProfile(options, {
  inspectPackages = inspectAgentPackages,
  linkModules = (source, target) => symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir'),
  runDump = dumpConfig,
} = {}) {
  const report = { schemaVersion: 1, kind: 'deepseek_profile_composition_preview',
    status: 'failed', reason: 'invalid_arguments', hostVersion: 'unknown',
    currentObserver: 'unverified', overlay: 'not_attempted',
    sourceConfigurationUnchanged: null, temporaryProfileRemoved: 'not_created',
    liveHost: 'not_started', modelCalls: 0 };
  let tempRoot = null, tempModules = null, tempIdentity = null, sourceFiles = null;
  try {
    if (!options || !safePath(options.packageRoot) || !safePath(options.dshHome)
      || !safeProfile(options.profile)) return report;
    const config = validateDeepSeekLoaderConfig({ dbPath: options.db,
      tenantId: options.tenant, scope: options.scope });
    const installed = inspectPackages(options.packageRoot);
    report.hostVersion = installed.hostVersion ?? 'unknown';
    if (!installed.ok) { report.reason = installed.reason; return report; }
    const home = await realpath(options.dshHome);
    const profileDir = await realpath(join(home, 'profiles', options.profile));
    if (!within(home, profileDir)) throw new Error('profile_path_outside_home');
    const modules = await realpath(join(profileDir, 'node_modules'));
    if (!(await stat(modules)).isDirectory()) throw new Error('profile_modules_unavailable');
    const specs = [
      { name: 'package.json', path: join(profileDir, 'package.json'), limit: MAX_MANIFEST_BYTES, required: true },
      { name: 'cordis.patch.yml', path: join(profileDir, 'cordis.patch.yml'), limit: MAX_PATCH_BYTES },
      { name: 'cordis.yml', path: join(profileDir, 'cordis.yml'), limit: MAX_MANIFEST_BYTES },
      { name: 'home.patch.yml', path: join(home, 'cordis.patch.yml'), limit: MAX_PATCH_BYTES },
    ];
    sourceFiles = await Promise.all(specs.map(async spec => ({ ...spec,
      original: await boundedFile(spec.path, spec.limit, spec.required) })));
    const insertion = loaderInsert(config), overlay = insertion.yamlInsert;
    tempRoot = await mkdtemp(join(tmpdir(), PREFIX));
    const tempInfo = await lstat(tempRoot);
    tempIdentity = { dev: tempInfo.dev, ino: tempInfo.ino };
    const tempProfile = join(tempRoot, 'profiles', options.profile);
    await mkdir(tempProfile, { recursive: true });
    for (const file of sourceFiles) {
      if (!file.original || file.name === 'cordis.yml') continue;
      const target = file.name === 'home.patch.yml' ? join(tempRoot, 'cordis.patch.yml')
        : join(tempProfile, file.name);
      await writeFile(target, file.original.bytes, { flag: 'wx', mode: 0o600 });
    }
    tempModules = join(tempProfile, 'node_modules');
    await linkModules(modules, tempModules);
    const binPath = join(installed.root, 'lib', 'bin.js');
    const first = runDump({ binPath, home: tempRoot, profile: options.profile, overlayPath: null });
    if (first?.status !== 0 || typeof first.stdout !== 'string'
      || Buffer.byteLength(first.stdout, 'utf8') > MAX_DUMP_BYTES)
      throw new Error('composed_config_unavailable');
    if (OBSERVER_ROW.test(first.stdout) || first.stdout.includes(insertion.pluginUrl)) {
      report.status = 'attention'; report.reason = 'observer_already_present';
      report.currentObserver = 'present_in_composed_config';
    } else {
      report.currentObserver = 'absent';
      const overlayPath = join(tempRoot, 'reflexmesh-preview.patch.yml');
      await writeFile(overlayPath, overlay, { flag: 'wx', mode: 0o600 });
      const second = runDump({ binPath, home: tempRoot, profile: options.profile, overlayPath });
      if (second?.status !== 0 || typeof second.stdout !== 'string'
        || Buffer.byteLength(second.stdout, 'utf8') > MAX_DUMP_BYTES)
        throw new Error('composed_config_unavailable');
      if (!OBSERVER_ROW.test(second.stdout)) throw new Error('overlay_not_composed');
      report.status = 'passed'; report.reason = 'overlay_composed';
      report.overlay = 'composed_in_isolation';
    }
  } catch (error) {
    report.status = 'failed';
    report.reason = ['profile_path_outside_home', 'profile_modules_unavailable',
      'profile_file_unavailable', 'composed_config_unavailable', 'overlay_not_composed']
      .includes(error?.message) ? error.message : 'preview_unavailable';
  } finally {
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
      report.temporaryProfileRemoved = await safeCleanup(tempRoot, tempModules, tempIdentity);
      if (!report.temporaryProfileRemoved) {
        report.status = 'failed'; report.reason = 'temporary_profile_cleanup_unverified';
        report.cleanupPath = tempRoot;
      }
    }
  }
  return report;
}

export async function profilePreviewMain(argv = process.argv.slice(2), output = process.stdout) {
  const options = parsePreviewArgs(argv);
  if (options.help) { output.write(PREVIEW_USAGE); return 0; }
  const report = options.invalid
    ? { schemaVersion: 1, kind: 'deepseek_profile_composition_preview', status: 'failed',
      reason: 'invalid_arguments', liveHost: 'not_started', modelCalls: 0 }
    : await previewDeepSeekProfile(options);
  output.write(options.json ? `${JSON.stringify(report)}\n`
    : `ReflexMesh DeepSeek profile preview: ${report.status}; ${report.reason}.\n`
      + `Current observer: ${report.currentObserver ?? 'unverified'}; overlay: ${report.overlay ?? 'not_attempted'}.\n`
      + `Source config unchanged: ${report.sourceConfigurationUnchanged ?? 'unverified'}; temporary profile removed: ${report.temporaryProfileRemoved ?? 'not_created'}.\n`
      + 'Host CLI composition only; no Agent/plugin runtime, model or tool was started.\n'
      + 'Composition is not live-plugin acceptance.\n'
      + (report.cleanupPath ? `Inspect temporary directory: ${JSON.stringify(report.cleanupPath)}\n` : ''));
  return report.status === 'passed' ? 0 : 1;
}

if (isDirectRun(import.meta.url)) process.exitCode = await profilePreviewMain();
