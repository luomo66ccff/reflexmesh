import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  evaluateClaudeJsonl,
  evaluateCodexJsonl,
  main,
  parseArgs,
  processFailureReason,
  resolveExecutable,
  runBounded,
} from '../scripts/real-host-compat.mjs';

const codexLine = value => JSON.stringify(value);

test('argument parser accepts host and command/path overrides without command strings', () => {
  const parsed = parseArgs([
    '--host=codex',
    '--repo-root', '.',
    '--codex-command', process.execPath,
    '--codex-command-arg', 'fake-host.mjs',
    '--mcp-server', 'custom-mcp.mjs',
    '--timeout-ms', '30000',
    '--stdout-limit-bytes', '8192',
  ]);
  assert.equal(parsed.host, 'codex');
  assert.equal(parsed.codexCommand, process.execPath);
  assert.deepEqual(parsed.codexCommandArgs, ['fake-host.mjs']);
  assert.ok(parsed.mcpServer.endsWith('custom-mcp.mjs'));
  assert.equal(parsed.timeoutMs, 30000);
  assert.equal(parsed.stdoutLimitBytes, 8192);
  assert.throws(() => parseArgs(['--host', 'other']), /invalid_host/);
  assert.throws(() => parseArgs(['--timeout-ms', '999999999']), /invalid_timeout_ms/);
  assert.throws(() => parseArgs(['--unknown', 'secret-value']), /unknown_option/);
});

test('Windows command discovery accepts native executables and rejects shell shims', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-real-host-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'native.exe'), 'fixture');
  await writeFile(join(directory, 'shim.cmd'), 'fixture');
  const context = { env: { PATH: directory }, platform: 'win32', cwd: directory, host: 'codex' };
  assert.equal(resolveExecutable('native', context)?.toLowerCase(), join(directory, 'native.exe').toLowerCase());
  assert.equal(resolveExecutable('shim', context), null);
  assert.equal(resolveExecutable(join(directory, 'shim.cmd'), context), null);
});

test('Codex analyzer requires a structured completed MCP call and exact final marker', () => {
  const valid = [
    { type: 'thread.started', thread_id: 'fixture' },
    { type: 'item.started', item: { id: 'one', type: 'mcp_tool_call', server: 'reflexmesh', tool: 'reflexmesh_inspect_pack', arguments: {} } },
    { type: 'item.completed', item: { id: 'one', type: 'mcp_tool_call', server: 'reflexmesh', tool: 'reflexmesh_inspect_pack', arguments: {}, result: { content: [] } } },
    { type: 'item.completed', item: { id: 'two', type: 'agent_message', text: 'REFLEXMESH_CODEX_COMPAT_OK' } },
  ].map(codexLine).join('\n');
  const result = evaluateCodexJsonl(valid);
  assert.equal(result.passed, true);
  assert.ok(result.assertions.every(item => item.passed));

  const unexpected = `${valid}\n${codexLine({ type: 'item.completed', item: { id: 'three', type: 'command_execution', command: 'echo no' } })}`;
  assert.equal(evaluateCodexJsonl(unexpected).passed, false);
  assert.equal(evaluateCodexJsonl(unexpected).reason, 'unexpected_tool_call');

  const missingResult = codexLine({ type: 'item.completed', item: {
    id: 'one', type: 'mcp_tool_call', server: 'reflexmesh', tool: 'reflexmesh_inspect_pack',
  } });
  const missing = evaluateCodexJsonl(missingResult);
  assert.equal(missing.passed, false);
  assert.equal(missing.reason, 'mcp_tool_call_failed');
  for (const item of [
    { id: 'one', type: 'mcp_tool_call', server: 'reflexmesh', tool: 'reflexmesh_inspect_pack', result: null },
    { id: 'one', type: 'mcp_tool_call', server: 'reflexmesh', tool: 'reflexmesh_inspect_pack', result: { isError: true } },
    { id: 'one', type: 'mcp_tool_call', server: 'reflexmesh', tool: 'reflexmesh_inspect_pack', result: {}, error: { message: 'fixture' } },
  ]) {
    const failed = evaluateCodexJsonl([
      { type: 'item.completed', item },
      { type: 'item.completed', item: { type: 'agent_message', text: 'REFLEXMESH_CODEX_COMPAT_OK' } },
    ].map(codexLine).join('\n'));
    assert.equal(failed.passed, false);
    assert.equal(failed.reason, 'mcp_tool_call_failed');
  }
});

