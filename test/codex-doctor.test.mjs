import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { codexDoctorMain } from '../adapters/codex-doctor-cli.mjs';
import { diagnoseCodexDoctor, formatCodexDoctor, parseCodexDoctorOptions } from '../adapters/codex-doctor.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const codes = report => report.diagnostics.map(item => item.code);
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-codex-doctor-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-codex-doctor-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { root, db: join(root, 'ledger.sqlite') };
}
const args = w => ['--node-executable', process.execPath, '--db', w.db,
  '--tenant', 'synthetic', '--scope', 'fixture'];

test('help and missing arguments do no host, profile or database discovery', async t => {
  const w = workspace(t);
  assert.deepEqual(parseCodexDoctorOptions(['--help']), { help: true });
  const output = { value: '', write(value) { this.value += value; } };
  assert.equal(await codexDoctorMain(['--help'], output), 0);
  assert.match(output.value, /read-only/u);
  let opens = 0;
  const result = await diagnoseCodexDoctor([], {
    openKernel: async () => { opens++; throw new Error('unexpected'); },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.report).filter(code => code.startsWith('missing_')),
    ['missing_executable', 'missing_db', 'missing_tenant', 'missing_scope']);
  assert.equal(result.report.liveHost, 'live_host_unverified');
  assert.equal(opens, 0);
  assert.equal(existsSync(w.db), false);
});

test('explicit executable and missing database give a reviewable, abstaining fragment without writes', async t => {
  const w = workspace(t);
  const result = await diagnoseCodexDoctor(args(w));
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, 'prerequisites_ready');
  assert.equal(result.report.prerequisites.executable.status, 'explicit_file_present');
  assert.equal(result.report.prerequisites.executable.version, 'unverified');
  assert.equal(result.report.prerequisites.database, 'not_created');
  assert.equal(result.report.liveHost, 'live_host_unverified');
  assert.equal(result.report.setup.env.REFLEXMESH_PROVIDER, 'abstain');
  assert.equal(result.report.setup.env.REFLEXMESH_ALLOW_REMOTE, 'false');
  assert.match(result.report.setup.toml, /\[mcp_servers\.reflexmesh-shadow\]/u);
  assert.equal(existsSync(w.db), false);
  assert.deepEqual(lstatSync(w.root).isDirectory(), true);
});

test('bad paths and malformed options use bounded errors and never echo hostile values', async t => {
  const w = workspace(t);
  for (const argv of [
    ['--unknown-SECRET', 'PRIVATE_VALUE', '--json'],
    ['--tenant', 'PRIVATE_FIRST', '--tenant', 'PRIVATE_SECOND', '--json'],
    ['--help', '--json', 'PRIVATE_MIXED'],
  ]) {
    const output = { value: '', write(value) { this.value += value; } };
    assert.equal(await codexDoctorMain(argv, output), 1);
    assert.equal(output.value.includes('PRIVATE_'), false);
    assert.equal(JSON.parse(output.value).setup, null);
  }
  for (const invalidDb of ['relative.sqlite', String.raw`\\synthetic.invalid\share\db.sqlite`,
    `${w.root}\\..\\db.sqlite`]) {
    const result = await diagnoseCodexDoctor(['--node-executable', process.execPath,
      '--db', invalidDb, '--tenant', 'synthetic', '--scope', 'fixture']);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.setup, null);
    assert.ok(codes(result.report).includes('invalid_configuration'));
  }
  const invalidExe = await diagnoseCodexDoctor(['--node-executable', 'node', ...args(w).slice(2)]);
  assert.ok(codes(invalidExe.report).includes('invalid_executable_path'));
  assert.equal(invalidExe.report.setup, null);
  assert.equal(existsSync(w.db), false);
});

test('missing build, production entry and executable are fixed static failures', async t => {
  const w = workspace(t);
  const missing = join(w.root, 'missing');
  const result = await diagnoseCodexDoctor(args(w), { buildEntry: missing, mcpEntry: missing });
  assert.equal(result.exitCode, 1);
  assert.ok(codes(result.report).includes('build_required'));
  assert.ok(codes(result.report).includes('mcp_entry_missing'));
  const noNode = await diagnoseCodexDoctor(['--node-executable', missing, ...args(w).slice(2)]);
  assert.equal(noNode.report.prerequisites.executable.status, 'missing');
  assert.ok(codes(noNode.report).includes('executable_missing'));
  assert.equal(existsSync(w.db), false);
});

