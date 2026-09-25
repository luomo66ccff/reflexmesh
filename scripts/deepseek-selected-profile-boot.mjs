#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
import { loaderInsert } from '../adapters/doctor.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { intentDigest } from '../adapters/task-evidence.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { processFailureReason, runBounded } from './real-host-compat.mjs';
import { boundedFile, previewDeepSeekProfile, safeCleanup, safePath, safeProfile, within } from './deepseek-profile-preview.mjs';

const PREFIX = 'reflexmesh-dsh-selected-boot-';
const PREFLIGHT_REASONS = new Set(['observer_already_present',
  'source_configuration_changed', 'temporary_profile_cleanup_unverified',
  'composed_config_unavailable', 'overlay_not_composed']);
export const SELECTED_TOOL_CHECKS = Object.freeze(['startupCommitted', 'observerEntryActivated',
  'overlayArgPresent', 'profileTreeBound', 'webServerReady',
  'observerDrainedAtExit', 'kernelClosedAtExit', 'naturalBeforeExit',
  'selectedWebBundleLoaded', 'nativeAgentLoopExercised',
  'syntheticToolAdvertised', 'nativeToolResultCorrelated',
  'shadowBindingOnly', 'zeroLabels', 'exactFixtureScope', 'oneLedgerDecision',
  'hostIdentityBound']);
const REQUIRED = ['packageRoot', 'dshHome', 'profile'];
const FLAGS = new Map([['--deepseek-package-root', 'packageRoot'],
  ['--dsh-home', 'dshHome'], ['--profile', 'profile']]);

export const SELECTED_BOOT_USAGE = `ReflexMesh selected DeepSeek profile-stack boot check (opt-in)
  node scripts/deepseek-selected-profile-boot.mjs --deepseek-package-root ABS --dsh-home ABS --profile web [--json]
  node scripts/deepseek-selected-profile-boot.mjs --help
Copies bounded configuration into a disposable home and boots its installed
bundle stack with a temporary abstain-only ReflexMesh overlay and one-shot
synthetic Agent/tool fixture. Web binds to 127.0.0.1 on an OS-selected port without
opening a browser. It starts selected third-party plugin code. Credential-store
files are not copied, but selected patch files may contain secrets and the
plugins may have ambient access. The probe calls one fixed in-memory read tool
through a synthetic model adapter; no paid model is requested. It does not
intentionally write the source profile and verifies checked source files.
`;

export function parseSelectedBootArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--json') {
      if (options.json) return { invalid: true, json: true };
      options.json = true;
      continue;
    }
    const field = FLAGS.get(name), value = argv[++i];
    if (!field || Object.hasOwn(options, field) || !value || value.startsWith('--'))
      return { invalid: true, json: argv.includes('--json') };
    options[field] = value;
  }
  if (REQUIRED.some(field => !options[field]) || !safeProfile(options.profile)
    || options.profile !== 'web')
    return { invalid: true, json: argv.includes('--json') };
  return options;
}

function fixedReport() {
  return { schemaVersion: 2, kind: 'deepseek_selected_profile_synthetic_tool',
    status: 'failed', reason: 'invalid_arguments', hostVersion: 'unknown',
    hostBoot: 'not_started', modelInference: 'not_confirmed',
    harnessToolCalls: 'not_confirmed', sourceConfigurationUnchanged: null,
    temporaryProfileRemoved: 'not_created',
    assertions: SELECTED_TOOL_CHECKS.map(name => ({ name, passed: false })) };
}

export function selectedFixtureOverlay(config) {
  const synthetic = { id: 'reflexmesh-synthetic-fixture',
    name: new URL('./fixtures/deepseek-agent-fixture.mjs', import.meta.url).href,
    config: { packageRoot: config.packageRoot, telemetryPath: config.syntheticTelemetryPath,
      homePath: config.homePath, cwdPath: config.cwdPath ?? config.homePath,
      overlayPath: config.observerOverlayPath, profileName: config.profile } };
  const row = { id: 'reflexmesh-selected-profile-boot-fixture',
    name: new URL('./fixtures/deepseek-selected-profile-boot-fixture.mjs', import.meta.url).href,
    config };
  return `- insert:\n  - ${JSON.stringify(synthetic)}\n  - ${JSON.stringify(row)}\n`;
}

