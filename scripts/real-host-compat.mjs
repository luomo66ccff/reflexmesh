#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { AGENT_EVIDENCE, evaluateAgentProbeOutput } from './deepseek-agent-contract.mjs';

const HOSTS = new Set(['codex', 'claude', 'deepseek', 'all']);
const CODEX_MARKER = 'REFLEXMESH_CODEX_COMPAT_OK';
const CLAUDE_MARKER = 'REFLEXMESH_CLAUDE_COMPAT_OK';
const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  versionTimeoutMs: 10_000,
  stdoutLimitBytes: 4 * 1024 * 1024,
  stderrLimitBytes: 64 * 1024,
});

const ARGUMENTS = Object.freeze({
  '--host': 'host',
  '--repo-root': 'repoRoot',
  '--mcp-server': 'mcpServer',
  '--claude-hook': 'claudeHook',
  '--codex-command': 'codexCommand',
  '--claude-command': 'claudeCommand',
  '--deepseek-command': 'deepseekCommand',
  '--deepseek-package-root': 'deepseekPackageRoot',
  '--deepseek-mode': 'deepseekMode',
  '--node-command': 'nodeCommand',
  '--timeout-ms': 'timeoutMs',
  '--version-timeout-ms': 'versionTimeoutMs',
  '--stdout-limit-bytes': 'stdoutLimitBytes',
  '--stderr-limit-bytes': 'stderrLimitBytes',
});

const PREFIX_ARGUMENTS = Object.freeze({
  '--codex-command-arg': 'codexCommandArgs',
  '--claude-command-arg': 'claudeCommandArgs',
  '--deepseek-command-arg': 'deepseekCommandArgs',
  '--node-command-arg': 'nodeCommandArgs',
});

