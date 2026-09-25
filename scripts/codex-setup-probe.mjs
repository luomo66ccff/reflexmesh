#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createCodexSetup, isSafeCodexPath } from '../adapters/codex-setup.mjs';
import { diagnoseCodexDoctor } from '../adapters/codex-doctor.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { assertSqliteWalRuntime } from '../adapters/sqlite-runtime.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

const USAGE = `Usage: npm run compat:codex-setup -- [--codex-executable ABS] [--json]
Account-free isolated probe of generated Codex MCP settings and the production ReflexMesh STDIO server.
With --codex-executable, native Codex CLI adds the generated row to a disposable CODEX_HOME, then doctor reads it back as matching; it does not change your Codex profile or run an Agent/model.
The MCP check uses a new temporary ledger, synthetic calls and abstain only. No user settings, profile or account are changed.
`;
const SUMMARY = 'SYNTHETIC: Read the public README without editing files';
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = callId => ({ schemaVersion: 1, harness: 'codex', sessionId: 'isolated-setup-probe', agentId: 'root',
  callId, toolName: 'Read', arguments: { path: 'README.md' } });

export function parseCodexProbeOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const options = { json: false, codexExecutable: null };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--json' && !options.json) options.json = true;
    else if (name === '--codex-executable' && options.codexExecutable === null) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('invalid_probe_options');
      options.codexExecutable = value;
    } else throw new Error('invalid_probe_options');
  }
  return options;
}

function cleanChildEnv(setup) {
  return { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '',
    TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '', NODE_NO_WARNINGS: '1', ...setup.env };
}

