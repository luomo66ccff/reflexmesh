import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { syntheticArchivalLedger, fixtureAudit, main as demo } from '../examples/audit-archival.mjs';
import { createLedgerBackup, verifyLedgerBackup } from '../adapters/backup.mjs';
import { previewLedgerAuditArchive, applyLedgerAuditArchive, inspectAuditArchiveAttempt, auditArchiveHistory, queryLedgerAuditArchive } from '../adapters/audit-archive.mjs';
import { validateAuditArchivePlan } from '../adapters/audit-archive-contract.mjs';
import { auditArchiveMain, parseAuditArchiveOptions } from '../adapters/audit-archive-cli.mjs';
import { ledgerSnapshot } from '../adapters/compaction-database.mjs';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createBackupDatabase } from '../adapters/backup-database.mjs';
import { previewAuditArchive, applyAuditArchive } from '../adapters/audit-archive-database.mjs';
import { hashFile } from '../adapters/backup-files.mjs';
import { validateBackupManifest } from '../adapters/backup-contract.mjs';
import { validateCompactionPlan } from '../adapters/compaction-contract.mjs';
import { previewLedgerCompaction } from '../adapters/compaction.mjs';

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-archive-workflow-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith('reflexmesh-archive-workflow-'));
    rmSync(target, { recursive: true, force: true });
  }); return root;
}
async function fixture(t, makePlan = true) {
  const root = temporary(t), dbPath = join(root, '中文 source.sqlite'), backupDirectory = join(root, '归档 archive');
  const planDirectory = join(root, '审计 plan'), fixture = syntheticArchivalLedger(dbPath); fixture.kernel.close();
  await createLedgerBackup({ dbPath, outDir: backupDirectory });
  const preview = makePlan ? await previewLedgerAuditArchive({ dbPath, backupDirectory, outDir: planDirectory, cutoffAt: 5000 }) : null;
  return { root, dbPath, backupDirectory, planDirectory, preview, fixture,
    input: { dbPath, backupDirectory, planDirectory, quiescent: true } };
}
const run = args => spawnSync(process.execPath, ['adapters/audit-archive-cli.mjs', ...args], { encoding: 'utf8', timeout: 15000 });

test('actual quoted CLI preview/apply/inspect/history/query deletes only selected audit and explicitly retrieves details', async t => {
  const f = await fixture(t, false), before = ledgerSnapshot(f.dbPath), expected = fixtureAudit(f.dbPath, 'archive-demo').slice(0, -1);
  let cli = run(['preview', '--db', f.dbPath, '--backup-dir', f.backupDirectory, '--out-dir', f.planDirectory, '--cutoff-ms', '5000', '--json']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const preview = JSON.parse(cli.stdout); assert.equal(preview.status, 'preview'); assert.equal(cli.stdout.includes(f.dbPath), false);
  assert.equal(ledgerSnapshot(f.dbPath).logicalDigest, before.logicalDigest);
  cli = run(['apply', '--db', f.dbPath, '--backup-dir', f.backupDirectory, '--plan-dir', f.planDirectory, '--apply', '--quiescent', '--json']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr); assert.equal(JSON.parse(cli.stdout).status, 'verified_archival');
  assert.equal(ledgerSnapshot(f.dbPath).rowCounts.audit, before.rowCounts.audit - preview.selection.rowCount);
  cli = run(['inspect', '--plan-dir', f.planDirectory, '--json']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr); assert.equal(JSON.parse(cli.stdout).currentLedgerVerified, false);
  cli = run(['history', '--db', f.dbPath, '--key', 'archive-demo', '--json']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr); assert.equal(JSON.parse(cli.stdout).items.length, 1);
  cli = run(['query', '--db', f.dbPath, '--key', 'archive-demo', '--batch', preview.batchId,
    '--archive-dir', f.backupDirectory, '--limit', '50', '--json']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const metadata = JSON.parse(cli.stdout); assert.equal(metadata.scope, 'one-batch');
  assert.equal(metadata.items.length, expected.length); assert.equal(metadata.items.some(item => 'detailsBase64' in item), false);
  const full = await queryLedgerAuditArchive({ dbPath: f.dbPath, runKey: 'archive-demo', batchId: preview.batchId,
    backupDirectory: f.backupDirectory, limit: 50, includeDetails: true });
  assert.deepEqual(full.items.map(row => ({ seq: row.seq, detailsBase64: row.detailsBase64 })), expected);
  assert.equal((await verifyLedgerBackup({ directory: f.backupDirectory })).manifest.schemaVersion, 1);
  await assert.rejects(applyLedgerAuditArchive(f.input));
});

test('no quiescence, wrong source, wrong archive, pre-abort and missing CLI opt-in never dispatch', async t => {
  const f = await fixture(t), copy = join(f.root, 'same-content.sqlite'); copyFileSync(f.dbPath, copy);
  await assert.rejects(applyLedgerAuditArchive({ ...f.input, quiescent: false }), { code: 'quiescence_required' });
  await assert.rejects(applyLedgerAuditArchive({ ...f.input, dbPath: copy }), { code: 'source_changed' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(applyLedgerAuditArchive({ ...f.input, signal: controller.signal }), { code: 'archive_cancelled' });
  const cli = run(['apply', '--db', f.dbPath, '--backup-dir', f.backupDirectory, '--plan-dir', f.planDirectory, '--json']);
  assert.equal(cli.status, 2); assert.equal(cli.stdout.includes(f.dbPath), false);
  assert.equal(existsSync(join(f.planDirectory, 'attempt')), false);
});

test('stale source after preview spends one attempt but preserves all current content', async t => {
  const f = await fixture(t), kernel = new SqliteKernel(f.dbPath);
  try { kernel.claim({ key: 'new', requestDigest: digest('new'), owner: 'fixture', leaseMs: 100, evidence: {} }); }
  finally { kernel.close(); }
  const before = ledgerSnapshot(f.dbPath);
  await assert.rejects(applyLedgerAuditArchive(f.input), { code: 'apply_unknown' });
  assert.equal(ledgerSnapshot(f.dbPath).logicalDigest, before.logicalDigest);
  assert.equal(inspectAuditArchiveAttempt(f.planDirectory).status, 'apply_unknown');
  await assert.rejects(applyLedgerAuditArchive(f.input));
});

test('two independent apply processes can dispatch at most once per plan', async t => {
  const f = await fixture(t);
  const args = ['adapters/audit-archive-cli.mjs', 'apply', '--db', f.dbPath, '--backup-dir', f.backupDirectory,
    '--plan-dir', f.planDirectory, '--apply', '--quiescent', '--json'];
  const outcomes = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('error', reject); child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  })));
  assert.deepEqual(outcomes.map(o => o.status).sort(), [0, 1], JSON.stringify(outcomes));
  assert.equal(ledgerSnapshot(f.dbPath).rowCounts.audit_archive_batches, 1);
  assert.equal(inspectAuditArchiveAttempt(f.planDirectory).status, 'recorded_completion');
});