function optionValue(argv, index) {
  const token = argv[index];
  const split = token.indexOf('=');
  if (split !== -1) return { name: token.slice(0, split), value: token.slice(split + 1), consumed: 1 };
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error('missing_option_value');
  return { name: token, value: argv[index + 1], consumed: 2 };
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`invalid_${name}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`invalid_${name}`);
  return number;
}

/** Parse only explicit options. No option is evaluated by a shell. */
export function parseArgs(argv, defaults = {}) {
  const parsed = {
    host: 'all',
    repoRoot: DEFAULT_REPO_ROOT,
    codexCommand: 'codex',
    claudeCommand: 'claude',
    deepseekCommand: null,
    deepseekPackageRoot: null,
    deepseekMode: 'native',
    nodeCommand: process.execPath,
    codexCommandArgs: [],
    claudeCommandArgs: [],
    deepseekCommandArgs: [],
    nodeCommandArgs: [],
    ...DEFAULT_LIMITS,
    ...defaults,
  };
  for (let index = 0; index < argv.length;) {
    const current = optionValue(argv, index);
    index += current.consumed;
    const scalar = ARGUMENTS[current.name];
    const repeated = PREFIX_ARGUMENTS[current.name];
    if (!scalar && !repeated) throw new Error('unknown_option');
    if (repeated) parsed[repeated].push(current.value);
    else parsed[scalar] = current.value;
  }
  if (!HOSTS.has(parsed.host)) throw new Error('invalid_host');
  if (!['native', 'agent-cli'].includes(parsed.deepseekMode)) throw new Error('invalid_deepseek_mode');
  if (parsed.deepseekMode === 'agent-cli' && !parsed.deepseekPackageRoot) throw new Error('deepseek_package_root_required');
  parsed.timeoutMs = boundedInteger(String(parsed.timeoutMs), 'timeout_ms', 1_000, 600_000);
  parsed.versionTimeoutMs = boundedInteger(String(parsed.versionTimeoutMs), 'version_timeout_ms', 500, 60_000);
  parsed.stdoutLimitBytes = boundedInteger(String(parsed.stdoutLimitBytes), 'stdout_limit_bytes', 1_024, 16 * 1024 * 1024);
  parsed.stderrLimitBytes = boundedInteger(String(parsed.stderrLimitBytes), 'stderr_limit_bytes', 1_024, 1024 * 1024);
  parsed.repoRoot = resolve(parsed.repoRoot);
  parsed.mcpServer = resolve(parsed.mcpServer ?? join(parsed.repoRoot, 'adapters', 'mcp-server.mjs'));
  parsed.claudeHook = resolve(parsed.claudeHook ?? join(parsed.repoRoot, 'adapters', 'claude-task-hook.mjs'));
  if (parsed.deepseekPackageRoot !== null) parsed.deepseekPackageRoot = resolve(parsed.deepseekPackageRoot);
  return parsed;
}

function isFile(path) {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function isRunnableFile(path, platform) {
  if (!isFile(path)) return false;
  if (platform === 'win32') return ['.exe', '.com'].includes(extname(path).toLowerCase());
  try { return (statSync(path).mode & 0o111) !== 0; }
  catch { return false; }
}

function commandDirectories(env, platform) {
  return String(env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** Resolve a native executable without asking a command shell to interpret a shim. */
export function resolveExecutable(command, { env = process.env, platform = process.platform, cwd = process.cwd(), host = '' } = {}) {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) return null;
  const explicit = isAbsolute(command) || command.includes('/') || command.includes('\\');
  if (explicit) {
    const path = resolve(cwd, command);
    return isRunnableFile(path, platform) ? realpathSync(path) : null;
  }
  const suffixes = platform === 'win32'
    ? (extname(command) ? [''] : ['.exe', '.com', ''])
    : [''];
  for (const directory of commandDirectories(env, platform)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, command + suffix);
      if (isRunnableFile(candidate, platform)) return realpathSync(candidate);
    }
    // The official Windows npm shim points at this native Claude binary. We
    // inspect the conventional install path instead of executing .cmd/.ps1.
    if (platform === 'win32' && host === 'claude' && command.toLowerCase() === 'claude') {
      const native = join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (isRunnableFile(native, platform)) return realpathSync(native);
    }
  }
  return null;
}

function processSpec(command, prefixArgs, host, env) {
  const executable = resolveExecutable(command, { host, env });
  return executable ? { executable, prefixArgs: [...prefixArgs] } : null;
}

/** Spawn directly, with bounded capture and no raw stderr in the result. */
export function runBounded(executable, args, {
  cwd,
  env = process.env,
  timeoutMs,
  stdoutLimitBytes,
  stderrLimitBytes,
  captureNonzeroStdout = false,
} = DEFAULT_LIMITS) {
  return new Promise(resolveResult => {
    let settled = false;
    let timedOut = false;
    let overflow = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    let child;
    let timer;
    let settleTimer;
    let abortReason = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      resolveResult(result);
    };
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return finish({ ok: false, kind: 'spawn_error' });
    }
    const terminate = reason => {
      if (abortReason) return;
      abortReason = reason;
      timedOut = reason === 'timeout';
      if (process.platform === 'win32' && child.pid) {
        try {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            shell: false, windowsHide: true, stdio: 'ignore',
          });
          killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} });
          killer.unref();
        } catch { try { child.kill('SIGKILL'); } catch {} }
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch {} }
      }
      // A descendant can keep inherited handles open even after the direct
      // child is gone. Never let close-event delivery defeat the deadline.
      settleTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish({ ok: false, kind: reason });
      }, 2_000);
    };
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => {
      if (abortReason || settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimitBytes) {
        overflow = 'stdout_limit';
        terminate(overflow);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (abortReason || settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > stderrLimitBytes) {
        overflow = 'stderr_limit';
        terminate(overflow);
      }
    });
    child.once('error', () => finish({ ok: false, kind: abortReason ?? 'spawn_error' }));
    child.once('close', code => {
      if (timedOut) return finish({ ok: false, kind: 'timeout' });
      if (overflow) return finish({ ok: false, kind: overflow });
      if (code !== 0) return finish({ ok: false, kind: 'nonzero_exit',
        ...(captureNonzeroStdout && code === 1 ? { stdout: Buffer.concat(stdout).toString('utf8') } : {}) });
      finish({ ok: true, stdout: Buffer.concat(stdout).toString('utf8') });
    });
  });
}

/** Map all child failures to a fixed code; raw output fields are ignored. */
export function processFailureReason(result) {
  return ({
    timeout: 'host_timeout',
    stdout_limit: 'host_stdout_limit_exceeded',
    stderr_limit: 'host_stderr_limit_exceeded',
    nonzero_exit: 'host_exit_nonzero',
    spawn_error: 'host_spawn_failed',
  })[result?.kind] ?? 'host_process_failed';
}

function parseVersion(host, text) {
  const first = text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  const clean = first.replace(/\x1b\[[0-9;]*m/g, '');
  const version = clean.match(/v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+._][0-9A-Za-z.-]+)*)/i)?.[1];
  if (!version) return 'unknown';
  if (host === 'codex') return `codex-cli ${version}`;
  if (host === 'claude') return `Claude Code ${version}`;
  return `DeepSeek Harness ${version}`;
}

async function discoverVersion(host, spec, options) {
  const result = await runBounded(spec.executable, [...spec.prefixArgs, '--version'], {
    cwd: options.repoRoot,
    env: process.env,
    timeoutMs: options.versionTimeoutMs,
    stdoutLimitBytes: 64 * 1024,
    stderrLimitBytes: options.stderrLimitBytes,
  });
  return result.ok
    ? { ok: true, version: parseVersion(host, result.stdout) }
    : { ok: false, version: 'unknown', reason: processFailureReason(result) };
}

function parseJsonLines(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
    } catch { /* Non-JSON cannot satisfy a structured assertion. */ }
  }
  return records;
}

function assertion(name, passed) { return { name, passed: Boolean(passed) }; }

/** Inspect only typed Codex JSONL fields; prompt/assistant prose cannot count as a call. */
export function evaluateCodexJsonl(text, marker = CODEX_MARKER) {
  const records = parseJsonLines(text);
  const calls = new Map();
  let allowedCompleted = false;
  let allowedSucceeded = false;
  let exactFinalMarker = false;
  let unexpected = false;
  const forbiddenTypes = new Set(['command_execution', 'file_change', 'web_search', 'dynamic_tool_call', 'collab_tool_call']);
  for (const record of records) {
    const item = record.item && typeof record.item === 'object' ? record.item : record;
    const itemType = item.type;
    if (itemType === 'mcp_tool_call') {
      const key = typeof item.id === 'string' ? item.id : JSON.stringify([item.server, item.server_name, item.tool, item.name]);
      const identity = {
        server: item.server ?? item.server_name ?? item.serverName,
        tool: item.tool ?? item.name ?? item.tool_name ?? item.toolName,
      };
      calls.set(key, identity);
      const allowed = identity.server === 'reflexmesh' && identity.tool === 'reflexmesh_inspect_pack';
      if (!allowed) unexpected = true;
      if (allowed && (record.type === 'item.completed' || item.status === 'completed')) {
        allowedCompleted = true;
        const hasResult = Object.hasOwn(item, 'result') && item.result != null;
        allowedSucceeded = hasResult && item.error == null && item.result?.isError !== true;
      }
    } else if (forbiddenTypes.has(itemType)) unexpected = true;
    if (record.type === 'item.completed' && itemType === 'agent_message' && typeof item.text === 'string') {
      exactFinalMarker = item.text.trim() === marker;
    }
  }
  const exactAllowedCount = [...calls.values()].filter(call => call.server === 'reflexmesh' && call.tool === 'reflexmesh_inspect_pack').length === 1;
  const assertions = [
    assertion('structured_mcp_tool_call', allowedCompleted && exactAllowedCount),
    assertion('mcp_tool_call_succeeded', allowedSucceeded),
    assertion('no_unexpected_tool_calls', !unexpected),
    assertion('exact_final_marker', exactFinalMarker),
  ];
  let reason = 'real_host_probe_passed';
  if (!allowedCompleted || !exactAllowedCount) reason = 'structured_mcp_tool_call_missing';
  else if (!allowedSucceeded) reason = 'mcp_tool_call_failed';
  else if (unexpected) reason = 'unexpected_tool_call';
  else if (!exactFinalMarker) reason = 'final_marker_missing';
  return { passed: assertions.every(value => value.passed), reason, assertions };
}

function normalizedPath(path) {
  const absolute = resolve(path);
  let canonical = absolute;
  try { canonical = realpathSync(absolute); } catch { /* Compared path may not exist. */ }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Inspect Claude stream-json tool blocks without treating prompt text as evidence. */
export function evaluateClaudeJsonl(text, fixturePath, marker = CLAUDE_MARKER) {
  const calls = new Map();
  let exactFinalMarker = false;
  for (const record of parseJsonLines(text)) {
    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      for (const block of record.message.content) {
        if (!block || block.type !== 'tool_use') continue;
        const key = typeof block.id === 'string' ? block.id : JSON.stringify([block.name, block.input]);
        calls.set(key, { name: block.name, input: block.input });
      }
    }
    if (record.type === 'result' && typeof record.result === 'string') exactFinalMarker = record.result.trim() === marker;
  }
  const values = [...calls.values()];
  const onlyRead = values.length === 1 && values[0].name === 'Read';
  const supplied = onlyRead && values[0].input && typeof values[0].input === 'object'
    ? values[0].input.file_path ?? values[0].input.path
    : null;
  const exactFixture = typeof supplied === 'string' && normalizedPath(supplied) === normalizedPath(fixturePath);
  return {
    passed: onlyRead && exactFixture && exactFinalMarker,
    reason: !onlyRead ? 'read_tool_call_missing_or_unexpected' : !exactFixture ? 'wrong_fixture_path' : !exactFinalMarker ? 'final_marker_missing' : 'real_host_probe_passed',
    assertions: [
      assertion('single_read_tool_call', onlyRead),
      assertion('isolated_fixture_path', exactFixture),
      assertion('exact_final_marker', exactFinalMarker),
    ],
  };
}

function inspectLedger(path) {
  if (!existsSync(path)) return null;
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    return {
      runs: Number(database.prepare('SELECT COUNT(*) AS count FROM runs').get().count),
      readyTaskEvidence: Number(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE json_extract(evidence, '$.taskEvidence.status') = 'ready'").get().count),
      outcomes: Number(database.prepare('SELECT COUNT(*) AS count FROM observations').get().count),
      succeededOutcomes: Number(database.prepare("SELECT COUNT(*) AS count FROM observations WHERE json_extract(body, '$.status') = 'succeeded'").get().count),
      labels: Number(database.prepare('SELECT COUNT(*) AS count FROM labels').get().count),
    };
  } catch { return null; }
  finally { try { database?.close(); } catch { /* Fixed result below. */ } }
}

function packageVersion(repoRoot) {
  try {
    const value = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    return typeof value.version === 'string' && /^[0-9A-Za-z.+_-]{1,64}$/.test(value.version) ? value.version : 'unknown';
  } catch { return 'unknown'; }
}

function tomlString(value) { return JSON.stringify(value); }
function tomlArray(values) { return `[${values.map(tomlString).join(',')}]`; }
function tomlInlineTable(value) {
  return `{${Object.entries(value).map(([key, entry]) => `${key}=${tomlString(entry)}`).join(',')}}`;
}

function safeTemp(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }
function removeTemp(path, prefix) {
  const base = resolve(tmpdir());
  const target = resolve(path);
  const inside = relative(base, target);
  if (inside && !inside.startsWith(`..${sep}`) && inside !== '..' && basename(target).startsWith(prefix)) {
    rmSync(target, { recursive: true, force: true });
  }
}

function fixedAssertions(host) {
  if (host === 'codex') return [
    assertion('structured_mcp_tool_call', false),
    assertion('mcp_tool_call_succeeded', false),
    assertion('no_unexpected_tool_calls', false),
    assertion('exact_final_marker', false),
  ];
  if (host === 'claude') return [
    assertion('single_read_tool_call', false),
    assertion('isolated_fixture_path', false),
    assertion('exact_final_marker', false),
    assertion('sqlite_run_present', false),
    assertion('sqlite_ready_task_evidence_present', false),
    assertion('sqlite_outcome_present', false),
    assertion('sqlite_succeeded_outcome_present', false),
    assertion('sqlite_zero_labels', false),
  ];
  return [assertion('installation_discovered', false), assertion('version_captured', false), assertion('e2e_exercised', false)];
}

function hostReport(host, testedAt, hostVersion, adapterVersion, status, reason, assertions, started, extras = {}) {
  return {
    host,
    testedAt,
    hostVersion,
    adapterVersion,
    status,
    reason,
    assertions,
    durationMs: Math.max(0, Date.now() - started),
    ...extras,
  };
}

function unavailableReport(host, testedAt, adapterVersion, started) {
  return hostReport(host, testedAt, 'not_discovered', adapterVersion, 'not_discovered', 'host_command_not_found', fixedAssertions(host), started);
}

function shellCommand(paths) {
  if (process.platform === 'win32') {
    if (paths.some(path => /[\r\n"%!^&|<>$`]/u.test(path))) throw new Error('unsafe_hook_command_path');
    return paths.map(path => `"${path}"`).join(' ');
  }
  return paths.map(path => `'${path.replaceAll("'", "'\\''")}'`).join(' ');
}

