import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fork, spawn, spawnSync } from 'node:child_process';
import { syntheticBackupLedger } from '../examples/ledger-backup.mjs';
import { addSyntheticFreePages, fixtureRows, main as demo } from '../examples/ledger-compaction.mjs';
import { createLedgerBackup } from '../adapters/backup.mjs';
import { previewLedgerCompaction, applyLedgerCompaction, inspectCompactionAttempt } from '../adapters/compaction.mjs';
import { compactionMain, parseCompactionOptions } from '../adapters/compaction-cli.mjs';
import { validateCompactionPlan } from '../adapters/compaction-contract.mjs';
import { runCompactionWorker } from '../adapters/compaction-process.mjs';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';

async function fixture(t, { plan = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-compaction-workflow-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-compaction-workflow-'));
    rmSync(target, { recursive: true, force: true });
  });
  const dbPath = join(root, '中文 source.sqlite'), backupDirectory = join(root, '归档 archive'), planDirectory = join(root, '操作 plan');
  const sample = syntheticBackupLedger(dbPath); sample.kernel.close();
  addSyntheticFreePages(dbPath);
  await createLedgerBackup({ dbPath, outDir: backupDirectory });
  const input = { dbPath, backupDirectory, planDirectory, quiescent: true };
  if (plan) await previewLedgerCompaction({ dbPath, backupDirectory, outDir: planDirectory });
  return { root, dbPath, backupDirectory, planDirectory, input };
}
const run = args => spawnSync(process.execPath, ['adapters/compaction-cli.mjs', ...args], { encoding: 'utf8', timeout: 15000 });

test('actual quoted CLI preview/apply/inspect reclaims synthetic free pages while preserving all rows', async t => {
  const f = await fixture(t, { plan: false }), before = fixtureRows(f.dbPath), bytes = statSync(f.dbPath).size;
  let cli = run(['preview', '--db', f.dbPath, '--backup-dir', f.backupDirectory, '--out-dir', f.planDirectory, '--json']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const preview = JSON.parse(cli.stdout); assert.equal(preview.status, 'preview');
  assert.ok(preview.snapshot.pages.freelistCount > 0); assert.equal(fixtureRows(f.dbPath), before);
  assert.equal(cli.stdout.includes(f.dbPath), false);
  cli = run(['apply', '--db', f.dbPath, '--backup-dir', f.backupDirectory, '--plan-dir', f.planDirectory, '--apply', '--quiescent', '--json']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const applied = JSON.parse(cli.stdout);
  assert.equal(applied.status, 'verified_compaction'); assert.equal(applied.physicalBytesFreed, null);
  assert.equal(applied.deleteRows, false); assert.equal(applied.retryAllowed, false);
  assert.equal(fixtureRows(f.dbPath), before); assert.ok(statSync(f.dbPath).size < bytes);
  cli = run(['inspect', '--plan-dir', f.planDirectory, '--json']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(JSON.parse(cli.stdout).currentLedgerVerified, false);
  assert.equal(inspectCompactionAttempt(f.planDirectory).status, 'recorded_completion');
  await assert.rejects(applyLedgerCompaction(f.input));
});

test('source changes after preview are rejected under lock and spend the attempted plan without retry', async t => {
  const f = await fixture(t), k = new SqliteKernel(f.dbPath);
  try { const admitted = k.claim({ key: 'newer', requestDigest: digest('newer'), owner: 'fixture', leaseMs: 100, evidence: {} }); k.abandon(admitted.handle); }
  finally { k.close(); }
  const before = fixtureRows(f.dbPath);
  await assert.rejects(applyLedgerCompaction(f.input), { code: 'apply_unknown' });
  assert.equal(fixtureRows(f.dbPath), before);
  assert.equal(inspectCompactionAttempt(f.planDirectory).status, 'apply_unknown');
  await assert.rejects(applyLedgerCompaction(f.input));
});

test('two independent CLI applicants can dispatch at most once from one plan directory', async t => {
  const f = await fixture(t), before = fixtureRows(f.dbPath);
  const args = ['adapters/compaction-cli.mjs', 'apply', '--db', f.dbPath, '--backup-dir', f.backupDirectory,
    '--plan-dir', f.planDirectory, '--apply', '--quiescent', '--json'];
  const results = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('error', reject);
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  })));
  assert.deepEqual(results.map(value => value.status).sort(), [0, 1], JSON.stringify(results));
  assert.equal(results.filter(value => JSON.parse(value.stdout).status === 'verified_compaction').length, 1);
  assert.equal(inspectCompactionAttempt(f.planDirectory).status, 'recorded_completion');
  assert.equal(fixtureRows(f.dbPath), before);
});

