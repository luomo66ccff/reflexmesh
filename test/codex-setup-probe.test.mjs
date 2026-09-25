import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createCodexSetup } from '../adapters/codex-setup.mjs';
import { parseCodexProbeOptions, verifyNativeCodex } from '../scripts/codex-setup-probe.mjs';

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
  assert.equal(report.nativeCodexRegistration, 'not_requested');
  assert.deepEqual(report.productionMcp, { status: 'passed', processCount: 2, listedTools: 4,
    decisions: 2, outcomeStatus: 'unknown', outcomeProvenance: 'model-reported', labels: 0,
    restartReplay: true, restartConflictRejected: true });
  assert.equal(report.actualCodexAgent, 'not_tested');
  assert.equal(report.modelRequest, 'none');
  assert.equal(result.stdout.includes('SYNTHETIC: Read'), false);
  assert.equal(result.stdout.includes('SYNTHETIC: Different task'), false);
  assert.equal(result.stdout.includes('ledger.sqlite'), false);
});

test('native registration probe confines add/list/get to a disposable home and requires exact matching', async t => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-codex-setup-test-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.equal(dirname(resolved), realpathSync(tmpdir()));
    assert.ok(basename(resolved).startsWith('reflexmesh-codex-setup-test-'));
    rmSync(resolved, { recursive: true, force: false });
  });
  const setup = createCodexSetup({ nodePath: process.execPath, dbPath: join(root, 'ledger.sqlite'),
    tenantId: 'synthetic', scope: 'fixture' });
  let registered = false;
  const calls = [];
  const row = { name: 'reflexmesh-shadow', enabled: true,
    transport: { type: 'stdio', command: setup.command, args: setup.args, env: setup.env,
      env_vars: [], cwd: null } };
  const fakeCli = (executable, argv, options) => {
    assert.equal(executable, process.execPath);
    assert.equal(options.env.CODEX_HOME, join(root, 'codex-home'));
    assert.equal(options.env.HOME, join(root, 'user-home'));
    assert.equal(options.env.USERPROFILE, join(root, 'user-home'));
    assert.equal(options.env.TEMP, root);
    calls.push(argv.slice(0, 2).join(' '));
    if (argv[0] === 'mcp' && argv[1] === 'list')
      return { status: 0, stdout: JSON.stringify(registered ? [row] : []) };
    if (argv[0] === 'mcp' && argv[1] === 'add') {
      assert.deepEqual(argv, setup.registration.args);
      registered = true;
      return { status: 0, stdout: '' };
    }
    if (argv[0] === 'mcp' && argv[1] === 'get')
      return { status: 0, stdout: JSON.stringify(row) };
    throw new Error('unexpected_native_command');
  };
  assert.deepEqual(await verifyNativeCodex(process.execPath, setup, root, fakeCli),
    { config: 'parsed_by_installed_cli', registration: 'isolated_add_list_matching' });
  assert.deepEqual(calls, ['mcp list', 'mcp add', 'mcp list', 'mcp get']);
  assert.equal(existsSync(setup.env.REFLEXMESH_DB), false);
});

test('probe failure is sanitized and cannot invoke an accidental model', () => {
  const result = run(['--codex-executable', process.execPath]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /probe failed/);
  assert.equal(result.stderr.includes('SYNTHETIC: Read'), false);
});