async function runCodex(options, adapterVersion) {
  const host = 'codex', testedAt = new Date().toISOString(), started = Date.now();
  const spec = processSpec(options.codexCommand, options.codexCommandArgs, host, process.env);
  if (!spec) return unavailableReport(host, testedAt, adapterVersion, started);
  const version = await discoverVersion(host, spec, options);
  if (!version.ok) return hostReport(host, testedAt, version.version, adapterVersion, 'failed', version.reason, fixedAssertions(host), started);
  const node = processSpec(options.nodeCommand, options.nodeCommandArgs, 'node', process.env);
  if (!node || !isFile(options.mcpServer)) return hostReport(host, testedAt, version.version, adapterVersion, 'failed', 'adapter_entrypoint_unavailable', fixedAssertions(host), started);
  const prefix = 'reflexmesh-codex-';
  const directory = safeTemp(prefix);
  try {
    const database = join(directory, 'shadow.sqlite');
    const config = [
      ['mcp_servers.reflexmesh.command', tomlString(node.executable)],
      ['mcp_servers.reflexmesh.args', tomlArray([...node.prefixArgs, options.mcpServer])],
      ['mcp_servers.reflexmesh.env', tomlInlineTable({
        REFLEXMESH_PROVIDER: 'abstain',
        REFLEXMESH_DB: database,
        REFLEXMESH_SCOPE: 'real-host-codex',
        REFLEXMESH_TASK_EVIDENCE: 'false',
      })],
      ['mcp_servers.reflexmesh.enabled_tools', tomlArray(['reflexmesh_inspect_pack'])],
      ['mcp_servers.reflexmesh.tools.reflexmesh_inspect_pack.approval_mode', tomlString('approve')],
      ['mcp_servers.reflexmesh.startup_timeout_sec', '10'],
      ['mcp_servers.reflexmesh.tool_timeout_sec', '20'],
    ].flatMap(([key, value]) => ['--config', `${key}=${value}`]);
    const prompt = `Call the MCP tool reflexmesh_inspect_pack exactly once with an empty object. Do not call any other tool. After it succeeds, reply with exactly ${CODEX_MARKER}`;
    const args = [
      ...spec.prefixArgs,
      '--sandbox', 'read-only',
      '--ask-for-approval', 'never',
      '--cd', directory,
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--json',
      '--color', 'never',
      ...config,
      prompt,
    ];
    const result = await runBounded(spec.executable, args, {
      cwd: directory,
      env: process.env,
      timeoutMs: options.timeoutMs,
      stdoutLimitBytes: options.stdoutLimitBytes,
      stderrLimitBytes: options.stderrLimitBytes,
    });
    if (!result.ok) return hostReport(host, testedAt, version.version, adapterVersion, 'failed', processFailureReason(result), fixedAssertions(host), started);
    const evaluated = evaluateCodexJsonl(result.stdout);
    return hostReport(host, testedAt, version.version, adapterVersion, evaluated.passed ? 'passed' : 'failed', evaluated.reason, evaluated.assertions, started);
  } finally { removeTemp(directory, prefix); }
}