export function readSelectedEvidence(dbPath, synthetic) {
  const kernel = new SqliteKernel(dbPath, { readOnly: true });
  try {
    const page = kernel.listEvidence({ limit: 2 });
    const item = page.items.length === 1 && page.nextCursor === null ? page.items[0] : null;
    const detail = item && kernel.inspect(item.key);
    const scope = { harness: 'deepseek-harness', sessionId: synthetic.toolSessionId,
      agentId: synthetic.toolAgentId };
    return {
      oneLedgerDecision: item !== null,
      shadowBindingOnly: item?.run?.mode === 'shadow'
        && item?.binding?.providerId === 'abstain' && item?.binding?.modelId === 'not-configured',
      nativeToolResultCorrelated: synthetic.toolResultSeen === true
        && item?.hostOutcome?.status === 'succeeded' && item?.hostOutcome?.count === 1
        && item?.hostOutcome?.byProvenance?.[0]?.provenance === 'harness-reported',
      zeroLabels: item?.labelCount === 0,
      hostIdentityBound: typeof synthetic.modelSessionId === 'string'
        && synthetic.modelSessionId === synthetic.toolSessionId
        && synthetic.toolSessionId === synthetic.toolAgentId
        && item?.taskEvidence?.source === 'host-declared'
        && item?.taskEvidence?.recordedStatus === 'ready'
        && detail?.evidence?.taskEvidence?.scopeDigest === intentDigest(scope),
    };
  } finally { kernel.close(); }
}

export function selectedToolAssertions(received, synthetic, evidence) {
  const checks = { ...received,
    selectedWebBundleLoaded: synthetic.isolatedProfileLoaded === true
      && synthetic.loaderProfileBound === true,
    nativeAgentLoopExercised: received.agentTurnCompleted === true
      && received.finalFixtureMarker === true
      && synthetic.requests === 2 && synthetic.bodyCalls === 1,
    syntheticToolAdvertised: synthetic.toolAdvertised === true,
    exactFixtureScope: synthetic.toolHadAgent === true
      && synthetic.toolArgsExact === true && synthetic.sessionConsistent === true
      && Number.isSafeInteger(synthetic.toolCount) && synthetic.toolCount >= 1
      && Number.isSafeInteger(synthetic.backgroundRequests)
      && synthetic.backgroundRequests <= 2,
    ...evidence };
  return SELECTED_TOOL_CHECKS.map(name => ({ name, passed: checks[name] === true }));
}

export function selectedWebHostArgs({ binPath, profile, overlayPath, fixturePath }) {
  return [binPath, '--profile', profile,
    '--patch', overlayPath, '--patch', fixturePath,
    '--host', '127.0.0.1', '--port', '0', '--no-open'];
}

function defaultRunHost({ binPath, home, profile, overlayPath, fixturePath, env }) {
  return runBounded(process.execPath, selectedWebHostArgs({ binPath, profile, overlayPath, fixturePath }), {
    cwd: home, env, timeoutMs: 35_000,
    stdoutLimitBytes: 64 * 1024, stderrLimitBytes: 64 * 1024,
  });
}