for (const stage of ['complete', 'publication']) test(`lost ${stage} receipt after real commit is unknown and non-retryable`, async t => {
  const f = await fixture(t), originalOpen = fs.openSync, originalUnlink = fs.unlinkSync;
  fs.openSync = (path, ...args) => {
    if (stage === 'complete' && path === join(f.planDirectory, 'attempt', 'COMPLETE')) throw new Error('synthetic private failure');
    return originalOpen(path, ...args);
  };
  fs.unlinkSync = (path, ...args) => {
    if (stage === 'publication' && path === join(f.planDirectory, 'attempt', 'UNCONFIRMED')) throw new Error('synthetic private failure');
    return originalUnlink(path, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(applyLedgerAuditArchive(f.input), { code: 'apply_unknown' }); }
  finally { fs.openSync = originalOpen; fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); }
  assert.equal(ledgerSnapshot(f.dbPath).rowCounts.audit_archive_batches, 1);
  assert.equal(inspectAuditArchiveAttempt(f.planDirectory).status, 'apply_unknown');
  const history = await auditArchiveHistory({ dbPath: f.dbPath, runKey: 'archive-demo' });
  assert.equal(history.items.length, 1); // Presence is evidence of commit, not authority to retry/restore.
  await assert.rejects(applyLedgerAuditArchive(f.input));
});

test('tampered plans, invalid authority/count/precision and directories fail closed', async t => {
  const f = await fixture(t), path = join(f.planDirectory, 'plan.json'), bytes = readFileSync(path);
  const plan = JSON.parse(bytes.toString('utf8'));
  assert.equal(Object.isFrozen(validateAuditArchivePlan(plan).preview.selection), true);
  for (const mutate of [p => { p.retryAllowed = true; }, p => { p.restoreAuthorized = true; },
    p => { p.maxRows = 10001; }, p => { p.preview.selection.highwaterSeq = 4; },
    p => { p.preview.selection.rowCount = 0; }, p => { p.extra = true; },
    p => { p.preview.sourceSnapshot.rowCounts.audit = Number.MAX_SAFE_INTEGER + 1; }]) {
    const changed = structuredClone(plan); mutate(changed); assert.throws(() => validateAuditArchivePlan(changed));
  }
  writeFileSync(path, Buffer.concat([bytes, Buffer.from(' ')]));
  await assert.rejects(applyLedgerAuditArchive(f.input), { code: 'invalid_plan' });
  writeFileSync(path, bytes); mkdirSync(join(f.planDirectory, 'attempt'));
  assert.equal(inspectAuditArchiveAttempt(f.planDirectory).status, 'apply_unknown');
});