async function runClaude(options, adapterVersion) {
  const host = 'claude', testedAt = new Date().toISOString(), started = Date.now();
  const spec = processSpec(options.claudeCommand, options.claudeCommandArgs, host, process.env);
  if (!spec) return unavailableReport(host, testedAt, adapterVersion, started);
  const version = await discoverVersion(host, spec, options);
  if (!version.ok) return hostReport(host, testedAt, version.version, adapterVersion, 'failed', version.reason, fixedAssertions(host), started);
  const node = processSpec(options.nodeCommand, options.nodeCommandArgs, 'node', process.env);
  if (!node || !isFile(options.claudeHook)) return hostReport(host, testedAt, version.version, adapterVersion, 'failed', 'adapter_entrypoint_unavailable', fixedAssertions(host), started);
  const prefix = 'reflexmesh-claude-';
  const directory = safeTemp(prefix);
  try {
    let hookCommand;
    try { hookCommand = shellCommand([node.executable, ...node.prefixArgs, options.claudeHook]); }
    catch { return hostReport(host, testedAt, version.version, adapterVersion, 'failed', 'unsafe_hook_command_path', fixedAssertions(host), started); }
    const fixture = join(directory, 'fixture.txt');
    const guard = join(directory, 'read-guard.mjs');
    const settings = join(directory, 'settings.json');
    const mcp = join(directory, 'mcp.json');
    const database = join(directory, 'shadow.sqlite');
    const intentDatabase = join(directory, 'intent.sqlite');
    writeFileSync(fixture, 'REFLEXMESH_REAL_HOST_FIXTURE\n', { encoding: 'utf8', mode: 0o600 });
    writeFileSync(guard, [
      "import { readFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "let payload = null; try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch {}",
      "const normalize = value => typeof value === 'string' ? (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)) : '';",
      "const allowed = payload?.hook_event_name === 'PreToolUse' && payload?.tool_name === 'Read' && normalize(payload?.tool_input?.file_path) === normalize(process.env.REFLEXMESH_COMPAT_FIXTURE);",
      "process.stdout.write(allowed ? '{}' : JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Compatibility probe permits only its isolated fixture.' } }));",
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });
    writeFileSync(mcp, '{"mcpServers":{}}\n', { encoding: 'utf8', mode: 0o600 });
    const hook = { type: 'command', command: hookCommand, timeout: 10 };
    const guardHook = { type: 'command', command: shellCommand([node.executable, ...node.prefixArgs, guard]), timeout: 10 };
    writeFileSync(settings, JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [hook] }],
      PreToolUse: [{ matcher: 'Read', hooks: [hook, guardHook] }],
      PostToolUse: [{ matcher: 'Read', hooks: [hook] }],
      PostToolUseFailure: [{ matcher: 'Read', hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      StopFailure: [{ hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }],
    } }), { encoding: 'utf8', mode: 0o600 });
    const prompt = `ReflexMesh-Intent: Read the isolated compatibility fixture without modifying any files.\nUse the Read tool exactly once on ${JSON.stringify(fixture)}. Do not call any other tool. Reply with exactly ${CLAUDE_MARKER}`;
    const env = {
      ...process.env,
      REFLEXMESH_PROVIDER: 'abstain',
      REFLEXMESH_DB: database,
      REFLEXMESH_INTENT_DB: intentDatabase,
      REFLEXMESH_INTENT_MODE: 'explicit-summary',
      REFLEXMESH_TASK_EVIDENCE: 'true',
      REFLEXMESH_TENANT: 'real-host-compat',
      REFLEXMESH_SCOPE: 'real-host-claude',
      REFLEXMESH_COMPAT_FIXTURE: fixture,
    };
    const args = [
      ...spec.prefixArgs,
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-hook-events',
      '--no-session-persistence',
      '--setting-sources', 'user',
      '--disable-slash-commands',
      '--no-chrome',
      '--settings', settings,
      '--strict-mcp-config',
      '--mcp-config', mcp,
      '--tools', 'Read',
      '--allowedTools', 'Read',
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      prompt,
    ];
    const result = await runBounded(spec.executable, args, {
      cwd: directory,
      env,
      timeoutMs: options.timeoutMs,
      stdoutLimitBytes: options.stdoutLimitBytes,
      stderrLimitBytes: options.stderrLimitBytes,
    });
    if (!result.ok) return hostReport(host, testedAt, version.version, adapterVersion, 'failed', processFailureReason(result), fixedAssertions(host), started);
    const evaluated = evaluateClaudeJsonl(result.stdout, fixture);
    const ledger = inspectLedger(database);
    const ledgerAssertions = [
      assertion('sqlite_run_present', ledger?.runs >= 1),
      assertion('sqlite_ready_task_evidence_present', ledger?.readyTaskEvidence >= 1),
      assertion('sqlite_outcome_present', ledger?.outcomes >= 1),
      assertion('sqlite_succeeded_outcome_present', ledger?.succeededOutcomes >= 1),
      assertion('sqlite_zero_labels', ledger?.labels === 0),
    ];
    const assertions = [...evaluated.assertions, ...ledgerAssertions];
    let reason = evaluated.reason;
    if (evaluated.passed && !ledger) reason = 'sqlite_evidence_unavailable';
    else if (evaluated.passed && !(ledger.runs >= 1)) reason = 'sqlite_run_missing';
    else if (evaluated.passed && !(ledger.readyTaskEvidence >= 1)) reason = 'sqlite_ready_task_evidence_missing';
    else if (evaluated.passed && !(ledger.outcomes >= 1)) reason = 'sqlite_outcome_missing';
    else if (evaluated.passed && !(ledger.succeededOutcomes >= 1)) reason = 'sqlite_succeeded_outcome_missing';
    else if (evaluated.passed && ledger.labels !== 0) reason = 'unexpected_calibration_label';
    const passed = assertions.every(value => value.passed);
    return hostReport(host, testedAt, version.version, adapterVersion, passed ? 'passed' : 'failed', reason, assertions, started);
  } finally { removeTemp(directory, prefix); }
}

