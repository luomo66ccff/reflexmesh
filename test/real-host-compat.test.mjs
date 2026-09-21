import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT_ASSERTIONS, AGENT_EVIDENCE, evaluateAgentProbeOutput } from '../scripts/deepseek-agent-contract.mjs';
import {
  evaluateClaudeJsonl,
  evaluateCodexJsonl,
  evaluateDeepSeekProbeOutput,
  main,
  parseArgs,
  processFailureReason,
  resolveExecutable,
  runBounded,
  runCompatibilityProbe,
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
  const deepseek = parseArgs(['--host', 'deepseek', '--deepseek-package-root', '.']);
  assert.equal(deepseek.deepseekPackageRoot, process.cwd());
  assert.equal(parseArgs(['--host', 'deepseek']).deepseekPackageRoot, null);
  assert.equal(parseArgs(['--host', 'deepseek']).deepseekMode, 'native');
  assert.equal(parseArgs(['--host', 'deepseek', '--deepseek-mode', 'agent-cli', '--deepseek-package-root', '.']).deepseekMode, 'agent-cli');
  assert.equal(parseArgs(['--host', 'deepseek', '--deepseek-mode', 'lifecycle-matrix', '--deepseek-package-root', '.']).deepseekMode,
    'lifecycle-matrix');
  assert.equal(parseArgs(['--host', 'deepseek', '--deepseek-mode', 'subagent-isolation', '--deepseek-package-root', '.']).deepseekMode,
    'subagent-isolation');
  assert.throws(() => parseArgs(['--deepseek-mode', 'agent-cli']), /deepseek_package_root_required/);
  assert.throws(() => parseArgs(['--deepseek-mode', 'lifecycle-matrix']), /deepseek_package_root_required/);
  assert.throws(() => parseArgs(['--deepseek-mode', 'subagent-isolation']), /deepseek_package_root_required/);
  assert.throws(() => parseArgs(['--deepseek-mode', 'guess']), /invalid_deepseek_mode/);
  assert.throws(() => parseArgs(['--host', 'other']), /invalid_host/);
  assert.throws(() => parseArgs(['--timeout-ms', '999999999']), /invalid_timeout_ms/);
  assert.throws(() => parseArgs(['--unknown', 'secret-value']), /unknown_option/);
});

test('DeepSeek runtime evidence parser rejects claims without exact native pipeline assertions', () => {
  const names = [
    'cordis_plugin_mounted', 'cordis_plugin_unmounted', 'task_ready', 'tool_and_outcome', 'repeat_provider_once',
    'repeat_is_not_tool_retry_protection', 'accepted_failure_recorded', 'cancel_skips_body', 'async_disposal_waited',
    'post_dispose_unobserved', 'caller_kernel_remains_open', 'no_ground_truth_labels',
    'no_observer_errors',
  ];
  const report = { schemaVersion: 1, evidenceLevel: 'native_tool_pipeline', agentE2E: false,
    classification: 'synthetic_classification', hostVersion: '0.1.2-rc.1', status: 'passed',
    reason: 'native_tool_pipeline_passed', assertions: names.map(name => ({ name, passed: true })) };
  const assessed = evaluateDeepSeekProbeOutput(JSON.stringify({ ...report,
    assertions: report.assertions.map(item => ({ ...item, extra: 'DO_NOT_FORWARD' })) }));
  assert.equal(assessed?.status, 'passed');
  assert.equal(JSON.stringify(assessed).includes('DO_NOT_FORWARD'), false);
  assert.equal(evaluateDeepSeekProbeOutput(JSON.stringify({ ...report, agentE2E: true })), null);
  assert.equal(evaluateDeepSeekProbeOutput(JSON.stringify({ ...report, assertions: report.assertions.slice(1) })), null);
  assert.equal(evaluateDeepSeekProbeOutput(JSON.stringify({ ...report, assertions: report.assertions.map((item, i) => i === 5 ? { ...item, passed: false } : item) })), null);
  assert.equal(evaluateDeepSeekProbeOutput('not-json'), null);
});

test('CLI Agent-loop receipt cannot claim real inference or forward unverified child fields', () => {
  const report = { schemaVersion: 1, ...AGENT_EVIDENCE, agentLoopExercised: true,
    hostVersion: '0.1.2-rc.1', status: 'passed', reason: 'cli_agent_loop_passed',
    assertions: AGENT_ASSERTIONS.map(name => ({ name, passed: true, debug: 'DO_NOT_FORWARD' })),
    rawPrompt: 'DO_NOT_FORWARD',
  };
  const assessed = evaluateAgentProbeOutput(JSON.stringify(report));
  assert.equal(assessed.status, 'passed');
  assert.equal(JSON.stringify(assessed).includes('DO_NOT_FORWARD'), false);
  for (const replacement of [
    { agentE2E: true }, { modelInference: true }, { agentLoopExercised: false },
    { classification: 'calibrated' }, { modelTransport: 'real_model' },
    { evidenceLevel: 'native_tool_pipeline' }, { hostVersion: '0.1.3' },
    { assertions: report.assertions.slice(1) },
    { assertions: [...report.assertions, { name: 'extra', passed: true }] },
    { assertions: report.assertions.map((item, i) => i === 3 ? { ...item, passed: false } : item) },
  ]) assert.equal(evaluateAgentProbeOutput(JSON.stringify({ ...report, ...replacement })), null);
  assert.equal(evaluateAgentProbeOutput('not-json'), null);
  assert.equal(evaluateAgentProbeOutput(JSON.stringify({ ...report, status: 'failed', reason: 'PRIVATE_ERROR' })), null);
  const failed = evaluateAgentProbeOutput(JSON.stringify({ ...report, status: 'failed', reason: 'agent_loop_failed' }));
  assert.equal(failed.status, 'failed');
  assert.ok(failed.assertions.every(item => item.passed === false));
  assert.equal(evaluateAgentProbeOutput(JSON.stringify({ ...report, status: 'failed', reason: 'host_load_failed',
    hostVersion: 'DO_NOT_FORWARD' })).version, 'unknown');
});