test('same-content different source path, changed backup and missing quiescence fail before attempt', async t => {
  const f = await fixture(t), copy = join(f.root, 'copy.sqlite');
  copyFileSync(f.dbPath, copy);
  await assert.rejects(applyLedgerCompaction({ ...f.input, dbPath: copy }), { code: 'source_changed' });
  await assert.rejects(applyLedgerCompaction({ ...f.input, quiescent: false }), { code: 'quiescence_required' });
  const otherArchive = join(f.root, 'other-archive'), k = new SqliteKernel(f.dbPath);
  try { k.claim({ key: 'different', requestDigest: digest('different'), owner: 'fixture', leaseMs: 100, evidence: {} }); }
  finally { k.close(); }
  await createLedgerBackup({ dbPath: f.dbPath, outDir: otherArchive });
  await assert.rejects(applyLedgerCompaction({ ...f.input, backupDirectory: otherArchive }), { code: 'backup_changed' });
  assert.equal(existsSync(join(f.planDirectory, 'attempt')), false);
});

test('never compact the bound archive or create plan output inside archive/source sidecars', async t => {
  const f = await fixture(t, { plan: false });
  await assert.rejects(previewLedgerCompaction({ dbPath: join(f.backupDirectory, 'ledger.sqlite'), backupDirectory: f.backupDirectory,
    outDir: f.planDirectory }), { code: 'source_is_backup' });
  for (const outDir of [join(f.backupDirectory, 'plan'), f.dbPath + '-wal', f.dbPath + '-shm', f.dbPath + '-journal'])
    await assert.rejects(previewLedgerCompaction({ dbPath: f.dbPath, backupDirectory: f.backupDirectory, outDir }), { code: 'output_overlap' });
  assert.deepEqual(readdirSync(f.backupDirectory).sort(), ['COMPLETE', 'ledger.sqlite', 'manifest.json']);
});

test('existing output and nonmatching backup cannot be silently reused', async t => {
  const f = await fixture(t);
  await assert.rejects(previewLedgerCompaction({ dbPath: f.dbPath, backupDirectory: f.backupDirectory, outDir: f.planDirectory }), { code: 'EEXIST' });
  const k = new SqliteKernel(f.dbPath);
  try { k.claim({ key: 'new', requestDigest: digest('new'), owner: 'fixture', leaseMs: 100, evidence: {} }); } finally { k.close(); }
  const outDir = join(f.root, 'stale-plan');
  await assert.rejects(previewLedgerCompaction({ dbPath: f.dbPath, backupDirectory: f.backupDirectory, outDir }), { code: 'compaction_unverified' });
  assert.equal(existsSync(outDir), false);
});

test('plan tampering, missing READY, extra entries and incomplete attempts never become apply permission', async t => {
  const f = await fixture(t);
  const bytes = readFileSync(join(f.planDirectory, 'plan.json'));
  writeFileSync(join(f.planDirectory, 'plan.json'), Buffer.concat([bytes, Buffer.from(' ')]));
  await assert.rejects(applyLedgerCompaction(f.input), { code: 'invalid_plan' });
  writeFileSync(join(f.planDirectory, 'plan.json'), bytes);
  mkdirSync(join(f.planDirectory, 'attempt'));
  assert.equal(inspectCompactionAttempt(f.planDirectory).status, 'apply_unknown');
  await assert.rejects(applyLedgerCompaction(f.input));
});