const DEEPSEEK_ASSERTIONS = Object.freeze([
  'cordis_plugin_mounted', 'cordis_plugin_unmounted', 'task_ready', 'tool_and_outcome', 'repeat_provider_once',
  'repeat_is_not_tool_retry_protection', 'accepted_failure_recorded', 'cancel_skips_body', 'async_disposal_waited',
  'post_dispose_unobserved', 'caller_kernel_remains_open', 'no_ground_truth_labels',
  'no_observer_errors',
]);
const DEEPSEEK_FAILURES = new Set(['host_package_missing', 'unsupported_host_version', 'host_load_failed', 'probe_assertion_failed', 'probe_execution_failed']);

/** Accept only the bounded child's fixed evidence contract; never echo arbitrary output. */
export function evaluateDeepSeekProbeOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout.trim()); } catch { return null; }
  if (!value || value.schemaVersion !== 1 || value.evidenceLevel !== 'native_tool_pipeline' || value.agentE2E !== false
    || value.classification !== 'synthetic_classification' || !Array.isArray(value.assertions)) return null;
  const version = typeof value.hostVersion === 'string' && /^[0-9A-Za-z.+_-]{1,64}$/.test(value.hostVersion) ? value.hostVersion : 'unknown';
  if (value.status === 'passed' && version === '0.1.2-rc.1' && value.reason === 'native_tool_pipeline_passed'
    && value.assertions.length === DEEPSEEK_ASSERTIONS.length
    && DEEPSEEK_ASSERTIONS.every((name, index) => value.assertions[index]?.name === name && value.assertions[index]?.passed === true)) {
    return { status: 'passed', reason: value.reason, version, assertions: DEEPSEEK_ASSERTIONS.map(name => assertion(name, true)) };
  }
  if (value.status === 'failed' && DEEPSEEK_FAILURES.has(value.reason)) {
    return { status: 'failed', reason: value.reason, version, assertions: DEEPSEEK_ASSERTIONS.map(name => assertion(name, false)) };
  }
  return null;
}