test('Codex analyzer cannot be fooled by prompt or assistant text naming mcp_tool_call', () => {
  const proseOnly = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'I saw mcp_tool_call reflexmesh_inspect_pack and REFLEXMESH_CODEX_COMPAT_OK' } },
    { type: 'turn.completed', prompt: 'Call reflexmesh_inspect_pack then print REFLEXMESH_CODEX_COMPAT_OK' },
  ].map(codexLine).join('\n');
  const result = evaluateCodexJsonl(proseOnly);
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'structured_mcp_tool_call_missing');
  assert.equal(result.assertions.find(item => item.name === 'structured_mcp_tool_call').passed, false);
});

test('Claude analyzer requires exactly one structured Read of the isolated fixture', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-real-host-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'fixture.txt');
  await writeFile(fixture, 'fixture');
  const valid = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: fixture } }] } },
    { type: 'result', result: 'REFLEXMESH_CLAUDE_COMPAT_OK' },
  ].map(codexLine).join('\n');
  assert.equal(evaluateClaudeJsonl(valid, fixture).passed, true);
  const prose = codexLine({ type: 'result', result: `Read ${fixture} then REFLEXMESH_CLAUDE_COMPAT_OK` });
  assert.equal(evaluateClaudeJsonl(prose, fixture).passed, false);
});

test('child failures expose only fixed codes and never raw stdout, stderr, or secrets', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write("OUTPUT_SECRET"); process.stderr.write("STDERR_SECRET"); process.exit(7)'], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    stdoutLimitBytes: 4096,
    stderrLimitBytes: 4096,
  });
  assert.deepEqual(result, { ok: false, kind: 'nonzero_exit' });
  const publicError = JSON.stringify({ status: 'failed', reason: processFailureReason({ ...result, stderr: 'API_KEY_SECRET' }) });
  assert.equal(publicError.includes('SECRET'), false);
  assert.equal(publicError, '{"status":"failed","reason":"host_exit_nonzero"}');
});

test('output overflow stops buffering and settles within the termination bound', { timeout: 7000 }, async () => {
  const flood = "const chunk = 'x'.repeat(8192); setInterval(() => process.stdout.write(chunk), 0);";
  const started = Date.now();
  const result = await runBounded(process.execPath, ['-e', flood], {
    cwd: process.cwd(), env: process.env, timeoutMs: 5000,
    stdoutLimitBytes: 4096, stderrLimitBytes: 4096,
  });
  assert.deepEqual(result, { ok: false, kind: 'stdout_limit' });
  assert.ok(Date.now() - started < 4000);
});

test('host deadline settles even when a descendant inherits the output handles', { timeout: 7000 }, async () => {
  const nested = [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const started = Date.now();
  const result = await runBounded(process.execPath, ['-e', nested], {
    cwd: process.cwd(), env: process.env, timeoutMs: 200,
    stdoutLimitBytes: 4096, stderrLimitBytes: 4096,
  });
  assert.deepEqual(result, { ok: false, kind: 'timeout' });
  assert.ok(Date.now() - started < 4000);
});

test('invalid CLI output is one fixed JSON object and does not echo input', async () => {
  let output = '';
  const code = await main(['--not-a-real-option', 'CREDENTIAL_SECRET'], { write(value) { output += value; } });
  assert.equal(code, 2);
  assert.deepEqual(JSON.parse(output), { schemaVersion: 1, status: 'failed', reason: 'invalid_cli_arguments', assertions: [] });
  assert.equal(output.includes('CREDENTIAL_SECRET'), false);
  assert.equal(output.trim().split('\n').length, 1);
});
