#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCodexSetup, isSafeCodexPath } from '../adapters/codex-setup.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { assertSqliteWalRuntime } from '../adapters/sqlite-runtime.mjs';
import { runBounded } from './real-host-compat.mjs';

const PREFIX = 'reflexmesh-codex-agent-probe-';
const SERVER = 'reflexmesh_agent_probe';
const SUMMARY = 'Read the one local synthetic fixture as a read-only check.';
const EVIDENCE_CLI = fileURLToPath(new URL('../adapters/evidence-cli.mjs', import.meta.url));
const MAX_JSONL = 1024 * 1024;
const MAX_EVIDENCE = 128 * 1024;
const USAGE = `Usage: node scripts/codex-agent-probe.mjs [--execute --codex-executable ABS] [--out-dir NEW_ABS] [--timeout-ms 15000..180000] [--json]
Opt-in real Codex Agent/model check. Requires a logged-in Codex CLI when executed.
Creates and removes one private synthetic temporary fixture and ledger by default. --out-dir retains a new private directory for evidence CLI inspection. Never edits Codex settings.
Only a bounded, sanitized receipt is printed; native JSONL and tool output are never printed.
`;

const fail = code => { throw new Error(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = isDeepStrictEqual;
const safeReason = error => {
  const known = new Set(['invalid_options', 'invalid_executable', 'unsupported_platform', 'runtime_unavailable',
    'process_timeout', 'process_output_limit', 'process_failed', 'jsonl_invalid', 'tool_sequence_invalid',
    'tool_arguments_invalid', 'tool_result_failed', 'native_read_failed', 'native_output_mismatch',
    'unexpected_tool', 'ledger_invalid', 'evidence_cli_failed', 'unsafe_cleanup']);
  return known.has(error?.message) ? error.message : 'probe_failed';
};

export function parseCodexAgentProbeOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const options = { execute: false, json: false, codexExecutable: null, outDir: null, timeoutMs: 120000 };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (seen.has(token)) fail('invalid_options');
    seen.add(token);
    if (token === '--execute') options.execute = true;
    else if (token === '--json') options.json = true;
    else if (token === '--codex-executable') options.codexExecutable = argv[++i];
    else if (token === '--out-dir') options.outDir = argv[++i];
    else if (token === '--timeout-ms') {
      const value = argv[++i];
      if (!/^[0-9]+$/u.test(value ?? '')) fail('invalid_options');
      options.timeoutMs = Number(value);
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 15000 || options.timeoutMs > 180000) fail('invalid_options');
    } else fail('invalid_options');
  }
  if (options.execute !== (options.codexExecutable !== null) ||
    (options.codexExecutable !== null && (!options.codexExecutable || options.codexExecutable.startsWith('--'))) ||
    (options.outDir !== null && (!options.execute || !options.outDir || options.outDir.startsWith('--')))) fail('invalid_options');
  return options;
}

function validatedExecutable(path) {
  if (!isSafeCodexPath(path) || !isAbsolute(path)) fail('invalid_executable');
  try { if (!lstatSync(path).isFile()) fail('invalid_executable'); }
  catch { fail('invalid_executable'); }
  return path;
}

function ownedTemp() {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, PREFIX));
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory || dirname(directory) !== root) fail('unsafe_cleanup');
  return { root, directory };
}

function ownedOutput(target) {
  if (!isSafeCodexPath(target, 1024) || !isAbsolute(target) || existsSync(target)) fail('invalid_options');
  const root = realpathSync(dirname(target));
  if (dirname(target) !== root || !lstatSync(root).isDirectory()) fail('invalid_options');
  mkdirSync(target, { recursive: false, mode: 0o700 });
  if (!lstatSync(target).isDirectory() || realpathSync(target) !== target) fail('invalid_options');
  return { root, directory: target, retained: true };
}

function removeOwnedTemp(root, directory) {
  if (dirname(directory) !== root || !basename(directory).startsWith(PREFIX) ||
    !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory)
    fail('unsafe_cleanup');
  rmSync(directory, { recursive: true, force: false });
}

