#!/usr/bin/env node
import assert from 'node:assert/strict';
import { constants, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { toolPreflightPack } from '../dist/index.js';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { createLedgerBackup, verifyLedgerBackup } from '../adapters/backup.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

const tables = ['packs', 'runs', 'audit', 'observations', 'labels', 'recovery_reviews', 'claude_hook_pairs'];
export function syntheticRowsDigest(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  } finally { db.close(); }
}

/** Only synthetic, kernel-admitted records. Caller owns the new path and closes the returned writer. */
export function syntheticBackupLedger(path) {
  let now = 1000;
  const kernel = new SqliteKernel(path, { clock: () => now });
  try {
    const packDigest = kernel.registerPack(toolPreflightPack);
    const pack = { id: toolPreflightPack.id, version: toolPreflightPack.version, digest: packDigest };
    const claim = (key, evidence = { synthetic: true, pack }) => kernel.claim({ key, owner: 'synthetic',
      requestDigest: digest(key), leaseMs: 100, evidence });
    kernel.complete(claim('completed').handle, { status: 'shadow', provider: { model: 'synthetic-not-a-model',
      answers: { intentMatch: { type: 'noul', noul: 1 }, injection: { type: 'noul', noul: 0 } } } });
    kernel.addLabel('completed', { id: 'fixture-label', questionId: 'intentMatch', value: 1,
      provenance: 'test-oracle', sourceRef: 'fixture:explicit-equality-oracle' });
    kernel.observe('completed', { id: 'fixture-observation', status: 'unknown', provenance: 'test-oracle',
      evidenceDigest: digest('synthetic-no-tool-ran') });
    kernel.abandon(claim('unknown').handle);
    kernel.append(claim('executing').handle, { kind: 'action.started', details: { synthetic: true, toolRan: false } });
    claim('admitted');
    const descriptor = key => ({ key, callDigest: digest(`call-${key}`), actionDigest: digest(`action-${key}`),
      deploymentDigest: digest(`deployment-${key}`) });
    const pending = descriptor('pair-only-pending'), blocked = descriptor('pair-only-blocked');
    kernel.beginClaudeHookPairing(pending);
    kernel.blockClaudeHookPairing(kernel.beginClaudeHookPairing(blocked));
    const evidence = { mode: 'shadow', pack, actionDigest: digest('ready-action'),
      binding: { providerId: 'fixture', modelId: 'synthetic-not-a-model', revision: 'backup-demo-v1' } };
    const ready = { key: 'ready', callDigest: digest('ready-call'), actionDigest: evidence.actionDigest,
      deploymentDigest: digest({ packDigest, binding: evidence.binding, mode: evidence.mode }) };
    const receipt = kernel.beginClaudeHookPairing(ready);
    kernel.complete(claim('ready', evidence).handle, { status: 'shadow' });
    kernel.completeClaudeHookPairing(receipt, { decisionId: 'ready' });
    now = 1101;
    kernel.reviewRecovery({ schemaVersion: 1, id: 'fixture-review', runKey: 'unknown', expectedEpoch: 2,
      inputDigest: digest('unknown'), resolution: 'confirmed_not_executed', evidenceDigest: digest('fixture-review'),
      evidenceRef: 'fixture:no-external-action', actorRef: 'fixture:operator', reason: 'Synthetic backup example', quiescent: true });
    return { kernel, pending, blocked, ready, claim,
      addNewerGuard() { kernel.abandon(claim('newer-unknown').handle); } };
  } catch (error) { kernel.close(); throw error; }
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && argv[0] === '--help') {
    output.write('Synthetic backup lesson: node examples/ledger-backup.mjs [--out-dir NEW_DIRECTORY]\nNo user ledger, model or tool is used. A new explicit directory keeps the source, archive and isolated restored fixture.\n');
    return 0;
  }
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === '--out-dir' && argv[1])) throw new Error('Invalid demo options');
  const keep = argv.length !== 0, tempRoot = realpathSync(tmpdir());
  const directory = keep ? resolve(argv[1]) : mkdtempSync(join(tempRoot, 'reflexmesh-backup-demo-'));
  if (keep) mkdirSync(directory, { mode: 0o700 });
  let fixture, restored, cleanupAllowed = true;
  try {
    const source = join(directory, 'source.sqlite'), archive = join(directory, 'archive');
    fixture = syntheticBackupLedger(source); // Intentionally stays open with committed WAL records.
    const original = syntheticRowsDigest(source);
    const created = await createLedgerBackup({ dbPath: source, outDir: archive });
    assert.equal(syntheticRowsDigest(source), original);
    assert.equal((await verifyLedgerBackup({ directory: archive })).status, 'verified_archive');
    assert.equal(syntheticRowsDigest(join(archive, 'ledger.sqlite')), original);
    const restoreDir = join(directory, 'isolated-restored-fixture');
    mkdirSync(restoreDir, { mode: 0o700 });
    const restorePath = join(restoreDir, 'ledger.sqlite');
    copyFileSync(join(archive, 'ledger.sqlite'), restorePath, constants.COPYFILE_EXCL);
    assert.equal(syntheticRowsDigest(restorePath), original); // Full seven-table content, not just counts.
    restored = new SqliteKernel(restorePath, { clock: () => 1200 });
    assert.equal(restored.inspect('completed').labels.length, 1);
    assert.equal(restored.recoverySnapshot('unknown').latestReview.review.id, 'fixture-review');
    assert.deepEqual(restored.pairingSnapshot('pair-only-pending'), { state: 'pending', reasonCode: null });
    assert.deepEqual(restored.pairingSnapshot('pair-only-blocked'), { state: 'blocked', reasonCode: 'before_failed' });
    assert.deepEqual(restored.pairingSnapshot('ready'), { state: 'ready', reasonCode: null });
    const repeat = key => restored.claim({ key, requestDigest: digest(key), owner: 'restored-fixture', leaseMs: 100, evidence: {} });
    assert.equal(repeat('completed').kind, 'replay');
    assert.equal(repeat('unknown').kind, 'unknown');
    assert.equal(repeat('executing').kind, 'unknown');
    for (const pair of [fixture.pending, fixture.blocked, fixture.ready])
      assert.throws(() => restored.beginClaudeHookPairing(pair), /Claude pairing/);
    fixture.addNewerGuard();
    assert.equal(fixture.kernel.inspect('newer-unknown').state, 'unknown');
    assert.equal(restored.inspect('newer-unknown'), undefined);
    assert.equal((await verifyLedgerBackup({ directory: archive })).status, 'verified_archive');
    assert.equal(created.restoreAuthorized, false);
    output.write('SYNTHETIC backup lesson: no model, external tool or real user ledger used.\n');
    output.write('PASS: all seven tables, labels, review evidence and pending/blocked/ready pairing survived a consistent backup and isolated restore.\n');
    output.write('PASS: completed remains replay-only; UNKNOWN and expired executing remain non-retryable; repeated pre-hook cannot create fresh pairing.\n');
    output.write('COUNTEREXAMPLE: a still-valid older archive lacks the new UNKNOWN tombstone. Verification never authorizes overwriting the current ledger.\n');
    output.write(keep ? `Synthetic source/archive/restored fixture kept in ${JSON.stringify(directory)}.\n`
      : 'Only owned temporary synthetic fixtures are removed after all handles and workers close.\n');
    return 0;
  } catch (error) { if (error?.code === 'worker_termination_unconfirmed') cleanupAllowed = false; throw error; }
  finally {
    restored?.close(); fixture?.kernel.close();
    if (!keep && cleanupAllowed) {
      const target = realpathSync(directory);
      assert.equal(dirname(target), tempRoot); assert.ok(basename(target).startsWith('reflexmesh-backup-demo-'));
      rmSync(target, { recursive: true, force: true });
    }
  }
}
if (isDirectRun(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { process.stderr.write('Synthetic backup lesson failed; build first and choose a new directory.\n'); process.exitCode = 1; }
}