async function runDeepSeekRuntime(options, adapterVersion, testedAt, started) {
  const host = 'deepseek';
  const agentMode = options.deepseekMode === 'agent-cli';
  const requestedLevel = agentMode ? 'cli_agent_loop' : 'native_tool_pipeline';
  const extra = { ...(agentMode ? AGENT_EVIDENCE : { agentE2E: false, classification: 'synthetic_classification' }),
    evidenceLevel: 'none', requestedEvidenceLevel: requestedLevel,
    ...(agentMode ? { agentLoopExercised: false } : {}) };
  const spec = processSpec(options.nodeCommand, options.nodeCommandArgs, 'node', process.env);
  if (!spec) return hostReport(host, testedAt, 'unknown', adapterVersion, 'failed', 'node_command_not_found', [], started, extra);
  const script = agentMode ? 'deepseek-agent-probe.mjs' : 'deepseek-runtime-probe.mjs';
  const child = await runBounded(spec.executable, [...spec.prefixArgs, join(options.repoRoot, 'scripts', script), options.deepseekPackageRoot], {
    cwd: options.repoRoot,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    timeoutMs: options.timeoutMs,
    stdoutLimitBytes: Math.min(options.stdoutLimitBytes, 64 * 1024),
    stderrLimitBytes: options.stderrLimitBytes,
    captureNonzeroStdout: true,
  });
  if (!child.ok && !(child.kind === 'nonzero_exit' && typeof child.stdout === 'string')) {
    return hostReport(host, testedAt, 'unknown', adapterVersion, 'failed', processFailureReason(child), [], started, extra);
  }
  const assessed = agentMode ? evaluateAgentProbeOutput(child.stdout) : evaluateDeepSeekProbeOutput(child.stdout);
  if (!assessed) return hostReport(host, testedAt, 'unknown', adapterVersion, 'failed', 'probe_output_invalid', [], started, extra);
  if (child.ok !== (assessed.status === 'passed')) return hostReport(host, testedAt, 'unknown', adapterVersion, 'failed', 'probe_exit_mismatch', [], started, extra);
  const hostVersion = assessed.version === 'unknown' ? 'unknown' : `DeepSeek Harness ${assessed.version}`;
  return hostReport(host, testedAt, hostVersion, adapterVersion, assessed.status, assessed.reason, assessed.assertions, started,
    { ...extra, evidenceLevel: assessed.status === 'passed' ? requestedLevel : 'none',
      ...(agentMode ? { agentLoopExercised: assessed.status === 'passed' } : {}) });
}