function fixedCall(directory, nonce) {
  const fixture = join(directory, 'fixture.txt');
  const marker = `REFLEXMESH_CODEX_AGENT_${randomBytes(16).toString('hex')}`;
  writeFileSync(fixture, `${marker}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const call = { schemaVersion: 1, harness: 'codex', sessionId: `probe-${nonce}`,
    agentId: 'root', callId: `read-${nonce}`, toolName: 'Get-Content', arguments: { path: fixture } };
  // A direct native PowerShell command; the path is generated in our private temp directory.
  const command = `Get-Content -LiteralPath '${fixture.replaceAll("'", "''")}'`;
  return { fixture, marker, call, command };
}

function codexArgs(setup, directory, call, command) {
  const config = [
    [`mcp_servers.${SERVER}.command`, setup.command],
    [`mcp_servers.${SERVER}.args`, setup.args],
    ...Object.entries(setup.env).map(([key, value]) => [`mcp_servers.${SERVER}.env.${key}`, value]),
    [`mcp_servers.${SERVER}.enabled_tools`, ['reflexmesh_assess', 'reflexmesh_observe_outcome']],
    [`mcp_servers.${SERVER}.default_tools_approval_mode`, 'prompt'],
    [`mcp_servers.${SERVER}.tools.reflexmesh_assess.approval_mode`, 'approve'],
    [`mcp_servers.${SERVER}.tools.reflexmesh_observe_outcome.approval_mode`, 'approve'],
    [`mcp_servers.${SERVER}.required`, true],
    [`mcp_servers.${SERVER}.startup_timeout_sec`, 10],
    [`mcp_servers.${SERVER}.tool_timeout_sec`, 20],
  ].flatMap(([key, value]) => ['--config', `${key}=${JSON.stringify(value)}`]);
  const prompt = `The caller has independently authorized exactly one read of this generated synthetic fixture. ReflexMesh's assessment is advisory: even an escalate result is neither a host permission grant nor a denial. Follow the host's read-only sandbox and tool policy. Use exactly three tools in this order. First call ${SERVER}.reflexmesh_assess with arguments ${JSON.stringify({ call, userIntent: SUMMARY })}. Second run exactly one native PowerShell command using the shell tool: ${command}. Do not run any other shell command or tool. Third call ${SERVER}.reflexmesh_observe_outcome with arguments ${JSON.stringify({ call, status: 'succeeded', evidence: { source: 'model-report' } })} only if the native command succeeded. Do not quote or repeat its output in your final answer. Reply briefly when finished.`;
  return { args: ['--sandbox', 'read-only', '--ask-for-approval', 'never', '--cd', directory,
    'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--json', '--color', 'never', ...config], prompt };
}

function filteredEnv() {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'CODEX_HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
  return { ...Object.fromEntries(allowed.filter(key => typeof process.env[key] === 'string')
    .map(key => [key, process.env[key]])), NODE_NO_WARNINGS: '1' };
}

async function spawnBounded(executable, args, { cwd, input = '', timeoutMs, limit }) {
  const result = await runBounded(executable, input ? [...args, input] : args, { cwd, env: filteredEnv(), timeoutMs,
    stdoutLimitBytes: limit, stderrLimitBytes: 64 * 1024 });
  return result.ok ? result : { ok: false, reason: result.kind === 'timeout' ? 'process_timeout'
    : ['stdout_limit', 'stderr_limit'].includes(result.kind) ? 'process_output_limit' : 'process_failed' };
}

function parsedArgs(item) {
  if (plain(item.arguments)) return item.arguments;
  if (typeof item.arguments === 'string' && item.arguments.length <= 32768) {
    try { const value = JSON.parse(item.arguments); if (plain(value)) return value; } catch {}
  }
  return null;
}

function successfulMcp(item) {
  if (item.error != null || item.status === 'failed' || item.result == null) return false;
  let result = item.result;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { return false; }
  }
  return plain(result) && result.isError !== true;
}