test('empty selection, oversized selection, overlapping output and stale backup never publish READY', async t => {
  const f = await fixture(t, false);
  for (const extra of [{ cutoffAt: 0 }, { cutoffAt: 5000, maxRows: 1 }]) {
    await assert.rejects(previewLedgerAuditArchive({ dbPath: f.dbPath, backupDirectory: f.backupDirectory, outDir: f.planDirectory, ...extra }));
    assert.equal(existsSync(f.planDirectory), false);
  }
  for (const outDir of [join(f.backupDirectory, 'plan'), f.dbPath + '-wal', f.dbPath + '-journal'])
    await assert.rejects(previewLedgerAuditArchive({ dbPath: f.dbPath, backupDirectory: f.backupDirectory, outDir, cutoffAt: 5000 }), { code: 'output_overlap' });
  await assert.rejects(previewLedgerAuditArchive({ dbPath: join(f.backupDirectory, 'ledger.sqlite'), backupDirectory: f.backupDirectory,
    outDir: f.planDirectory, cutoffAt: 5000 }), { code: 'source_is_archive' });
});

test('wrong run/batch/archive and absent files are unverified, never empty success', async t => {
  const f = await fixture(t); await applyLedgerAuditArchive(f.input);
  const common = { dbPath: f.dbPath, runKey: 'archive-demo', batchId: f.preview.batchId, backupDirectory: f.backupDirectory };
  for (const change of [{ runKey: 'missing' }, { batchId: 'a'.repeat(64) }, { backupDirectory: join(f.root, 'absent') }])
    await assert.rejects(queryLedgerAuditArchive({ ...common, ...change }));
  const newer = join(f.root, 'newer-backup'); await createLedgerBackup({ dbPath: f.dbPath, outDir: newer });
  await assert.rejects(queryLedgerAuditArchive({ ...common, backupDirectory: newer }));
});