test('old SQLite is blocked for persistent writes while historical inspection remains read-only', async t => {
  const w = workspace(t);
  w.db = join(w.root, '历史 账本.sqlite');
  const kernel = new SqliteKernel(w.db);
  kernel.claim({ key: 'private-old-runtime-key', requestDigest: hash('old-request'), owner: 'fixture',
    leaseMs: 1000, evidence: { mode: 'shadow', taskEvidence: { status: 'missing', coverage: 'none' } } });
  kernel.close();
  const before = readFileSync(w.db);
  const filesBefore = readdirSync(w.root);
  const runtime = { schemaVersion: 1, nodeVersion: '24.19.0', sqliteVersion: '3.50.0',
    walResetFix: 'affected', persistentWriteAllowed: false, probeStatus: 'ok' };
  const result = await diagnoseCodexDoctor(args(w), { inspectRuntime: () => runtime });
  assert.equal(result.exitCode, 1);
  assert.ok(codes(result.report).includes('sqlite_wal_runtime_unsupported'));
  assert.equal(result.report.prerequisites.sqliteRuntime.walResetFix, 'affected');
  assert.equal(result.report.prerequisites.database, 'readable');
  assert.equal(result.report.historicalEvidence.status, 'historical_evidence');
  assert.deepEqual(readFileSync(w.db), before);
  assert.deepEqual(readdirSync(w.root), filesBefore);
});

test('active WAL sidecars cause an explicit historical skip without touching source files', async t => {
  const w = workspace(t), kernel = new SqliteKernel(w.db);
  try {
    kernel.claim({ key: 'active-key', requestDigest: hash('active-request'), owner: 'fixture',
      leaseMs: 1000, evidence: { mode: 'shadow', taskEvidence: { status: 'missing', coverage: 'none' } } });
    const filesBefore = readdirSync(w.root);
    assert.ok(filesBefore.includes('ledger.sqlite-wal'));
    assert.ok(filesBefore.includes('ledger.sqlite-shm'));
    const bytesBefore = new Map(filesBefore.map(name => [name, readFileSync(join(w.root, name))]));
    const result = await diagnoseCodexDoctor(args(w));
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.prerequisites.database, 'inspection_unavailable');
    assert.equal(result.report.historicalEvidence.status, 'not_inspected');
    assert.ok(codes(result.report).includes('database_live_wal_unavailable'));
    assert.deepEqual(readdirSync(w.root), filesBefore);
    for (const [name, bytes] of bytesBefore)
      assert.deepEqual(readFileSync(join(w.root, name)), bytes);
  } finally { kernel.close(); }
});

test('a file changed during inspection discards historical output', async t => {
  const w = workspace(t), kernel = new SqliteKernel(w.db);
  kernel.close();
  const result = await diagnoseCodexDoctor(args(w), {
    openKernel: async () => {
      const changed = new Date(Date.now() + 60_000);
      utimesSync(w.db, changed, changed);
      return { listEvidence: () => ({ items: [{ run: { state: 'completed' } }] }), close() {} };
    },
  });
  assert.equal(result.report.prerequisites.database, 'inspection_unavailable');
  assert.equal(result.report.historicalEvidence.status, 'not_inspected');
  assert.ok(codes(result.report).includes('database_changed_during_inspection'));
});

test('existing damaged database is reported without content leak or rewrite', async t => {
  const w = workspace(t), secret = 'PRIVATE_BROKEN_SQLITE_CONTENT';
  writeFileSync(w.db, secret);
  const result = await diagnoseCodexDoctor(args(w));
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.prerequisites.database, 'invalid');
  assert.ok(codes(result.report).includes('database_invalid'));
  assert.equal(readFileSync(w.db, 'utf8'), secret);
  assert.equal(JSON.stringify(result.report).includes(secret), false);
});

test('conflict and UNKNOWN historical evidence stay bounded and do not authorize retry', async t => {
  const w = workspace(t), kernel = new SqliteKernel(w.db);
  const handle = kernel.claim({ key: 'private-key', requestDigest: hash('request'), owner: 'fixture',
    leaseMs: 1000, evidence: { mode: 'shadow', taskEvidence: { status: 'missing', coverage: 'none' } } }).handle;
  kernel.observe('private-key', { id: 'one', status: 'succeeded', provenance: 'model-reported',
    evidenceDigest: hash('one') });
  kernel.observe('private-key', { id: 'two', status: 'failed', provenance: 'model-reported',
    evidenceDigest: hash('two') });
  kernel.abandon(handle);
  kernel.close();
  const before = readFileSync(w.db);
  const filesBefore = readdirSync(w.root);
  const result = await diagnoseCodexDoctor([...args(w), '--key', 'private-key']);
  const historical = result.report.historicalEvidence;
  assert.equal(historical.status, 'historical_evidence');
  assert.equal(historical.selection, 'explicit_key');
  assert.equal(historical.runState, 'unknown');
  assert.equal(historical.outcomeStatus, 'conflicting');
  assert.equal(historical.executionAuthorized, false);
  assert.equal(historical.currentConfigurationVerified, false);
  assert.ok(codes(result.report).includes('historical_outcome_conflict'));
  assert.ok(codes(result.report).includes('historical_unknown_execution'));
  assert.equal(JSON.stringify(result.report).includes('private-key'), false);
  assert.equal(formatCodexDoctor(result.report).includes('private-key'), false);
  assert.deepEqual(readFileSync(w.db), before);
  assert.deepEqual(readdirSync(w.root), filesBefore);
});