async function runDeepSeek(options, adapterVersion) {
  const host = 'deepseek', testedAt = new Date().toISOString(), started = Date.now();
  if (options.deepseekPackageRoot) return runDeepSeekRuntime(options, adapterVersion, testedAt, started);
  const commands = options.deepseekCommand ? [options.deepseekCommand] : ['dsh', 'deepseek-harness'];
  let spec = null;
  for (const command of commands) {
    spec = processSpec(command, options.deepseekCommandArgs, host, process.env);
    if (spec) break;
  }
  if (!spec) return { ...unavailableReport(host, testedAt, adapterVersion, started), evidenceLevel: 'none', agentE2E: false };
  const version = await discoverVersion(host, spec, options);
  if (!version.ok) return hostReport(host, testedAt, version.version, adapterVersion, 'failed', version.reason, [
    assertion('installation_discovered', true),
    assertion('version_captured', false),
    assertion('e2e_exercised', false),
  ], started, { evidenceLevel: 'none', agentE2E: false });
  return hostReport(host, testedAt, version.version, adapterVersion, 'discovered_not_exercised', 'discovered_not_exercised', [
    assertion('installation_discovered', true),
    assertion('version_captured', version.version !== 'unknown'),
    assertion('e2e_exercised', false),
  ], started, { evidenceLevel: 'version_only', agentE2E: false });
}