/** Run installed plugin code only in a disposable copy of the selected stack. */
export async function runSelectedProfileBoot(options, {
  inspectPackages = inspectAgentPackages,
  previewProfile = previewDeepSeekProfile,
  linkModules = (source, target) => symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir'),
  runHost = defaultRunHost,
  readEvidence = readSelectedEvidence,
} = {}) {
  const report = fixedReport();
  let tempRoot = null, tempModules = null, tempIdentity = null, sourceFiles = null;
  let keepTemporaryHome = false;
  try {
    if (!options || !safePath(options.packageRoot) || !safePath(options.dshHome)
      || !safeProfile(options.profile) || options.profile !== 'web') return report;
    const installed = inspectPackages(options.packageRoot);
    report.hostVersion = installed.hostVersion ?? 'unknown';
    if (!installed.ok) { report.reason = installed.reason; return report; }
    const preflight = await previewProfile({ ...options,
      db: join(tmpdir(), 'reflexmesh-selected-boot-preflight.sqlite'),
      tenant: 'isolated-fixture', scope: 'selected-profile-boot' });
    if (preflight?.status !== 'passed' || preflight.currentObserver !== 'absent'
      || preflight.overlay !== 'composed_in_isolation'
      || preflight.sourceConfigurationUnchanged !== true
      || preflight.temporaryProfileRemoved !== true) {
      report.reason = PREFLIGHT_REASONS.has(preflight?.reason)
        ? preflight.reason : 'profile_preflight_unavailable';
      report.sourceConfigurationUnchanged = preflight?.sourceConfigurationUnchanged ?? null;
      report.temporaryProfileRemoved = preflight?.temporaryProfileRemoved ?? 'not_created';
      if (preflight?.cleanupPath) report.cleanupPath = preflight.cleanupPath;
      return report;
    }
    const sourceHome = await realpath(options.dshHome);
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
    const rootInfo = await lstat(tempRoot);
    tempIdentity = { dev: rootInfo.dev, ino: rootInfo.ino };
    const tempProfile = join(tempRoot, 'profiles', options.profile);
    await mkdir(tempProfile, { recursive: true, mode: 0o700 });
    for (const file of sourceFiles) {
      if (!file.original || file.name === 'cordis.yml') continue;
      const target = file.name === 'home.patch.yml' ? join(tempRoot, 'cordis.patch.yml')
        : join(tempProfile, file.name);
      await writeFile(target, file.original.bytes, { flag: 'wx', mode: 0o600 });
    }
    tempModules = join(tempProfile, 'node_modules');
    await linkModules(modules, tempModules);
    const dbPath = join(tempRoot, 'ledger', 'shadow.sqlite');
    const overlayPath = join(tempRoot, 'observer.patch.yml');
    const fixturePath = join(tempRoot, 'fixture.patch.yml');
    const telemetryPath = join(tempRoot, 'startup-receipt.json');
    const syntheticTelemetryPath = join(tempRoot, 'synthetic-receipt.json');
    const observer = loaderInsert({ dbPath, tenantId: 'isolated-fixture',
      scope: 'selected-profile-boot', intentMode: 'explicit-summary' });
    await writeFile(overlayPath, observer.yamlInsert, { flag: 'wx', mode: 0o600 });
    await writeFile(fixturePath, selectedFixtureOverlay({ telemetryPath, syntheticTelemetryPath,
      packageRoot: installed.root, homePath: tempRoot,
      profile: options.profile, observerOverlayPath: overlayPath,
      fixtureOverlayPath: fixturePath }), { flag: 'wx', mode: 0o600 });
    const env = Object.fromEntries(Object.entries({ DSH_HOME: tempRoot,
      DSH_TELEMETRY_DISABLED: '1', PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: tempRoot, TMP: tempRoot,
    }).filter(([, value]) => typeof value === 'string'));
    report.hostBoot = 'attempted';
    const child = await runHost({ binPath: join(installed.root, 'lib', 'bin.js'),
      home: tempRoot, profile: options.profile, overlayPath, fixturePath,
      telemetryPath, env });
    if (!child?.ok) {
      report.reason = processFailureReason(child);
      try {
        const diagnostic = await boundedFile(telemetryPath, 4096, false);
        const state = diagnostic && JSON.parse(diagnostic.bytes.toString('utf8'));
        const phase = state?.phase;
        report.fixturePhase = ['waiting_ready', 'importing_api', 'creating_agent', 'running_agent',
          'reading_outcome', 'complete'].includes(phase) ? phase : 'not_started';
        report.fixtureChecks = { agentTurnCompleted: state?.agentTurnCompleted === true,
          finalFixtureMarker: state?.finalFixtureMarker === true,
          webServerReady: state?.webServerReady === true };
      } catch { report.fixturePhase = 'unavailable'; }
      try {
        const diagnostic = await boundedFile(syntheticTelemetryPath, 4096, false);
        const state = diagnostic && JSON.parse(diagnostic.bytes.toString('utf8'));
        report.syntheticChecks = { requests: state?.requests ?? null,
          bodyCalls: state?.bodyCalls ?? null, toolResultSeen: state?.toolResultSeen === true,
          sessionConsistent: state?.sessionConsistent === true };
      } catch { report.syntheticChecks = null; }
      keepTemporaryHome = child?.kind === 'timeout';
      return report;
    }
    let received, synthetic;
    try {
      const receipt = await boundedFile(telemetryPath, 4096, true);
      received = JSON.parse(receipt.bytes.toString('utf8'));
      const toolReceipt = await boundedFile(syntheticTelemetryPath, 4096, true);
      synthetic = JSON.parse(toolReceipt.bytes.toString('utf8'));
    } catch { throw new Error('startup_receipt_unavailable'); }
    const evidence = readEvidence(dbPath, synthetic);
    report.assertions = selectedToolAssertions(received, synthetic, evidence);
    report.status = report.assertions.every(item => item.passed) ? 'passed' : 'failed';
    report.reason = report.status === 'passed' ? 'selected_profile_synthetic_tool_passed'
      : 'selected_profile_assertion_failed';
    report.hostBoot = received?.startupCommitted === true ? 'startup_committed' : 'attempted';
    if (report.status === 'passed') {
      report.modelInference = 'synthetic_adapter_only';
      report.harnessToolCalls = 'one_fixture_read';
    }
  } catch (error) {
    report.status = 'failed';
    report.reason = ['profile_path_outside_home', 'profile_modules_unavailable',
      'profile_file_unavailable', 'startup_receipt_unavailable']
      .includes(error?.message) ? error.message : 'boot_probe_unavailable';
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
      report.temporaryProfileRemoved = keepTemporaryHome ? false
        : await safeCleanup(tempRoot, tempModules, tempIdentity, PREFIX);
      if (!report.temporaryProfileRemoved) {
        report.status = 'failed';
        if (report.reason !== 'source_configuration_changed')
          report.reason = 'temporary_profile_cleanup_unverified';
        report.cleanupPath = tempRoot;
      }
    }
  }
  return report;
}

export async function selectedProfileBootMain(argv = process.argv.slice(2), output = process.stdout) {
  const options = parseSelectedBootArgs(argv);
  if (options.help) { output.write(SELECTED_BOOT_USAGE); return 0; }
  const report = options.invalid ? fixedReport() : await runSelectedProfileBoot(options);
  output.write(options.json ? `${JSON.stringify(report)}\n`
    : `ReflexMesh selected-profile Web tool check: ${report.status}; ${report.reason}.\n`
      + `Installed host: ${report.hostVersion}; startup: ${report.hostBoot}.\n`
      + `Checks: ${report.assertions.filter(item => item.passed).length}/${report.assertions.length}; source config unchanged: ${report.sourceConfigurationUnchanged ?? 'unverified'}; temporary home removed: ${report.temporaryProfileRemoved}.\n`
      + `Model: ${report.modelInference}; tool: ${report.harnessToolCalls}. Selected plugin code did run.\n`
      + (report.cleanupPath ? `Inspect temporary directory privately: ${JSON.stringify(report.cleanupPath)}\n` : ''));
  return report.status === 'passed' ? 0 : 1;
}

if (isDirectRun(import.meta.url)) process.exitCode = await selectedProfileBootMain();