/** Codex on Windows records the shell executable and -Command wrapper in JSONL. */
function nativeCommandMatches(observed, expected) {
  if (typeof observed !== 'string' || typeof expected?.command !== 'string') return false;
  const wrapper = /^"([A-Za-z]:\\[^"\r\n]*\\(?:powershell|pwsh)\.exe)"(?: -(?:NoProfile|NonInteractive|NoLogo))* -Command (.+)$/iu.exec(observed);
  if (observed.startsWith('"') && !wrapper) return false;
  const payload = wrapper ? wrapper[2] : observed;
  const paths = [expected.fixture, expected.fixture?.replaceAll('\\', '/'), 'fixture.txt', '.\\fixture.txt', './fixture.txt']
    .filter(path => typeof path === 'string');
  const commands = new Set([expected.command]);
  for (const path of paths) {
    commands.add(`Get-Content -LiteralPath '${path.replaceAll("'", "''")}'`);
    if (!path.includes('"')) commands.add(`Get-Content -LiteralPath "${path}"`);
  }
  if ([...commands].some(command => payload === command ||
    (wrapper && (payload === `'${command.replaceAll("'", "''")}'` ||
      (!command.includes('"') && payload === `"${command}"`))))) return true;
  if (!win32.isAbsolute(expected.fixture ?? '')) return false;
  const scripts = [payload];
  if (wrapper && payload.startsWith('"') && payload.endsWith('"')) scripts.push(payload.slice(1, -1));
  if (wrapper && payload.startsWith("'") && payload.endsWith("'")) scripts.push(payload.slice(1, -1).replaceAll("''", "'"));
  for (const script of scripts) {
    const match = /^Get-Content -LiteralPath '((?:[^']|'')+)'$/iu.exec(script);
    if (!match) continue;
    const target = match[1].replaceAll("''", "'");
    if (win32.normalize(win32.resolve(win32.dirname(expected.fixture), target)).toLowerCase() ===
      win32.normalize(expected.fixture).toLowerCase()) return true;
  }
  return false;
}

function commandLexemes(command) {
  if (typeof command !== 'string') return [];
  const wrapper = /^"[A-Za-z]:\\[^"\r\n]*\\(?:powershell|pwsh)\.exe"(?: -(?:NoProfile|NonInteractive|NoLogo))* -Command (.+)$/iu.exec(command);
  const payload = wrapper ? wrapper[1] : command;
  const lexemes = [];
  const tokens = payload.match(/Get-Content|-LiteralPath|-Path|-Raw|fixture\.txt|\.\\|\.\/|["'`{};|&()]|[^\s"'`{};|&()]+/giu) ?? [];
  for (const token of tokens.slice(0, 24)) {
    if (token === 'Get-Content') lexemes.push('get_content');
    else if (token === '-LiteralPath') lexemes.push('literal_path');
    else if (token === '-Path') lexemes.push('path_flag');
    else if (token === '-Raw') lexemes.push('raw_flag');
    else if (token === 'fixture.txt') lexemes.push('fixture_name');
    else if (token === '.\\' || token === './') lexemes.push('relative_prefix');
    else if (token === '"') lexemes.push('double_quote');
    else if (token === "'") lexemes.push('single_quote');
    else if (token === '`') lexemes.push('backtick');
    else if (token === ';') lexemes.push('semicolon');
    else if (token === '|') lexemes.push('pipe');
    else if (token === '&') lexemes.push('ampersand');
    else if (['{', '}', '(', ')'].includes(token)) lexemes.push('group');
    else lexemes.push('other');
  }
  return lexemes;
}

/** Only fixed labels, booleans and bounded counts are exposed. Raw JSONL is never copied. */
function diagnoseCodexJsonl(jsonl, expected) {
  const diagnostics = { toolEvents: [], toolEventCount: 0, toolEventsTruncated: false,
    turns: { completed: 0, failed: 0 }, malformedJsonl: false };
  if (typeof jsonl !== 'string' || Buffer.byteLength(jsonl) > MAX_JSONL || !plain(expected)) {
    diagnostics.malformedJsonl = true;
    return diagnostics;
  }
  const phase = { 'item.started': 'started', 'item.updated': 'updated', 'item.completed': 'completed' };
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { diagnostics.malformedJsonl = true; break; }
    if (!plain(record)) { diagnostics.malformedJsonl = true; break; }
    if (record.type === 'turn.completed') diagnostics.turns.completed = Math.min(3, diagnostics.turns.completed + 1);
    if (record.type === 'turn.failed') diagnostics.turns.failed = Math.min(3, diagnostics.turns.failed + 1);
    if (!Object.hasOwn(phase, record.type)) continue;
    const item = record.item;
    if (!plain(item) || typeof item.type !== 'string') { diagnostics.malformedJsonl = true; break; }
    if (['reasoning', 'agent_message', 'plan'].includes(item.type)) continue;
    diagnostics.toolEventCount = Math.min(13, diagnostics.toolEventCount + 1);
    if (diagnostics.toolEvents.length >= 12) { diagnostics.toolEventsTruncated = true; continue; }
    if (item.type === 'mcp_tool_call') {
      const server = item.server ?? item.server_name ?? item.serverName;
      const tool = item.tool ?? item.name ?? item.tool_name ?? item.toolName;
      const name = server === SERVER && ['reflexmesh_assess', 'reflexmesh_observe_outcome'].includes(tool) ? tool : 'other_mcp';
      const expectedArgs = name === 'reflexmesh_assess' ? { call: expected.call, userIntent: SUMMARY }
        : name === 'reflexmesh_observe_outcome' ? { call: expected.call, status: 'succeeded', evidence: { source: 'model-report' } } : null;
      diagnostics.toolEvents.push({ phase: phase[record.type], type: 'mcp_tool_call', name,
        argsMatch: expectedArgs === null ? false : same(parsedArgs(item), expectedArgs) });
    } else if (item.type === 'command_execution') {
      const commandMatch = nativeCommandMatches(item.command, expected);
      const observed = typeof item.command === 'string' ? item.command : '';
      diagnostics.toolEvents.push({ phase: phase[record.type], type: 'command_execution',
        name: commandMatch ? 'Get-Content' : 'other_command', commandMatch,
        commandShape: {
          containsExpected: observed.includes(expected.command),
          containsFixture: observed.includes(expected.fixture),
          containsFixtureBasename: observed.includes('fixture.txt'),
          containsGetContent: /\bGet-Content\b/iu.test(observed),
          containsPowerShell: /\b(?:powershell|pwsh)\.exe\b/iu.test(observed),
          containsCommandFlag: /(?:^|\s)-Command(?:\s|$)/iu.test(observed),
          startsWithQuote: observed.startsWith('"'),
        },
        commandLexemes: commandMatch ? [] : commandLexemes(observed),
        exitZero: record.type === 'item.completed' ? item.exit_code === 0 : null,
        outputMarkerMatch: record.type === 'item.completed'
          ? typeof (item.aggregated_output ?? item.output) === 'string'
            && (item.aggregated_output ?? item.output).trim() === expected.marker : null });
    } else diagnostics.toolEvents.push({ phase: phase[record.type], type: 'other_tool', name: 'other' });
  }
  return diagnostics;
}

