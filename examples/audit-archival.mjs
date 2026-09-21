#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { syntheticBackupLedger } from './ledger-backup.mjs';
import { createLedgerBackup, verifyLedgerBackup } from '../adapters/backup.mjs';
import { previewLedgerAuditArchive, applyLedgerAuditArchive, auditArchiveHistory, queryLedgerAuditArchive } from '../adapters/audit-archive.mjs';
import { previewLedgerCompaction, applyLedgerCompaction } from '../adapters/compaction.mjs';
import { ledgerSnapshot } from '../adapters/compaction-database.mjs';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

/** Independent fixture row readback; not production coverage verification. */
export function fixtureAudit(path, key) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const statement = db.prepare('SELECT seq,CAST(details AS BLOB) AS details FROM audit WHERE run_key=? ORDER BY seq');
    statement.setReadBigInts(true);
    return statement.all(key).map(row => ({ seq: row.seq.toString(), detailsBase64: Buffer.from(row.details).toString('base64') }));
  } finally { db.close(); }
}
export function syntheticArchivalLedger(path) {
  const fixture = syntheticBackupLedger(path);
  try {
    const handle = fixture.kernel.claim({ key: 'archive-demo', requestDigest: digest('archive-demo'), owner: 'synthetic',
      leaseMs: 100000, evidence: { synthetic: true } }).handle;
    for (let i = 0; i < 32; i++) fixture.kernel.append(handle, { kind: 'synthetic.audit', details: { index: i, padding: 'x'.repeat(256) } });
    return { ...fixture, handle };
  } catch (error) { fixture.kernel.close(); throw error; }
}
export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && argv[0] === '--help') {
    output.write('Synthetic audit archival: node examples/audit-archival.mjs [--out-dir NEW_DIRECTORY]\nTwo batches, exact historical bytes, online guards, schema4 backup/compaction. No model or real user ledger.\n'); return 0;
  }
  assert.ok(argv.length === 0 || argv.length === 2 && argv[0] === '--out-dir' && argv[1]);
  const keep = argv.length !== 0, tempRoot = realpathSync(tmpdir());
  const root = keep ? resolve(argv[1]) : mkdtempSync(join(tempRoot, 'reflexmesh-audit-demo-'));
  if (keep) mkdirSync(root, { mode: 0o700 });
  let kernel, cleanupAllowed = true;
  try {
    const dbPath = join(root, 'source.sqlite'), fixture = syntheticArchivalLedger(dbPath); fixture.kernel.close();
    const expected = fixtureAudit(dbPath, 'archive-demo'), batches = [];
    const originalRows = ledgerSnapshot(dbPath).rowCounts.audit;
    for (let i = 1; i <= 2; i++) {
      if (i === 2) {
        kernel = new SqliteKernel(dbPath, { clock: () => 1200 });
        kernel.append(fixture.handle, { kind: 'synthetic.new-anchor', details: { synthetic: true } });
        kernel.close(); kernel = undefined;
      }
      const backupDirectory = join(root, `archive-${i}`), planDirectory = join(root, `plan-${i}`);
      await createLedgerBackup({ dbPath, outDir: backupDirectory });
      const preview = await previewLedgerAuditArchive({ dbPath, backupDirectory, outDir: planDirectory, cutoffAt: 5000 });
      const applied = await applyLedgerAuditArchive({ dbPath, backupDirectory, planDirectory, quiescent: true });
      assert.equal(applied.status, 'verified_archival');
      assert.equal(applied.archivedRows, preview.selection.rowCount);
      batches.push({ batchId: preview.batchId, backupDirectory });
    }
    const actual = [];
    for (const batch of batches) {
      let afterSeq;
      do {
        const page = await queryLedgerAuditArchive({ dbPath, runKey: 'archive-demo', ...batch, afterSeq, includeDetails: true });
        assert.equal(page.scope, 'one-batch'); assert.equal(page.coverageVerified, true);
        actual.push(...page.items.map(row => ({ seq: row.seq, detailsBase64: row.detailsBase64 })));
        afterSeq = page.nextCursor;
      } while (afterSeq !== null);
    }
    assert.deepEqual(actual, expected);
    const history = await auditArchiveHistory({ dbPath, runKey: 'archive-demo' });
    assert.equal(history.items.length, 2);
    assert.equal(fixtureAudit(dbPath, 'archive-demo').length, 1);
    const currentBackup = join(root, 'archive-current');
    await createLedgerBackup({ dbPath, outDir: currentBackup });
    const verified = await verifyLedgerBackup({ directory: currentBackup });
    assert.equal(verified.manifest.schemaVersion, 2);
    assert.equal(verified.manifest.externalAuditArchives, 'not_verified');
    await assert.rejects(queryLedgerAuditArchive({ dbPath, runKey: 'archive-demo', batchId: batches[0].batchId,
      backupDirectory: currentBackup }));
    const beforeCompact = ledgerSnapshot(dbPath), compactPlan = join(root, 'compaction-plan');
    await previewLedgerCompaction({ dbPath, backupDirectory: currentBackup, outDir: compactPlan });
    await applyLedgerCompaction({ dbPath, backupDirectory: currentBackup, planDirectory: compactPlan, quiescent: true });
    assert.equal(ledgerSnapshot(dbPath).logicalDigest, beforeCompact.logicalDigest);
    kernel = new SqliteKernel(dbPath, { clock: () => 1200 });
    assert.equal(kernel.inspect('completed').labels.length, 1);
    assert.equal(kernel.inspect('completed').observations[0].provenance, 'test-oracle');
    assert.equal(kernel.evidenceSnapshot('completed').auditHistory.archived, true);
    assert.equal(kernel.recoverySnapshot('unknown').latestReview.review.id, 'fixture-review');
    for (const [key, state] of [['pair-only-pending', 'pending'], ['pair-only-blocked', 'blocked'], ['ready', 'ready']])
      assert.equal(kernel.pairingSnapshot(key).state, state);
    const repeat = key => kernel.claim({ key, requestDigest: digest(key), owner: 'fixture', leaseMs: 100, evidence: {} });
    assert.equal(repeat('completed').kind, 'replay'); assert.equal(repeat('unknown').kind, 'unknown');
    assert.equal(repeat('executing').kind, 'unknown');
    for (const descriptor of [fixture.pending, fixture.blocked, fixture.ready])
      assert.throws(() => kernel.beginClaudeHookPairing(descriptor), /Claude pairing/);
    output.write('SYNTHETIC audit archival: no model, external tool or real user ledger.\n');
    output.write(`PASS: ${originalRows} original audit rows archived across two batches; new anchor retained, original run details recovered byte-for-byte.\n`);
    output.write('PASS: labels, outcomes, reviews, completed replay, UNKNOWN and pairing guards survived.\n');
    output.write('PASS: schema4 full backup and nine-table compaction preserve archive coverage; wrong archive rejected.\n');
    output.write('External archive chain availability is not certified. No retry, restore or secure erasure.\n');
    output.write(keep ? `Owned synthetic fixtures retained in ${JSON.stringify(root)}.\n` : 'Only owned temporary synthetic fixtures removed after all handles close.\n');
    return 0;
  } catch (error) {
    if (['worker_termination_unconfirmed', 'apply_unknown_worker_unconfirmed'].includes(error?.code)) cleanupAllowed = false;
    throw error;
  } finally {
    kernel?.close();
    if (!keep && cleanupAllowed) {
      const target = realpathSync(root);
      assert.equal(dirname(target), tempRoot); assert.ok(basename(target).startsWith('reflexmesh-audit-demo-'));
      rmSync(target, { recursive: true, force: true });
    }
  }
}
if (isDirectRun(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { process.stderr.write('Synthetic audit archival failed. Build first; keep the operation and archive if apply is unknown.\n'); process.exitCode = 1; }
}
