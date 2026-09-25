import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseCodexProbeOptions } from '../scripts/codex-setup-probe.mjs';

const run = args => spawnSync(process.execPath, ['scripts/codex-setup-probe.mjs', ...args], {
  encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
});

test('Codex setup probe accepts only bounded explicit options', () => {
  assert.deepEqual(parseCodexProbeOptions([]), { json: false, codexExecutable: null });
  assert.deepEqual(parseCodexProbeOptions(['--help']), { help: true });
  for (const args of [['--json', '--json'], ['--codex-executable'], ['--codex-executable', '--json'],
    ['--bogus'], ['--help', '--json']]) assert.throws(() => parseCodexProbeOptions(args));
});

test('production Codex MCP setup probe reopens synthetic evidence with zero labels and no Agent', () => {
  const result = run(['--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind, 'codex_setup_probe');
  assert.equal(report.status, 'passed');
  assert.equal(report.nativeCodexConfig, 'not_requested');
  assert.deepEqual(report.productionMcp, { status: 'passed', processCount: 2, listedTools: 4,
    decisions: 2, outcomeStatus: 'unknown', outcomeProvenance: 'model-reported', labels: 0,
    restartReplay: true, restartConflictRejected: true });
  assert.equal(report.actualCodexAgent, 'not_tested');
  assert.equal(report.modelRequest, 'none');
  assert.equal(result.stdout.includes('SYNTHETIC: Read'), false);
  assert.equal(result.stdout.includes('SYNTHETIC: Different task'), false);
  assert.equal(result.stdout.includes('ledger.sqlite'), false);
});

test('probe failure is sanitized and cannot invoke an accidental model', () => {
  const result = run(['--codex-executable', process.execPath]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /probe failed/);
  assert.equal(result.stderr.includes('SYNTHETIC: Read'), false);
});