/** Strict, typed JSONL evidence. Assistant prose, duplicated events and incomplete calls never pass. */
export function analyzeCodexAgentJsonl(jsonl, expected) {
  const diagnostics = diagnoseCodexJsonl(jsonl, expected);
  const result = (passed, reason) => ({ passed, reason, diagnostics });
  if (diagnostics.malformedJsonl) return result(false, 'jsonl_invalid');
  const events = [], updates = [];
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { return result(false, 'jsonl_invalid'); }
    if (!plain(record)) return result(false, 'jsonl_invalid');
    if (!['item.started', 'item.completed', 'item.updated'].includes(record.type)) continue;
    const item = record.item;
    if (!plain(item) || typeof item.type !== 'string') return result(false, 'jsonl_invalid');
    if (['reasoning', 'agent_message', 'plan'].includes(item.type)) continue;
    if (!['mcp_tool_call', 'command_execution'].includes(item.type)) return result(false, 'unexpected_tool');
    if (record.type === 'item.updated') { updates.push(item); continue; }
    events.push({ phase: record.type, item });
  }
  if (events.length !== 6) return result(false, 'tool_sequence_invalid');
  const phases = ['item.started', 'item.completed', 'item.started', 'item.completed', 'item.started', 'item.completed'];
  if (!events.every((event, index) => event.phase === phases[index]) ||
    !same(events.map(({ item }) => item.type), ['mcp_tool_call', 'mcp_tool_call', 'command_execution', 'command_execution', 'mcp_tool_call', 'mcp_tool_call']))
    return result(false, 'tool_sequence_invalid');
  const [assessStart, assessEnd, nativeStart, nativeEnd, outcomeStart, outcomeEnd] = events.map(event => event.item);
  if (![assessStart, nativeStart, outcomeStart].every(item => typeof item.id === 'string' && item.id.length > 0) ||
    assessStart.id !== assessEnd.id || nativeStart.id !== nativeEnd.id || outcomeStart.id !== outcomeEnd.id ||
    new Set([assessStart.id, nativeStart.id, outcomeStart.id]).size !== 3) return result(false, 'tool_sequence_invalid');
  const eventTypes = new Map([[assessStart.id, 'mcp_tool_call'], [nativeStart.id, 'command_execution'],
    [outcomeStart.id, 'mcp_tool_call']]);
  if (updates.some(item => eventTypes.get(item.id) !== item.type)) return result(false, 'unexpected_tool');
  const mcpName = item => [item.server ?? item.server_name ?? item.serverName, item.tool ?? item.name ?? item.tool_name ?? item.toolName];
  if (![assessStart, assessEnd].every(item => same(mcpName(item), [SERVER, 'reflexmesh_assess'])) ||
    ![outcomeStart, outcomeEnd].every(item => same(mcpName(item), [SERVER, 'reflexmesh_observe_outcome']))) return result(false, 'unexpected_tool');
  const assessArgs = { call: expected.call, userIntent: SUMMARY };
  const outcomeArgs = { call: expected.call, status: 'succeeded', evidence: { source: 'model-report' } };
  if (![assessStart, assessEnd].every(item => same(parsedArgs(item), assessArgs)) ||
    ![outcomeStart, outcomeEnd].every(item => same(parsedArgs(item), outcomeArgs)) ||
    !nativeCommandMatches(nativeStart.command, expected) ||
    !nativeCommandMatches(nativeEnd.command, expected))
    return result(false, 'tool_arguments_invalid');
  if (!successfulMcp(assessEnd) || !successfulMcp(outcomeEnd)) return result(false, 'tool_result_failed');
  if (nativeEnd.exit_code !== 0 || nativeEnd.status === 'failed') return result(false, 'native_read_failed');
  const output = nativeEnd.aggregated_output ?? nativeEnd.output;
  if (typeof output !== 'string' || output.trim() !== expected.marker) return result(false, 'native_output_mismatch');
  if (diagnostics.turns.completed !== 1 || diagnostics.turns.failed !== 0)
    return result(false, 'tool_sequence_invalid');
  return result(true, 'agent_evidence_passed');
}