test('strict plans reject extra authority fields, unsafe counts, accessors and precision loss', async t => {
  const f = await fixture(t), plan = JSON.parse(readFileSync(join(f.planDirectory, 'plan.json'), 'utf8'));
  assert.equal(Object.isFrozen(validateCompactionPlan(plan).snapshot.rowCounts), true);
  for (const mutate of [p => { p.restoreAuthorized = true; }, p => { p.retryAllowed = true; },
    p => { p.deleteRows = true; }, p => { p.extra = true; }, p => { p.snapshot.rowCounts.runs = -1; },
    p => { p.snapshot.pages.pageCount = Number.MAX_SAFE_INTEGER; }, p => { p.source.inode = 32369622322381973; }]) {
    const changed = structuredClone(plan); mutate(changed); assert.throws(() => validateCompactionPlan(changed));
  }
  const accessor = structuredClone(plan); Object.defineProperty(accessor.source, 'inode', { get() { throw new Error('must not execute'); } });
  assert.throws(() => validateCompactionPlan(accessor), { code: 'invalid_plan' });
});

for (const failure of ['complete', 'publication']) test(`failure after VACUUM during ${failure} retains unknown outcome and never permits re-dispatch`, async t => {
  const f = await fixture(t), before = fixtureRows(f.dbPath), originalOpen = fs.openSync, originalUnlink = fs.unlinkSync;
  fs.openSync = (path, ...args) => {
    if (failure === 'complete' && typeof path === 'string' && path === join(f.planDirectory, 'attempt', 'COMPLETE'))
      throw Object.assign(new Error('synthetic private error'), { code: 'EIO' });
    return originalOpen(path, ...args);
  };
  fs.unlinkSync = (path, ...args) => {
    if (failure === 'publication' && path === join(f.planDirectory, 'attempt', 'UNCONFIRMED'))
      throw Object.assign(new Error('synthetic private error'), { code: 'EIO' });
    return originalUnlink(path, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(applyLedgerCompaction(f.input), { code: 'apply_unknown' }); }
  finally { fs.openSync = originalOpen; fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); }
  assert.equal(fixtureRows(f.dbPath), before);
  assert.equal(inspectCompactionAttempt(f.planDirectory).status, 'apply_unknown');
  await assert.rejects(applyLedgerCompaction(f.input));
});

test('actual stalled compaction worker timeout and cancellation wait for close', async () => {
  for (const cancel of [false, true]) {
    let closed = false, child;
    const controller = new AbortController();
    const pending = runCompactionWorker({ operation: 'apply' }, { timeoutMs: cancel ? 5000 : 100,
      signal: controller.signal, spawnWorker: () => {
        child = fork(new URL('./fixtures/backup-stalled-worker.mjs', import.meta.url), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.once('close', () => { closed = true; }); return child;
      } });
    if (cancel) controller.abort();
    await assert.rejects(pending, { code: cancel ? 'compaction_cancelled' : 'compaction_timeout' });
    assert.equal(closed, true); assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
});

test('pre-abort and CLI missing opt-in/private invalid input do not start an attempt', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(applyLedgerCompaction({ ...f.input, signal: controller.signal }), { code: 'compaction_cancelled' });
  const cli = run(['apply', '--db', f.dbPath, '--backup-dir', f.backupDirectory, '--plan-dir', f.planDirectory, '--json']);
  assert.equal(cli.status, 2); assert.equal(cli.stdout.includes(f.dbPath), false);
  assert.equal(existsSync(join(f.planDirectory, 'attempt')), false);
  for (const args of [['preview', '--token', 'PRIVATE'], ['apply', '--apply', '--apply'], ['inspect', '--plan-dir', 'PRIVATE', '--timeout-ms', '1']])
    assert.throws(() => parseCompactionOptions(args));
  const output = { text: '', write(value) { this.text += value; } };
  assert.equal(await compactionMain(['preview', '--private', 'PRIVATE', '--json'], output), 2);
  assert.equal(output.text.includes('PRIVATE'), false);
});

test('help works without dist or SQLite imports', t => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-compaction-help-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['compaction-cli.mjs', 'direct-run.mjs']) copyFileSync(join('adapters', file), join(root, file));
  const child = spawnSync(process.execPath, [join(root, 'compaction-cli.mjs'), '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /all logical rows retained/);
});

test('account-free compaction lesson proves actual file shrinkage and guard survival', async () => {
  const output = { text: '', write(value) { this.text += value; } };
  assert.equal(await demo([], output), 0);
  assert.match(output.text, /all seven logical tables unchanged/); assert.match(output.text, /UNKNOWN and pair-only guards survived/);
});