function runMcp(setup, messages) {
  const result = spawnSync(setup.command, setup.args, {
    input: messages.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8',
    env: cleanChildEnv(setup), timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('mcp_process_failed');
  try { return result.stdout.trim().split('\n').map(JSON.parse); }
  catch { throw new Error('mcp_protocol_failed'); }
}

function toolValue(response, id) {
  assert.equal(response?.id, id);
  assert.equal(response?.result?.isError, undefined);
  const item = response.result.content;
  assert.equal(item?.length, 1);
  assert.equal(item[0]?.type, 'text');
  return JSON.parse(item[0].text);
}

export async function verifyNativeCodex(executable, setup, directory, spawnNative = spawnSync) {
  if (!isSafeCodexPath(executable) || !isAbsolute(executable) || !lstatSync(executable).isFile())
    throw new Error('invalid_codex_executable');
  const codexHome = join(directory, 'codex-home');
  mkdirSync(codexHome, { mode: 0o700 });
  const userHome = join(directory, 'user-home');
  const appData = join(userHome, 'AppData', 'Roaming');
  const localAppData = join(userHome, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true, mode: 0o700 });
  mkdirSync(localAppData, { recursive: true, mode: 0o700 });
  const allowed = ['PATH', 'SystemRoot', 'WINDIR'];
  const env = { ...Object.fromEntries(allowed.filter(key => typeof process.env[key] === 'string')
    .map(key => [key, process.env[key]])), TEMP: directory, TMP: directory,
    USERPROFILE: userHome, HOME: userHome, APPDATA: appData, LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: join(userHome, '.config'), XDG_DATA_HOME: join(userHome, '.local', 'share'),
    CODEX_HOME: codexHome };
  const runCli = args => spawnNative(executable, args, { env, encoding: 'utf8', timeout: 12000,
    maxBuffer: 256 * 1024, windowsHide: true });
  const doctorArgs = ['--node-executable', setup.command, '--codex-executable', executable,
    '--db', setup.env.REFLEXMESH_DB, '--tenant', setup.env.REFLEXMESH_TENANT,
    '--scope', setup.env.REFLEXMESH_SCOPE];
  const inspect = () => diagnoseCodexDoctor(doctorArgs, {
    runRegistrationList: () => runCli(['mcp', 'list', '--json']),
  });
  const before = await inspect();
  assert.equal(before.report.status, 'prerequisites_ready');
  assert.equal(before.report.registration.status, 'not_registered');
  assert.ok(before.report.setup.registration);
  const add = runCli(before.report.setup.registration.args);
  if (add.error || add.status !== 0) throw new Error('codex_isolated_add_failed');
  const after = await inspect();
  assert.equal(after.report.status, 'prerequisites_ready');
  assert.equal(after.report.registration.status, 'matching_config');
  assert.equal(after.report.setup.registration, null);
  const get = runCli(['mcp', 'get', 'reflexmesh-shadow', '--json']);
  if (get.error || get.status !== 0) throw new Error('codex_isolated_get_failed');
  let parsed;
  try { parsed = JSON.parse(get.stdout); } catch { throw new Error('codex_config_parse_failed'); }
  assert.equal(parsed.name, 'reflexmesh-shadow');
  assert.equal(parsed.transport?.type, 'stdio');
  assert.equal(parsed.transport.command, setup.command);
  assert.deepEqual(parsed.transport.args, setup.args);
  assert.deepEqual(parsed.transport.env, setup.env);
  assert.equal(existsSync(setup.env.REFLEXMESH_DB), false);
  return { config: 'parsed_by_installed_cli', registration: 'isolated_add_list_matching' };
}

function verifyLedger(dbPath, first, second) {
  const kernel = new SqliteKernel(dbPath, { readOnly: true, busyTimeoutMs: 250 });
  try {
    const missing = kernel.evidenceSnapshot(first.decisionId);
    const selected = kernel.evidenceSnapshot(second.decisionId);
    assert.notEqual(first.decisionId, second.decisionId);
    assert.equal(missing.taskEvidence.recordedStatus, 'missing');
    assert.equal(selected.taskEvidence.recordedStatus, 'ready');
    assert.equal(selected.taskEvidence.coverage, 'summary-only');
    assert.equal(missing.hostOutcome.status, 'missing');
    assert.equal(selected.hostOutcome.status, 'unknown');
    assert.deepEqual(selected.hostOutcome.byProvenance, [{ provenance: 'model-reported', status: 'unknown', count: 1 }]);
    assert.equal(missing.labelCount, 0);
    assert.equal(selected.labelCount, 0);
    assert.equal(JSON.stringify({ missing, selected }).includes(SUMMARY), false);
    return { decisions: 2, outcomeStatus: selected.hostOutcome.status,
      outcomeProvenance: selected.hostOutcome.byProvenance[0].provenance, labels: 0 };
  } finally { kernel.close(); }
}

function cleanupOwnedTemp(directory, root) {
  const resolved = realpathSync(directory);
  if (dirname(resolved) !== root || !basename(resolved).startsWith('reflexmesh-codex-setup-probe-'))
    throw new Error('unsafe_probe_cleanup');
  rmSync(resolved, { recursive: true, force: false });
}

export async function runCodexSetupProbe(options = {}) {
  assertSqliteWalRuntime();
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, 'reflexmesh-codex-setup-probe-'));
  try {
    const setup = createCodexSetup({ nodePath: process.execPath, dbPath: join(directory, 'ledger.sqlite'),
      tenantId: 'isolated-probe', scope: 'isolated-probe' });
    const native = options.codexExecutable === null || options.codexExecutable === undefined
      ? { config: 'not_requested', registration: 'not_requested' }
      : await verifyNativeCodex(options.codexExecutable, setup, directory);
    const firstCall = call('missing-task'), secondCall = call('reported-task');
    const responses = runMcp(setup, [rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'reflexmesh-setup-probe', version: '1' } }), initialized,
    rpc(2, 'tools/list'),
    rpc(3, 'tools/call', { name: 'reflexmesh_assess', arguments: { call: firstCall } }),
    rpc(4, 'tools/call', { name: 'reflexmesh_assess', arguments: { call: secondCall, userIntent: SUMMARY } }),
    rpc(5, 'tools/call', { name: 'reflexmesh_observe_outcome', arguments: { call: secondCall,
      status: 'unknown', evidence: { synthetic: true } } })]);
    assert.equal(responses.length, 5);
    assert.equal(responses[0]?.result?.protocolVersion, '2025-06-18');
    assert.equal(responses[1]?.result?.tools?.length, 4);
    const first = toolValue(responses[2], 3), second = toolValue(responses[3], 4);
    toolValue(responses[4], 5);
    assert.equal(first.verdict.effect, 'escalate');
    assert.equal(first.taskEvidence.status, 'missing');
    assert.equal(second.verdict.effect, 'escalate');
    assert.equal(second.taskEvidence.source, 'model-reported');
    assert.equal(second.taskEvidence.status, 'ready');
    assert.equal(first.control, 'abstain');
    assert.equal(second.control, 'abstain');
    assert.equal(first.mode, 'shadow');
    assert.equal(second.mode, 'shadow');
    const reopened = runMcp(setup, [rpc(11, 'initialize', { protocolVersion: '2025-06-18' }), initialized,
      rpc(12, 'tools/call', { name: 'reflexmesh_assess', arguments: { call: secondCall, userIntent: SUMMARY } }),
      rpc(13, 'tools/call', { name: 'reflexmesh_assess', arguments: {
        call: secondCall, userIntent: 'SYNTHETIC: Different task after restart' } }),
      rpc(14, 'tools/call', { name: 'reflexmesh_inspect_pack', arguments: {} })]);
    assert.equal(reopened.length, 4);
    assert.equal(reopened[0]?.result?.protocolVersion, '2025-06-18');
    const repeated = toolValue(reopened[1], 12);
    assert.equal(repeated.decisionId, second.decisionId);
    assert.equal(repeated.replayed, true);
    assert.deepEqual(repeated.verdict, second.verdict);
    assert.deepEqual(repeated.taskEvidence, second.taskEvidence);
    assert.equal(repeated.control, 'abstain');
    assert.equal(reopened[2]?.id, 13);
    assert.equal(reopened[2]?.result?.isError, true);
    assert.deepEqual(JSON.parse(reopened[2].result.content[0].text),
      { error: 'assessment_unavailable_or_contract_conflict', executionAllowed: false });
    assert.equal(toolValue(reopened[3], 14).control, 'abstain');
    const persisted = verifyLedger(setup.env.REFLEXMESH_DB, first, second);
    return { schemaVersion: 1, kind: 'codex_setup_probe', status: 'passed',
      nativeCodexConfig: native.config, nativeCodexRegistration: native.registration,
      productionMcp: { status: 'passed', processCount: 2,
        listedTools: 4, ...persisted, restartReplay: true, restartConflictRejected: true },
      actualCodexAgent: 'not_tested', modelRequest: 'none' };
  } finally { cleanupOwnedTemp(directory, root); }
}

export async function codexSetupProbeMain(argv = process.argv.slice(2), output = process.stdout, errors = process.stderr) {
  let options;
  try { options = parseCodexProbeOptions(argv); }
  catch { errors.write('ReflexMesh Codex setup probe: invalid options; use --help.\n'); return 1; }
  if (options.help) { output.write(USAGE); return 0; }
  try {
    const report = await runCodexSetupProbe(options);
    output.write(options.json ? `${JSON.stringify(report)}\n` :
      `ReflexMesh Codex setup probe: passed. Native Codex config: ${report.nativeCodexConfig}; `
      + `isolated registration: ${report.nativeCodexRegistration}; `
      + `production MCP: ${report.productionMcp.processCount} isolated processes, `
      + `${report.productionMcp.decisions} decisions, one model-reported unknown outcome, zero labels; `
      + 'restart reused the same decision and rejected changed task evidence. '
      + 'No Agent/model/tool execution was tested.\n');
    return 0;
  } catch {
    errors.write('ReflexMesh Codex setup probe failed; no user settings or ledger were changed.\n');
    return 1;
  }
}

if (isDirectRun(import.meta.url)) process.exitCode = await codexSetupProbeMain();