test('help needs no build, invalid flags do not leak input, bounded parsing rejects privilege expansion', async t => {
  const root = temporary(t);
  for (const name of ['audit-archive-cli.mjs', 'direct-run.mjs']) copyFileSync(join('adapters', name), join(root, name));
  const child = spawnSync(process.execPath, [join(root, 'audit-archive-cli.mjs'), '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /ONE batch/);
  for (const args of [['preview', '--token', 'PRIVATE'], ['apply', '--apply', '--apply'],
    ['history', '--db', 'x', '--key', 'k', '--limit', '51'], ['query', '--db', 'x', '--key', 'k', '--batch', 'not-a-hash', '--archive-dir', 'x']])
    assert.throws(() => parseAuditArchiveOptions(args));
  const output = { text: '', write(value) { this.text += value; } };
  assert.equal(await auditArchiveMain(['preview', '--private', 'PRIVATE'], output), 2); assert.equal(output.text.includes('PRIVATE'), false);
});

test('two-batch account-free demo proves original bytes, nine-table backup/compaction and guard survival', async () => {
  const output = { text: '', write(value) { this.text += value; } };
  assert.equal(await demo([], output), 0);
  assert.match(output.text, /recovered byte-for-byte/); assert.match(output.text, /UNKNOWN and pairing guards survived/);
});

test('maximum legal escaped kind and details paginate through the actual 64 KiB worker protocol', async t => {
  const f = await fixture(t, false), kernel = new SqliteKernel(f.dbPath, { clock: () => 1200 });
  try {
    for (let i = 0; i < 51; i++) kernel.append(f.fixture.handle, { kind: '\u0001'.repeat(128), details: 'x'.repeat(800) });
  } finally { kernel.close(); }
  const expected = fixtureAudit(f.dbPath, 'archive-demo').slice(0, -1), backupDirectory = join(f.root, 'large-page-archive');
  await createLedgerBackup({ dbPath: f.dbPath, outDir: backupDirectory });
  const preview = await previewLedgerAuditArchive({ dbPath: f.dbPath, backupDirectory, outDir: f.planDirectory, cutoffAt: 5000 });
  await applyLedgerAuditArchive({ ...f.input, backupDirectory });
  const rows = [];
  let afterSeq;
  do {
    const page = await queryLedgerAuditArchive({ dbPath: f.dbPath, runKey: 'archive-demo', batchId: preview.batchId,
      backupDirectory, afterSeq, limit: 50, includeDetails: true });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 65536);
    rows.push(...page.items); afterSeq = page.nextCursor;
  } while (afterSeq !== null);
  assert.deepEqual(rows.map(row => row.seq), expected.map(row => row.seq));
  for (const row of rows) {
    if (row.detailsBase64 !== undefined) assert.equal(row.detailsBase64, expected.find(item => item.seq === row.seq).detailsBase64);
    else assert.equal(row.detailsOmitted, 'size_limit');
  }
});

test('fifty real archival batches fit one bounded history response without claiming archive availability', async t => {
  const root = temporary(t), dbPath = join(root, 'source.sqlite');
  let kernel = new SqliteKernel(dbPath, { clock: () => 1000 });
  const handle = kernel.claim({ key: 'many-batches', requestDigest: digest('many-batches'), owner: 'fixture', leaseMs: 100000, evidence: {} }).handle;
  kernel.append(handle, { kind: 'fixture.anchor', details: {} }); kernel.close();
  for (let i = 0; i < 50; i++) {
    if (i > 0) {
      kernel = new SqliteKernel(dbPath, { clock: () => 1001 });
      try { kernel.append(handle, { kind: 'fixture.anchor', details: { i } }); } finally { kernel.close(); }
    }
    const directory = join(root, `core-fixture-${i}`); mkdirSync(directory);
    const backupPath = join(directory, 'ledger.sqlite'); writeFileSync(backupPath, '', { flag: 'wx' });
    await createBackupDatabase(dbPath, backupPath); // Owned raw core fixture, not a published archive.
    const expectedPreview = previewAuditArchive(dbPath, { backupPath, cutoffAt: 5000 }), file = hashFile(backupPath);
    await applyAuditArchive(dbPath, { backupPath, expectedPreview, batchId: digest(`batch-${i}`),
      archiveSha256: file.sha256, archiveBytes: file.bytes, committedAt: 6000 + i });
  }
  const history = await auditArchiveHistory({ dbPath, runKey: 'many-batches', limit: 50 });
  assert.equal(history.items.length, 50); assert.equal(history.batchCount, 50);
  assert.equal(history.archivedRowCount, 50); assert.equal(history.nextCursor, null);
  assert.equal(history.archiveAvailability, 'not_checked');
  assert.ok(Buffer.byteLength(JSON.stringify(history)) < 65536);
});

test('schema4 artifacts are explicit v2, legacy formats stay v1 and corrupted coverage is rejected', async t => {
  const f = await fixture(t), legacy = (await verifyLedgerBackup({ directory: f.backupDirectory })).manifest;
  assert.equal(legacy.schemaVersion, 1); assert.equal(Object.keys(legacy.summary.tables).length, 7);
  await applyLedgerAuditArchive(f.input);
  const backupDirectory = join(f.root, 'schema4-archive');
  const modern = (await createLedgerBackup({ dbPath: f.dbPath, outDir: backupDirectory })).manifest;
  assert.equal(modern.schemaVersion, 2); assert.equal(modern.summary.schemaVersion, 2);
  assert.equal(Object.keys(modern.summary.tables).length, 9); assert.equal(modern.externalAuditArchives, 'not_verified');
  for (const mutate of [m => { m.schemaVersion = 1; }, m => { m.summary.schemaVersion = 1; },
    m => { delete m.summary.tables.audit_archive_batches; }, m => { m.externalAuditArchives = 'verified'; }]) {
    const changed = structuredClone(modern); mutate(changed); assert.throws(() => validateBackupManifest(changed));
  }
  const changedLegacy = structuredClone(legacy); changedLegacy.summary.tables.audit_archive_batches = modern.summary.tables.audit_archive_batches;
  assert.throws(() => validateBackupManifest(changedLegacy));
  const compactionPlan = join(f.root, 'schema4-compact-plan');
  await previewLedgerCompaction({ dbPath: f.dbPath, backupDirectory, outDir: compactionPlan });
  const plan = JSON.parse(readFileSync(join(compactionPlan, 'plan.json')));
  assert.equal(plan.schemaVersion, 2); assert.equal(Object.keys(plan.snapshot.rowCounts).length, 9);
  plan.schemaVersion = 1; assert.throws(() => validateCompactionPlan(plan));
  const db = new DatabaseSync(f.dbPath);
  try { db.exec("UPDATE audit_archive_coverage SET audit_digest='bad' WHERE run_key='archive-demo'"); }
  finally { db.close(); }
  assert.throws(() => ledgerSnapshot(f.dbPath));
  await assert.rejects(createLedgerBackup({ dbPath: f.dbPath, outDir: join(f.root, 'corrupt-archive') }));
  await assert.rejects(auditArchiveHistory({ dbPath: f.dbPath, runKey: 'archive-demo' }));
});