async function publicEvidence(dbPath, timeoutMs) {
  const call = async args => {
    const result = await spawnBounded(process.execPath, [EVIDENCE_CLI, ...args, '--json'],
      { cwd: dirname(dbPath), timeoutMs: Math.min(timeoutMs, 15000), limit: MAX_EVIDENCE });
    if (!result.ok) fail('evidence_cli_failed');
    try { return JSON.parse(result.stdout); } catch { fail('evidence_cli_failed'); }
  };
  const list = await call(['list', '--db', dbPath, '--limit', '2']);
  if (list?.items?.length !== 1 || list.nextCursor !== null || typeof list.items[0]?.key !== 'string') fail('evidence_cli_failed');
  const decisionId = list.items[0].key;
  const inspect = await call(['inspect', '--db', dbPath, '--key', decisionId]);
  const attention = await call(['attention', '--db', dbPath, '--limit', '2']);
  if (inspect?.key !== decisionId || attention?.items?.length !== 0 || attention.nextCursor !== null) fail('evidence_cli_failed');
  return { list, inspect, attention };
}

function directLedger(dbPath, decisionId, marker, publicReadback) {
  const kernel = new SqliteKernel(dbPath, { readOnly: true, busyTimeoutMs: 250 });
  let snapshot;
  try { snapshot = kernel.evidenceSnapshot(decisionId); } finally { kernel.close(); }
  if (!snapshot || !same(snapshot, publicReadback.inspect) || !same(snapshot, publicReadback.list.items[0]) ||
    snapshot.taskEvidence?.recordedStatus !== 'ready' || snapshot.taskEvidence?.source !== 'model-reported' ||
    snapshot.hostOutcome?.status !== 'succeeded' || snapshot.hostOutcome?.count !== 1 ||
    !same(snapshot.hostOutcome?.byProvenance, [{ provenance: 'model-reported', status: 'succeeded', count: 1 }]) ||
    snapshot.labelCount !== 0 || snapshot.run?.state !== 'completed') fail('ledger_invalid');
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(Buffer.from(marker)) || bytes.includes(Buffer.from(SUMMARY))) fail('ledger_invalid');
  }
  return { task: 'ready_model_reported', outcome: 'succeeded_model_reported', labels: 0,
    publicList: 'one_matching_row', publicInspect: 'matched', publicAttention: 'empty' };
}

const powershellQuote = value => `'${value.replaceAll("'", "''")}'`;

