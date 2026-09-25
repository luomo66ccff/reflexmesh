#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCodexSetup } from '../adapters/codex-setup.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { assertSqliteWalRuntime } from '../adapters/sqlite-runtime.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

const USAGE = `Usage: npm run compat:codex-setup -- [--codex-executable ABS] [--json]
Account-free isolated probe of generated Codex MCP settings and the production ReflexMesh STDIO server.
With --codex-executable, native Codex CLI parses an override for the generated fields; it may read its existing local config, but does not change it or run an Agent/model.
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

function verifyNativeCodex(executable, setup, name) {
  if (!isAbsolute(executable) || !lstatSync(executable).isFile()) throw new Error('invalid_codex_executable');
  const entries = { command: setup.command, args: setup.args };
  const overrides = Object.entries(entries).map(([key, value]) => `mcp_servers.${name}.${key}=${JSON.stringify(value)}`);
  for (const [key, value] of Object.entries(setup.env))
    overrides.push(`mcp_servers.${name}.env.${key}=${JSON.stringify(value)}`);
  const argv = ['mcp', 'get', name, '--json', ...overrides.flatMap(value => ['-c', value])];
  const result = spawnSync(executable, argv, { encoding: 'utf8', timeout: 12000,
    maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('codex_config_parse_failed');
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('codex_config_parse_failed'); }
  assert.equal(parsed.name, name);
  assert.equal(parsed.transport?.type, 'stdio');
  assert.equal(parsed.transport.command, setup.command);
  assert.deepEqual(parsed.transport.args, setup.args);
  assert.deepEqual(parsed.transport.env, setup.env);
  return 'parsed_by_installed_cli';
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

export function runCodexSetupProbe(options = {}) {
  assertSqliteWalRuntime();
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, 'reflexmesh-codex-setup-probe-'));
  try {
    const name = `reflexmesh_probe_${randomBytes(6).toString('hex')}`;
    const setup = createCodexSetup({ nodePath: process.execPath, dbPath: join(directory, 'ledger.sqlite'),
      tenantId: 'isolated-probe', scope: 'isolated-probe', serverName: name });
    const codexConfig = options.codexExecutable === null || options.codexExecutable === undefined
      ? 'not_requested' : verifyNativeCodex(options.codexExecutable, setup, name);
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
      rpc(12, 'tools/call', { name: 'reflexmesh_inspect_pack', arguments: {} })]);
    assert.equal(reopened.length, 2);
    assert.equal(reopened[0]?.result?.protocolVersion, '2025-06-18');
    assert.equal(toolValue(reopened[1], 12).control, 'abstain');
    const persisted = verifyLedger(setup.env.REFLEXMESH_DB, first, second);
    return { schemaVersion: 1, kind: 'codex_setup_probe', status: 'passed',
      nativeCodexConfig: codexConfig, productionMcp: { status: 'passed', processCount: 2,
        listedTools: 4, ...persisted }, actualCodexAgent: 'not_tested', modelRequest: 'none' };
  } finally { cleanupOwnedTemp(directory, root); }
}

export function codexSetupProbeMain(argv = process.argv.slice(2), output = process.stdout, errors = process.stderr) {
  let options;
  try { options = parseCodexProbeOptions(argv); }
  catch { errors.write('ReflexMesh Codex setup probe: invalid options; use --help.\n'); return 1; }
  if (options.help) { output.write(USAGE); return 0; }
  try {
    const report = runCodexSetupProbe(options);
    output.write(options.json ? `${JSON.stringify(report)}\n` :
      `ReflexMesh Codex setup probe: passed. Native Codex config: ${report.nativeCodexConfig}; `
      + `production MCP: ${report.productionMcp.processCount} isolated processes, `
      + `${report.productionMcp.decisions} decisions, one model-reported unknown outcome, zero labels. `
      + 'No Agent/model/tool execution was tested.\n');
    return 0;
  } catch {
    errors.write('ReflexMesh Codex setup probe failed; no user settings or ledger were changed.\n');
    return 1;
  }
}

if (isDirectRun(import.meta.url)) process.exitCode = codexSetupProbeMain();