function aggregateStatus(results) {
  if (results.length === 1) return results[0].status;
  if (results.some(result => result.status === 'failed')) return 'failed';
  if (results.every(result => result.status === 'passed')) return 'passed';
  return 'partial';
}

/** Run selected probes and return a redacted, serializable report. */
export async function runCompatibilityProbe(options) {
  const started = Date.now();
  const testedAt = new Date().toISOString();
  const adapterVersion = packageVersion(options.repoRoot);
  const selected = options.host === 'all' ? ['codex', 'claude', 'deepseek'] : [options.host];
  const results = [];
  for (const host of selected) {
    if (host === 'codex') results.push(await runCodex(options, adapterVersion));
    else if (host === 'claude') results.push(await runClaude(options, adapterVersion));
    else results.push(await runDeepSeek(options, adapterVersion));
  }
  const status = aggregateStatus(results);
  return {
    schemaVersion: 1,
    testedAt,
    requestedHost: options.host,
    hostVersion: results.length === 1 ? results[0].hostVersion : Object.fromEntries(results.map(result => [result.host, result.hostVersion])),
    adapterVersion,
    status,
    reason: results.length === 1 ? results[0].reason : status === 'passed' ? 'all_selected_probes_passed' : status === 'failed' ? 'one_or_more_probes_failed' : 'selected_probes_partially_exercised',
    assertions: results.flatMap(result => result.assertions.map(value => ({ host: result.host, ...value }))),
    durationMs: Math.max(0, Date.now() - started),
    results,
    ...(results.length === 1 && results[0].host === 'deepseek'
      ? { evidenceLevel: results[0].evidenceLevel, agentE2E: false,
        ...(results[0].classification ? { classification: results[0].classification } : {}),
        ...(Object.hasOwn(results[0], 'agentLoopExercised') ? {
          agentLoopExercised: results[0].agentLoopExercised,
          modelInference: false, modelTransport: 'synthetic_adapter',
        } : {}) }
      : {}),
  };
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  let options;
  try { options = parseArgs(argv); }
  catch {
    output.write(`${JSON.stringify({ schemaVersion: 1, status: 'failed', reason: 'invalid_cli_arguments', assertions: [] })}\n`);
    return 2;
  }
  const report = await runCompatibilityProbe(options);
  output.write(`${JSON.stringify(report)}\n`);
  return ['failed', 'not_discovered'].includes(report.status) ? 1 : 0;
}

if (isDirectRun(import.meta.url)) process.exitCode = await main();
