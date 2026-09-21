#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { syntheticBackupLedger } from './ledger-backup.mjs';
import { createLedgerBackup, verifyLedgerBackup } from '../adapters/backup.mjs';
import { previewLedgerCompaction, applyLedgerCompaction, inspectCompactionAttempt } from '../adapters/compaction.mjs';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

/** Fixture preparation only: discard a dedicated dummy table, never ledger rows. */
export function addSyntheticFreePages(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE synthetic_padding(payload BLOB) STRICT; INSERT INTO synthetic_padding VALUES(zeroblob(4194304)); DROP TABLE synthetic_padding;');
  } finally { db.close(); }
}
/** Independent small-fixture comparison, intentionally not the production streaming fingerprint. */
export function fixtureRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = ['packs', 'runs', 'audit', 'observations', 'labels', 'recovery_reviews', 'claude_hook_pairs']
      .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort()]);
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  } finally { db.close(); }
}
export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && argv[0] === '--help') {
    output.write('Synthetic compaction lesson: node examples/ledger-compaction.mjs [--out-dir NEW_DIRECTORY]\nCreates only synthetic source, backup and plan. No model, external tool or real user ledger.\n');
    return 0;
  }
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === '--out-dir' && argv[1])) throw new Error('Invalid demo options');
  const keep = argv.length !== 0, tempRoot = realpathSync(tmpdir());
  const root = keep ? resolve(argv[1]) : mkdtempSync(join(tempRoot, 'reflexmesh-compaction-demo-'));
  if (keep) mkdirSync(root, { mode: 0o700 });
  let kernel, cleanupAllowed = true;
  try {
    const source = join(root, 'source.sqlite'), backup = join(root, 'archive'), plan = join(root, 'plan');
    const fixture = syntheticBackupLedger(source); fixture.kernel.close();
    addSyntheticFreePages(source);
    const originalRows = fixtureRows(source), beforeBytes = statSync(source).size;
    await createLedgerBackup({ dbPath: source, outDir: backup });
    const preview = await previewLedgerCompaction({ dbPath: source, backupDirectory: backup, outDir: plan });
    assert.ok(preview.snapshot.pages.freelistCount > 0);
    assert.equal(fixtureRows(source), originalRows);
    const applied = await applyLedgerCompaction({ dbPath: source, backupDirectory: backup, planDirectory: plan, quiescent: true });
    const afterBytes = statSync(source).size;
    assert.equal(applied.status, 'verified_compaction');
    assert.equal(fixtureRows(source), originalRows);
    assert.ok(afterBytes < beforeBytes);
    assert.equal(inspectCompactionAttempt(plan).status, 'recorded_completion');
    assert.equal((await verifyLedgerBackup({ directory: backup })).status, 'verified_archive');
    kernel = new SqliteKernel(source, { clock: () => 1200 });
    assert.equal(kernel.inspect('completed').labels.length, 1);
    assert.equal(kernel.inspect('completed').observations[0].provenance, 'test-oracle');
    assert.equal(kernel.recoverySnapshot('unknown').latestReview.review.id, 'fixture-review');
    for (const [key, state] of [['pair-only-pending', 'pending'], ['pair-only-blocked', 'blocked'], ['ready', 'ready']])
      assert.equal(kernel.pairingSnapshot(key).state, state);
    const repeat = key => kernel.claim({ key, requestDigest: digest(key), owner: 'compacted-fixture', leaseMs: 100, evidence: {} });
    assert.equal(repeat('completed').kind, 'replay');
    assert.equal(repeat('unknown').kind, 'unknown');
    assert.equal(repeat('executing').kind, 'unknown');
    for (const descriptor of [fixture.pending, fixture.blocked, fixture.ready])
      assert.throws(() => kernel.beginClaudeHookPairing(descriptor), /Claude pairing/);
    output.write('SYNTHETIC compaction lesson: no model, external tool or real user ledger.\n');
    output.write(`PASS: source main-file length after close ${beforeBytes} -> ${afterBytes} bytes; all seven logical tables unchanged.\n`);
    output.write('PASS: labels/provenance/reviews and completed replay, UNKNOWN and pair-only guards survived.\n');
    output.write('No ledger row was deleted. Dummy padding was discarded only while preparing this owned fixture.\n');
    output.write('File length is not physical disk allocation or secure erasure; backup is not restore authority.\n');
    output.write(keep ? `Synthetic source/archive/plan retained in ${JSON.stringify(root)}.\n`
      : 'Only this owned temporary fixture is removed after all connections/workers close.\n');
    return 0;
  } catch (error) {
    if (['apply_unknown_worker_unconfirmed', 'worker_termination_unconfirmed'].includes(error?.code)) cleanupAllowed = false;
    throw error;
  } finally {
    kernel?.close();
    if (!keep && cleanupAllowed) {
      const target = realpathSync(root);
      assert.equal(dirname(target), tempRoot); assert.ok(basename(target).startsWith('reflexmesh-compaction-demo-'));
      rmSync(target, { recursive: true, force: true });
    }
  }
}
if (isDirectRun(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { process.stderr.write('Synthetic compaction lesson failed. Build first and use a new output directory.\n'); process.exitCode = 1; }
}