test('DeepSeek opt-in fails clearly for absent package without discovering or starting a model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-deepseek-absent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = parseArgs(['--host', 'deepseek', '--deepseek-package-root', join(directory, 'missing'), '--node-command', process.execPath]);
  const report = await runCompatibilityProbe(options);
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'host_package_missing');
  assert.equal(report.evidenceLevel, 'none');
  assert.equal(report.agentE2E, false);
  assert.equal(report.results[0].requestedEvidenceLevel, 'native_tool_pipeline');
  const script = fileURLToPath(new URL('../scripts/deepseek-runtime-probe.mjs', import.meta.url));
  const standalone = spawnSync(process.execPath, [script, join(directory, 'missing')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(standalone.status, 1);
  assert.equal(JSON.parse(standalone.stdout).reason, 'host_package_missing');
});

test('Agent CLI mode keeps fixed missing-package diagnostics without a model claim', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-agent-package-absent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runCompatibilityProbe(parseArgs(['--host', 'deepseek', '--deepseek-mode', 'agent-cli',
    '--deepseek-package-root', join(directory, 'missing'), '--node-command', process.execPath]));
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'host_package_missing');
  assert.equal(report.evidenceLevel, 'none');
  assert.equal(report.results[0].requestedEvidenceLevel, 'cli_agent_loop');
  assert.equal(report.agentLoopExercised, false);
  assert.equal(report.agentE2E, false);
  assert.equal(report.modelInference, false);
  assert.equal(report.classification, 'abstain');
});

test('synthetic Agent receipt transport requires exit/status consistency and strips private fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-agent-receipt-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'synthetic-receipt.mjs');
  const receipt = { schemaVersion: 1, ...AGENT_EVIDENCE, agentLoopExercised: true,
    hostVersion: '0.1.2-rc.1', status: 'passed', reason: 'cli_agent_loop_passed',
    assertions: AGENT_ASSERTIONS.map(name => ({ name, passed: true })), private: 'DO_NOT_FORWARD' };
  const options = () => parseArgs(['--host', 'deepseek', '--deepseek-mode', 'agent-cli',
    '--deepseek-package-root', directory, '--node-command', process.execPath, '--node-command-arg', path]);
  // These are transport fixtures, not evidence that an installed Agent ran.
  for (const [value, exitCode, expected] of [
    [receipt, 0, 'cli_agent_loop_passed'], [receipt, 1, 'probe_exit_mismatch'],
    [{ ...receipt, status: 'failed', reason: 'agent_loop_failed' }, 1, 'agent_loop_failed'],
    [{ ...receipt, modelInference: true }, 0, 'probe_output_invalid'],
  ]) {
    await writeFile(path, `process.stdout.write(${JSON.stringify(JSON.stringify(value))}); process.exitCode=${exitCode};`);
    const report = await runCompatibilityProbe(options());
    assert.equal(report.reason, expected);
    assert.equal(report.agentE2E, false);
    assert.equal(report.modelInference, false);
    assert.equal(JSON.stringify(report).includes('DO_NOT_FORWARD'), false);
    if (expected !== 'cli_agent_loop_passed') assert.equal(report.evidenceLevel, 'none');
  }
});

test('DeepSeek opt-in rejects an unsupported package version before loading modules', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-deepseek-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scope = join(directory, '@deepseek-ai');
  for (const [folder, name, version] of [
    ['dsh', '@deepseek-ai/dsh', '9.0.0'],
    ['dsh-tools', '@deepseek-ai/dsh-tools', '0.1.2-rc.1'],
    ['dsh-system-prompt', '@deepseek-ai/dsh-system-prompt', '0.1.2-rc.1'],
    ['cordis', '@deepseek-ai/cordis', '4.0.2'],
  ]) {
    const target = join(scope, folder);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'package.json'), JSON.stringify({ name, version }));
  }
  const options = parseArgs(['--host', 'deepseek', '--deepseek-package-root', join(scope, 'dsh'), '--node-command', process.execPath]);
  const report = await runCompatibilityProbe(options);
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'unsupported_host_version');
  assert.equal(report.hostVersion, 'DeepSeek Harness 9.0.0');
  assert.equal(report.evidenceLevel, 'none');
});

test('DeepSeek without package-root preserves version-only discovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rm-deepseek-version-only-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = join(directory, 'fake-dsh.mjs');
  await writeFile(fake, "process.stdout.write('dsh 0.1.2-rc.1\\n');\n");
  const options = parseArgs(['--host', 'deepseek', '--deepseek-command', process.execPath,
    '--deepseek-command-arg', fake]);
  const report = await runCompatibilityProbe(options);
  assert.equal(report.status, 'discovered_not_exercised');
  assert.equal(report.evidenceLevel, 'version_only');
  assert.equal(report.agentE2E, false);
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