export async function runCodexAgentProbe(options, dependencies = {}) {
  if (!options.execute) return { schemaVersion: 1, kind: 'codex_agent_probe', status: 'not_run', reason: 'explicit_execute_required', agentInvocationAttempts: 0, modelRequests: 'unknown' };
  if (process.platform !== 'win32' && !dependencies.launch) return { schemaVersion: 1, kind: 'codex_agent_probe', status: 'failed', reason: 'unsupported_platform', agentInvocationAttempts: 0, modelRequests: 'unknown' };
  try { validatedExecutable(options.codexExecutable); }
  catch (error) { return { schemaVersion: 1, kind: 'codex_agent_probe', status: 'failed', reason: safeReason(error), agentInvocationAttempts: 0, modelRequests: 'unknown' }; }
  try { assertSqliteWalRuntime(); }
  catch { return { schemaVersion: 1, kind: 'codex_agent_probe', status: 'failed', reason: 'runtime_unavailable', agentInvocationAttempts: 0, modelRequests: 'unknown' }; }
  let temp, attempted = false, report, diagnostics;
  try {
    temp = options.outDir ? ownedOutput(options.outDir) : ownedTemp();
    const nonce = randomBytes(8).toString('hex');
    const fixture = fixedCall(temp.directory, nonce);
    const dbPath = join(temp.directory, 'ledger.sqlite');
    const setup = createCodexSetup({ nodePath: process.execPath, dbPath, tenantId: 'isolated-agent-probe',
      scope: 'isolated-agent-probe', serverName: SERVER });
    const invocation = codexArgs(setup, temp.directory, fixture.call, fixture.command);
    const launcher = dependencies.launch ?? ((executable, args, context) => spawnBounded(executable, args, context));
    attempted = true;
    const child = await launcher(options.codexExecutable, invocation.args,
      { cwd: temp.directory, input: invocation.prompt, timeoutMs: options.timeoutMs, limit: MAX_JSONL,
        setup, fixture });
    if (!child?.ok) fail(child?.reason === 'process_timeout' || child?.reason === 'process_output_limit' ? child.reason : 'process_failed');
    const analyzed = analyzeCodexAgentJsonl(child.stdout, fixture);
    diagnostics = analyzed.diagnostics;
    if (!analyzed.passed) fail(analyzed.reason);
    const readback = await publicEvidence(dbPath, options.timeoutMs);
    const ledger = directLedger(dbPath, readback.inspect.key, fixture.marker, readback);
    if (temp.retained) writeFileSync(join(temp.directory, 'START-HERE.md'),
      `# Synthetic Codex Agent probe evidence\n\nThis ledger contains one model-reported assessment and outcome. The outcome is not independent host evidence.\n\n` +
      `\`& ${powershellQuote(process.execPath)} ${powershellQuote(EVIDENCE_CLI)} list --db ${powershellQuote(dbPath)} --json\`\n\n` +
      `\`& ${powershellQuote(process.execPath)} ${powershellQuote(EVIDENCE_CLI)} inspect --db ${powershellQuote(dbPath)} --key ${powershellQuote(readback.inspect.key)} --json\`\n\n` +
      `\`& ${powershellQuote(process.execPath)} ${powershellQuote(EVIDENCE_CLI)} attention --db ${powershellQuote(dbPath)} --json\`\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    report = { schemaVersion: 1, kind: 'codex_agent_probe', status: 'passed', reason: analyzed.reason,
      agentInvocationAttempts: 1, agentInvocations: 1, modelRequests: 'unknown', nativeReads: 1, mcpCalls: 2,
      reflexmeshProviderEgress: false, retained: Boolean(temp.retained), ...ledger };
  } catch (error) {
    report = { schemaVersion: 1, kind: 'codex_agent_probe', status: 'failed', reason: safeReason(error),
      agentInvocationAttempts: attempted ? 1 : 0, modelRequests: 'unknown',
      ...(diagnostics ? { diagnostics } : {}) };
  }
  if (temp && !temp.retained) {
    try { removeOwnedTemp(temp.root, temp.directory); }
    catch { return { schemaVersion: 1, kind: 'codex_agent_probe', status: 'failed', reason: 'unsafe_cleanup',
      agentInvocationAttempts: attempted ? 1 : 0, modelRequests: 'unknown' }; }
  }
  return report;
}

export async function codexAgentProbeMain(argv = process.argv.slice(2), output = process.stdout) {
  let options;
  try { options = parseCodexAgentProbeOptions(argv); }
  catch { output.write(`${JSON.stringify({ schemaVersion: 1, kind: 'codex_agent_probe', status: 'failed', reason: 'invalid_options', agentInvocationAttempts: 0, modelRequests: 'unknown' })}\n`); return 2; }
  if (options.help) { output.write(USAGE); return 0; }
  const report = await runCodexAgentProbe(options);
  output.write(options.json || report.status === 'failed' ? `${JSON.stringify(report)}\n` :
    `ReflexMesh Codex Agent probe: ${report.status} (${report.reason}).\n`);
  return report.status === 'failed' ? 1 : 0;
}

if (isDirectRun(import.meta.url)) process.exitCode = await codexAgentProbeMain();
