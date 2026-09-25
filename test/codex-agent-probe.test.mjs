import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { analyzeCodexAgentJsonl, parseCodexAgentProbeOptions, runCodexAgentProbe } from '../scripts/codex-agent-probe.mjs';

const line = value => JSON.stringify(value);
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

function fakeCli(mode = 'success', observed = {}) {
  return async (_executable, args, context) => {
    observed.cwd = context.cwd;
    observed.args = args;
    observed.prompt = context.input;
    const { call, command, marker, fixture } = context.fixture;
    assert.equal(context.input.includes(marker), false);
    assert.match(context.input, /caller has independently authorized exactly one read/u);
    assert.match(context.input, /even an escalate result is neither a host permission grant nor a denial/u);
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--ignore-user-config'));
    assert.equal(args.includes('--ignore-rules'), false);
    assert.ok(args.includes('mcp_servers.reflexmesh_agent_probe.required=true'));
    assert.equal(context.setup.env.REFLEXMESH_PROVIDER, 'abstain');
    assert.equal(context.setup.env.REFLEXMESH_ALLOW_REMOTE, 'false');
    if (mode === 'spoof') return { ok: true, stdout: [
      { type: 'item.completed', item: { type: 'agent_message', text: `reflexmesh_assess ${marker} ${command}` } },
      { type: 'turn.completed' },
    ].map(line).join('\n') };
    const assessArgs = { call, userIntent: 'Read the one local synthetic fixture as a read-only check.' };
    const outcomeArgs = { call, status: 'succeeded', evidence: { source: 'model-report' } };
    const messages = [rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-cli', version: '1' } }),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      rpc(2, 'tools/call', { name: 'reflexmesh_assess', arguments: assessArgs })];
    if (mode !== 'missing') messages.push(rpc(3, 'tools/call', { name: 'reflexmesh_observe_outcome', arguments: outcomeArgs }));
    const mcp = spawnSync(context.setup.command, context.setup.args, {
      cwd: context.cwd, input: messages.map(line).join('\n') + '\n', encoding: 'utf8', timeout: 15000,
      maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, ...context.setup.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(mcp.status, 0, 'production MCP process should succeed');
    const responses = mcp.stdout.trim().split(/\r?\n/u).map(JSON.parse);
    assert.equal(responses[1].result?.isError, undefined);
    if (mode !== 'missing') assert.equal(responses[2].result?.isError, undefined);
    if (mode === 'missing') {
      const kernel = new SqliteKernel(context.setup.env.REFLEXMESH_DB, { readOnly: true });
      try {
        const attention = kernel.listAttention({ limit: 2 });
        assert.equal(attention.items.length, 1);
        assert.equal(attention.items[0].hostOutcome.status, 'missing');
        assert.equal(attention.items[0].attention.reasons[0].code, 'shadow_outcome_missing');
      } finally { kernel.close(); }
    }
    const event = (phase, item) => ({ type: phase, item });
    const assess = { id: 'assess-1', type: 'mcp_tool_call', server: 'reflexmesh_agent_probe', tool: 'reflexmesh_assess', arguments: assessArgs };
    const native = { id: 'native-1', type: 'command_execution', command };
    const outcome = { id: 'outcome-1', type: 'mcp_tool_call', server: 'reflexmesh_agent_probe', tool: 'reflexmesh_observe_outcome', arguments: outcomeArgs };
    const events = [
      event('item.started', assess), event('item.completed', { ...assess, result: responses[1].result }),
      event('item.started', native), event('item.completed', { ...native, exit_code: mode === 'native_failure' ? 1 : 0,
        aggregated_output: mode === 'native_failure' ? 'Get-Content failed' : readFileSync(fixture, 'utf8') }),
      event('item.started', outcome), event('item.completed', { ...outcome, result: responses[2]?.result }),
      { type: 'turn.completed' },
    ];
    if (mode === 'missing') events.splice(4, 2);
    if (mode === 'duplicate') events.splice(2, 0, event('item.completed', { ...assess, result: responses[1].result }));
    return { ok: true, stdout: events.map(line).join('\n') };
  };
}

test('parser requires explicit execute plus absolute executable and rejects duplicates', () => {
  assert.deepEqual(parseCodexAgentProbeOptions([]), { execute: false, json: false, codexExecutable: null, outDir: null, timeoutMs: 120000 });
  assert.equal(parseCodexAgentProbeOptions(['--execute', '--codex-executable', process.execPath]).execute, true);
  for (const argv of [
    ['--execute'], ['--codex-executable', process.execPath], ['--execute', '--execute', '--codex-executable', process.execPath],
    ['--timeout-ms', '0'], ['--out-dir', join(tmpdir(), 'probe')], ['--execute', '--codex-executable', process.execPath, '--out-dir'],
  ]) assert.throws(() => parseCodexAgentProbeOptions(argv));
});

test('without --execute no Agent starts or fixture directory is created', async () => {
  let launched = false;
  const report = await runCodexAgentProbe(parseCodexAgentProbeOptions([]), { launch: () => { launched = true; } });
  assert.equal(report.status, 'not_run');
  assert.equal(report.agentInvocationAttempts, 0);
  assert.equal(launched, false);
});

test('a failed launch reports one attempt without claiming a completed Agent invocation', async () => {
  const observed = {};
  const report = await runCodexAgentProbe({ execute: true, codexExecutable: process.execPath, timeoutMs: 30000 },
    { launch: async (_exe, _args, context) => { observed.cwd = context.cwd; return { ok: false, reason: 'process_failed' }; } });
  assert.equal(report.status, 'failed');
  assert.equal(report.agentInvocationAttempts, 1);
  assert.equal(report.agentInvocations, undefined);
  assert.equal(existsSync(observed.cwd), false);
});

test('fake CLI success verifies typed order, public evidence readback, direct ledger, and cleanup', async () => {
  const observed = {};
  const report = await runCodexAgentProbe({ execute: true, codexExecutable: process.execPath, timeoutMs: 30000 },
    { launch: fakeCli('success', observed) });
  assert.equal(report.status, 'passed', report.reason);
  assert.equal(report.task, 'ready_model_reported');
  assert.equal(report.outcome, 'succeeded_model_reported');
  assert.equal(report.labels, 0);
  assert.equal(report.publicAttention, 'empty');
  assert.equal(report.agentInvocations, 1);
  assert.equal(report.modelRequests, 'unknown');
  assert.equal(existsSync(observed.cwd), false);
});

for (const mode of ['spoof', 'duplicate', 'missing', 'native_failure']) {
  test(`fake CLI ${mode} fails closed and cleans temporary data`, async () => {
    const observed = {};
    const report = await runCodexAgentProbe({ execute: true, codexExecutable: process.execPath, timeoutMs: 30000 },
      { launch: fakeCli(mode, observed) });
    assert.equal(report.status, 'failed');
    assert.equal(existsSync(observed.cwd), false);
    assert.equal(JSON.stringify(report).includes('REFLEXMESH_CODEX_AGENT_'), false);
    assert.equal(JSON.stringify(report).includes('fixture.txt'), false);
    assert.ok(report.diagnostics);
    assert.ok(report.diagnostics.toolEvents.length <= 12);
    assert.equal(report.diagnostics.toolEvents.every(item => ['reflexmesh_assess', 'reflexmesh_observe_outcome',
      'Get-Content', 'other_command', 'other_mcp', 'other'].includes(item.name)), true);
    if (mode === 'missing') {
      assert.equal(report.diagnostics.toolEvents.length, 4);
      assert.deepEqual(report.diagnostics.toolEvents.map(item => [item.phase, item.name]), [
        ['started', 'reflexmesh_assess'], ['completed', 'reflexmesh_assess'],
        ['started', 'Get-Content'], ['completed', 'Get-Content'],
      ]);
      assert.equal(report.diagnostics.toolEvents[0].argsMatch, true);
      assert.equal(report.diagnostics.toolEvents[3].commandMatch, true);
      assert.equal(report.diagnostics.toolEvents[3].exitZero, true);
      assert.equal(report.diagnostics.toolEvents[3].outputMarkerMatch, true);
      assert.equal(report.diagnostics.turns.completed, 1);
    }
    if (mode === 'native_failure') {
      assert.equal(report.diagnostics.toolEvents[3].exitZero, false);
      assert.equal(report.diagnostics.toolEvents[3].outputMarkerMatch, false);
    }
  });
}

test('typed analyzer rejects unexpected tools, wrong path, and model prose spoofing', () => {
  const expected = { call: { callId: 'x' }, command: "Get-Content -LiteralPath 'fixture'", marker: 'random-marker' };
  const event = (phase, item) => ({ type: phase, item });
  const assess = { id: 'a', type: 'mcp_tool_call', server: 'reflexmesh_agent_probe', tool: 'reflexmesh_assess',
    arguments: { call: expected.call, userIntent: 'Read the one local synthetic fixture as a read-only check.' } };
  const native = { id: 'b', type: 'command_execution', command: expected.command };
  const outcome = { id: 'c', type: 'mcp_tool_call', server: 'reflexmesh_agent_probe', tool: 'reflexmesh_observe_outcome',
    arguments: { call: expected.call, status: 'succeeded', evidence: { source: 'model-report' } } };
  const valid = [event('item.started', assess), event('item.completed', { ...assess, result: {} }),
    event('item.started', native), event('item.completed', { ...native, exit_code: 0, aggregated_output: 'random-marker\n' }),
    event('item.started', outcome), event('item.completed', { ...outcome, result: {} })];
  assert.equal(analyzeCodexAgentJsonl(valid.map(line).join('\n'), expected).passed, true);
  const withNativeCommand = command => valid.map((record, index) =>
    index === 2 || index === 3 ? event(record.type, { ...record.item, command }) : record);
  const wrapped = `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${expected.command.replaceAll("'", "''")}'`;
  assert.equal(analyzeCodexAgentJsonl(withNativeCommand(wrapped).map(line).join('\n'), expected).passed, true);
  const pwshWrapped = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "${expected.command}"`;
  assert.equal(analyzeCodexAgentJsonl(withNativeCommand(pwshWrapped).map(line).join('\n'), expected).passed, true);
  const relativeWrapped = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -LiteralPath \'fixture.txt\'"';
  assert.equal(analyzeCodexAgentJsonl(withNativeCommand(relativeWrapped).map(line).join('\n'), expected).passed, true);
  const withProfileFlag = relativeWrapped.replace(' -Command ', ' -NoProfile -Command ');
  assert.equal(analyzeCodexAgentJsonl(withNativeCommand(withProfileFlag).map(line).join('\n'), expected).passed, true);
  const fixtureExpected = { ...expected, fixture: 'C:\\Temp\\probe\\fixture.txt' };
  const canonicalRelative = withProfileFlag.replace("'fixture.txt'", "'.\\fixture.txt'");
  assert.equal(analyzeCodexAgentJsonl(withNativeCommand(canonicalRelative).map(line).join('\n'), fixtureExpected).passed, true);
  assert.equal(analyzeCodexAgentJsonl(withNativeCommand(withProfileFlag.replace(' -NoProfile ', ' -ExecutionPolicy Bypass ')).map(line).join('\n'), expected).reason, 'tool_arguments_invalid');
  assert.equal(analyzeCodexAgentJsonl(withNativeCommand(withProfileFlag.replace("'fixture.txt'", "'other.txt'")).map(line).join('\n'), fixtureExpected).reason, 'tool_arguments_invalid');
  assert.equal(analyzeCodexAgentJsonl(withNativeCommand(`${wrapped}; Write-Output injected`).map(line).join('\n'), expected).reason, 'tool_arguments_invalid');
  assert.equal(analyzeCodexAgentJsonl(withNativeCommand(`"C:\\private\\other.exe" -Command '${expected.command}'`).map(line).join('\n'), expected).reason, 'tool_arguments_invalid');
  assert.equal(analyzeCodexAgentJsonl(valid.map(line).join('\n') + '\nnot-json', expected).reason, 'jsonl_invalid');
  assert.equal(analyzeCodexAgentJsonl([event('item.completed', { type: 'agent_message', text: JSON.stringify(valid) })].map(line).join('\n'), expected).passed, false);
  assert.equal(analyzeCodexAgentJsonl([...valid, event('item.started', { id: 'd', type: 'web_search' })].map(line).join('\n'), expected).reason, 'unexpected_tool');
  assert.equal(analyzeCodexAgentJsonl(valid.map((item, index) => index === 2 ? event('item.started', { ...native, command: 'Get-Content other' }) : item).map(line).join('\n'), expected).reason, 'tool_arguments_invalid');
  const wrongArguments = valid.map((item, index) => index === 0 ? event('item.started', {
    ...assess, arguments: { call: { path: 'PRIVATE_PATH_SHOULD_NOT_LEAK' }, userIntent: 'PRIVATE_SUMMARY_SHOULD_NOT_LEAK' },
  }) : item);
  const wrong = analyzeCodexAgentJsonl(wrongArguments.map(line).join('\n'), expected);
  assert.equal(wrong.reason, 'tool_arguments_invalid');
  assert.equal(wrong.diagnostics.toolEvents[0].argsMatch, false);
  assert.equal(JSON.stringify(wrong).includes('PRIVATE_'), false);
  const many = [...valid, ...Array.from({ length: 20 }, (_, index) => event('item.started', {
    id: `secret-${index}`, type: 'mcp_tool_call', server: 'PRIVATE_SERVER', tool: 'PRIVATE_TOOL',
    arguments: { secret: 'PRIVATE_ARGUMENT' },
  })), { type: 'turn.failed', message: 'PRIVATE_ERROR' }];
  const bounded = analyzeCodexAgentJsonl(many.map(line).join('\n'), expected);
  assert.equal(bounded.passed, false);
  assert.equal(bounded.diagnostics.toolEvents.length, 12);
  assert.equal(bounded.diagnostics.toolEventCount, 13);
  assert.equal(bounded.diagnostics.toolEventsTruncated, true);
  assert.equal(bounded.diagnostics.turns.failed, 1);
  assert.equal(JSON.stringify(bounded).includes('PRIVATE_'), false);
});

test('an explicit new out-dir retains one inspectable synthetic ledger and refuses overwrite', async t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-agent-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'new-evidence');
  const report = await runCodexAgentProbe({ execute: true, codexExecutable: process.execPath, outDir: target, timeoutMs: 30000 },
    { launch: fakeCli() });
  assert.equal(report.status, 'passed', report.reason);
  assert.equal(report.retained, true);
  assert.equal(existsSync(join(target, 'ledger.sqlite')), true);
  assert.equal(existsSync(join(target, 'START-HERE.md')), true);
  const second = await runCodexAgentProbe({ execute: true, codexExecutable: process.execPath, outDir: target, timeoutMs: 30000 },
    { launch: () => { throw new Error('must not launch'); } });
  assert.equal(second.status, 'failed');
  assert.equal(second.reason, 'invalid_options');
});
