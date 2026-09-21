import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_TABLES, storageView } from '../adapters/storage-view.mjs';
import { BackupManifestError, validateBackupManifest } from '../adapters/backup-contract.mjs';

function summary(version = 3) {
  return storageView({ ledgerSchemaVersion: version, scanLimit: 1000,
    pages: { pageSize: 4096, pageCount: 12, freelistCount: 1 },
    rows: Object.fromEntries(STORAGE_TABLES.map(table => [table,
      table === 'recovery_reviews' && version < 2 || table === 'claude_hook_pairs' && version < 3 ? null : []])) });
}
function manifest(version = 3) { return {
  schemaVersion: 1, kind: 'reflexmesh-ledger-backup', createdAt: '2026-09-22T00:00:00.000Z',
  ledgerSchemaVersion: version, database: { file: 'ledger.sqlite', bytes: 49152, sha256: 'a'.repeat(64) },
  runtime: { nodeVersion: '24.19.0', sqliteVersion: '3.53.3' }, summary: summary(version),
  checks: { integrity: 'ok', foreignKeys: 'ok', schema: 'recognized' },
  restoreAuthorized: false, retryAllowed: false,
}; }

test('versioned manifest is strict, deeply frozen and preserves old-schema unknown coverage', () => {
  for (const version of [1, 2, 3]) {
    const original = manifest(version), valid = validateBackupManifest(original);
    assert.notStrictEqual(valid, original);
    assert.equal(Object.isFrozen(valid), true);
    assert.equal(Object.isFrozen(valid.summary.tables), true);
    assert.equal(Object.isFrozen(valid.database), true);
    assert.equal(valid.summary.tables.claude_hook_pairs.supported, version === 3);
    assert.equal(valid.summary.tables.recovery_reviews.supported, version >= 2);
    assert.equal(valid.restoreAuthorized, false);
    original.database.sha256 = 'b'.repeat(64);
    assert.equal(valid.database.sha256, 'a'.repeat(64));
  }
});

test('manifest rejects unknown fields, paths, fabricated authority and malformed fixed metadata', () => {
  const bad = change => { const value = structuredClone(manifest()); change(value);
    assert.throws(() => validateBackupManifest(value), BackupManifestError); };
  bad(x => { x.sourcePath = '/private/source.sqlite'; });
  bad(x => { x.database.file = '../ledger.sqlite'; });
  bad(x => { x.database.sha256 = 'A'.repeat(64); });
  bad(x => { x.database.bytes = Infinity; });
  bad(x => { x.runtime.sqliteVersion = 'PRIVATE_SQLITE_ERROR'; });
  bad(x => { x.createdAt = '2026-09-22T00:00:00Z'; });
  bad(x => { x.restoreAuthorized = true; });
  bad(x => { x.retryAllowed = true; });
  bad(x => { x.checks.integrity = 'unknown'; });
  bad(x => { x.summary.ledgerSchemaVersion = 2; });
  bad(x => { x.summary.scanLimit = 10; });
  bad(x => { x.summary.pages.reusableBytes = 0; });
  bad(x => { x.summary.tables.packs.extra = 'PRIVATE_ROW'; });
  bad(x => { x.summary.tables.runs.scanned = 1; });
  bad(x => { x.summary.tables.runs.truncated = true; });
  bad(x => { x.summary.pairStates.pairOnly = 1; });
  let getterCalls = 0;
  const accessor = manifest();
  Object.defineProperty(accessor.database, 'bytes', { enumerable: true,
    get() { getterCalls++; return 49152; } });
  assert.throws(() => validateBackupManifest(accessor), BackupManifestError);
  assert.equal(getterCalls, 0);
});

test('truncated storage samples keep total null and cannot masquerade as exact totals', () => {
  const valid = manifest();
  valid.summary = structuredClone(valid.summary);
  valid.summary.tables.runs = { supported: true, scanned: 1000, truncated: true, total: null };
  valid.summary.runStates.counts.admitted = 1000;
  const accepted = validateBackupManifest(valid);
  assert.equal(accepted.summary.tables.runs.total, null);
  valid.summary.tables.runs.total = 1000;
  assert.throws(() => validateBackupManifest(valid), BackupManifestError);
});
