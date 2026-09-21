import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBackupDatabase } from '../adapters/backup-database.mjs';
import { applyAuditArchive, previewAuditArchive, queryArchivedAudit } from '../adapters/audit-archive-database.mjs';
import { AUDIT_ARCHIVE_TABLE_SQL } from '../adapters/audit-archive-schema.mjs';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';

const prefix = 'reflexmesh-audit-archive-';
function fixture(t) {
  const temp = realpathSync(tmpdir()), dir = mkdtempSync(join(temp, prefix));
  const source = join(dir, 'state.sqlite'), archiveDir = join(dir, 'archive'), backupPath = join(archiveDir, 'ledger.sqlite');
  mkdirSync(archiveDir, { mode: 0o700 });
  let clock = 100;
  const openKernels = new Set();
  t.after(() => {
    for (const kernel of openKernels) kernel.close();
    const resolved = realpathSync(dir);
    assert.equal(dirname(resolved).toLowerCase(), temp.toLowerCase());
    assert.ok(basename(resolved).startsWith(prefix));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { source, backupPath,
    setTime(value) { clock = value; },
    open() { const kernel = new SqliteKernel(source, { clock: () => clock }); openKernels.add(kernel); return kernel; },
    close(kernel) { kernel.close(); openKernels.delete(kernel); },
    async backup(name = 'archive') {
      const directory = join(dir, name), target = join(directory, 'ledger.sqlite');
      if (name !== 'archive') mkdirSync(directory, { mode: 0o700 });
      closeSync(openSync(target, 'wx', 0o600));
      await createBackupDatabase(source, target);
      return target;
    },
  };
}
function raw(path, fn, options = {}) {
  const db = new DatabaseSync(path, options);
  try { return fn(db); } finally { db.close(); }
}
function waitForBarrier(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onMessage = message => { cleanup(); resolve(message); };
    const onError = () => { cleanup(); reject(Error('fixture child error')); };
    const onExit = () => { cleanup(); reject(Error('fixture exited before barrier')); };
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
    timer = setTimeout(() => { cleanup(); reject(Error('fixture barrier timeout')); }, timeoutMs);
  });
}
async function killAndClose(child, closed) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  let timer;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('fixture close timeout')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
function claim(kernel, key) {
  const result = kernel.claim({ key, requestDigest: digest(key), owner: 'fixture', leaseMs: 10000,
    evidence: { mode: 'shadow', body: 'PRIVATE_DATA' } });
  assert.equal(result.kind, 'claimed');
  return result.handle;
}

test('schema 3 archives a complete cutoff selection atomically while retaining the global anchor', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'run-a'); f.setTime(200); claim(kernel, 'run-b'); f.setTime(300); claim(kernel, 'run-c');
  f.close(kernel);
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  assert.equal(preview.sourceSnapshot.ledgerSchemaVersion, 3);
  assert.deepEqual({ rows: preview.selection.rowCount, runs: preview.selection.runCount,
    highwater: preview.selection.highwaterSeq }, { rows: 2, runs: 2, highwater: '3' });
  const result = await applyAuditArchive(f.source, { backupPath: f.backupPath,
    expectedPreview: preview, batchId: digest('batch-one'), archiveSha256: digest('archive-one'),
    archiveBytes: statSync(f.backupPath).size, committedAt: 400 });
  assert.equal(result.archivedRows, 2);
  assert.equal(result.after.ledgerSchemaVersion, 4);
  assert.equal(raw(f.source, db => db.prepare('SELECT seq FROM audit').get().seq, { readOnly: true }), 3);
  assert.equal(raw(f.source, db => db.prepare('PRAGMA user_version').get().user_version, { readOnly: true }), 4);
  assert.equal(raw(f.source, db => db.prepare('SELECT count(*) n FROM audit_archive_coverage').get().n,
    { readOnly: true }), 2);
  const reader = new SqliteKernel(f.source, { readOnly: true });
  try {
    const history = reader.auditArchiveHistory('run-a');
    assert.equal(history.archivedRowCount, 1);
    assert.equal(history.online.rowCount, 0);
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].batch.highwaterSeq, '3');
    assert.equal(history.items[0].coverage.auditDigest.length, 64);
    assert.equal(reader.auditArchiveBatch('run-a', digest('batch-one')).batch.rowCount, 2);
    assert.equal(reader.auditArchiveBatch('run-c', digest('batch-one')), null);
    assert.equal(reader.auditArchiveHistory('absent'), null);
    assert.equal(reader.inspect('run-a').auditHistory.archivedRowCount, 1);
  } finally { reader.close(); }
  const coverage = raw(f.source, db => db.prepare('SELECT row_count AS rowCount,min_seq AS minSeq,max_seq AS maxSeq,audit_digest AS auditDigest FROM audit_archive_coverage WHERE run_key=?').get('run-a'), { readOnly: true });
  const query = queryArchivedAudit(f.backupPath, { runKey: 'run-a', cutoffAt: 250,
    highwaterSeq: '3', expectedCoverage: { rowCount: coverage.rowCount,
      minSeq: String(coverage.minSeq), maxSeq: String(coverage.maxSeq), auditDigest: coverage.auditDigest } });
  assert.equal(query.coverageVerified, true);
  assert.deepEqual(query.items.map(item => item.kind), ['event.admitted']);
  assert.equal(query.items[0].detailsBase64, undefined);
});

test('schema 4 storage projection queries archive tables only with bounded LIMIT', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'old'); f.setTime(300); claim(kernel, 'anchor'); f.close(kernel);
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  await applyAuditArchive(f.source, { backupPath: f.backupPath, expectedPreview: preview,
    batchId: digest('storage'), archiveSha256: digest('archive'),
    archiveBytes: statSync(f.backupPath).size, committedAt: 400 });
  const reader = new SqliteKernel(f.source, { readOnly: true });
  const original = DatabaseSync.prototype.prepare, seen = [];
  DatabaseSync.prototype.prepare = function(sql) { seen.push(sql); return original.call(this, sql); };
  try {
    const report = reader.storageSnapshot({ scanLimit: 1 });
    assert.equal(report.ledgerSchemaVersion, 4);
  } finally { DatabaseSync.prototype.prepare = original; reader.close(); }
  const archiveQueries = seen.filter(sql => /audit_archive_(batches|coverage)/.test(sql));
  assert.equal(archiveQueries.length, 2);
  assert.ok(archiveQueries.every(sql => /\bLIMIT\s*\?/i.test(sql)));
});

test('two batches preserve prior metadata, append-only audit anchor, and bounded history paging', async t => {
  const f = fixture(t), writer = f.open();
  claim(writer, 'run-a'); f.setTime(200); claim(writer, 'run-b'); f.setTime(300); claim(writer, 'run-c');
  f.close(writer);
  await f.backup();
  const first = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  const firstId = digest('first');
  await applyAuditArchive(f.source, { backupPath: f.backupPath, expectedPreview: first,
    batchId: firstId, archiveSha256: digest('archive-first'), archiveBytes: statSync(f.backupPath).size,
    committedAt: 350 });
  const again = f.open(); f.setTime(400); claim(again, 'run-d'); f.close(again);
  const secondBackup = await f.backup('second');
  const second = previewAuditArchive(f.source, { backupPath: secondBackup, cutoffAt: 350 });
  assert.equal(second.previousBatchId, firstId);
  assert.equal(second.selection.highwaterSeq, '4');
  assert.equal(second.selection.rowCount, 1);
  const secondId = digest('second');
  await applyAuditArchive(f.source, { backupPath: secondBackup, expectedPreview: second,
    batchId: secondId, archiveSha256: digest('archive-second'), archiveBytes: statSync(secondBackup).size,
    committedAt: 450 });
  assert.deepEqual(raw(f.source, db => db.prepare('SELECT seq FROM audit ORDER BY seq').all().map(x => x.seq),
    { readOnly: true }), [4]);
  const reader = new SqliteKernel(f.source, { readOnly: true });
  try {
    assert.equal(reader.inspect('run-c').auditHistory.archivedRowCount, 1);
    const page = reader.auditArchiveHistory('run-c', { limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.batchCount, 1);
    assert.equal(page.online.rowCount, 0);
    assert.equal(reader.auditArchiveHistory('run-d').archived, false);
    assert.equal(reader.auditArchiveHistory('run-d').online.rowCount, 1);
  } finally { reader.close(); }
  const appended = f.open(); f.setTime(500); claim(appended, 'run-e'); f.close(appended);
  assert.deepEqual(raw(f.source, db => db.prepare('SELECT seq FROM audit ORDER BY seq').all().map(x => x.seq),
    { readOnly: true }), [4, 5]);
});

test('stale source or archive and pre-commit failure never delete audit rows', async t => {
  const f = fixture(t), writer = f.open();
  claim(writer, 'run-a'); f.setTime(200); claim(writer, 'run-b'); f.setTime(300); claim(writer, 'run-c');
  f.close(writer);
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  await assert.rejects(applyAuditArchive(f.source, { backupPath: f.backupPath,
    expectedPreview: preview, batchId: digest('failure'), archiveSha256: digest('archive'),
    archiveBytes: statSync(f.backupPath).size, committedAt: 400,
    onStage(stage) { if (stage === 'before-commit') throw Error('injected private failure'); } }),
  { code: 'archive_failed' });
  assert.deepEqual(raw(f.source, db => ({ version: db.prepare('PRAGMA user_version').get().user_version,
    seq: db.prepare('SELECT seq FROM audit ORDER BY seq').all().map(x => x.seq) }), { readOnly: true }),
  { version: 3, seq: [1, 2, 3] });
  const kernel = f.open(); f.setTime(350); claim(kernel, 'run-d'); f.close(kernel);
  await assert.rejects(applyAuditArchive(f.source, { backupPath: f.backupPath,
    expectedPreview: preview, batchId: digest('stale'), archiveSha256: digest('archive'),
    archiveBytes: statSync(f.backupPath).size, committedAt: 400 }),
  { code: 'archive_backup_mismatch' });
  assert.equal(raw(f.source, db => db.prepare('SELECT COUNT(*) n FROM audit').get().n,
    { readOnly: true }), 4);
});

test('core rejects empty and over-limit selections rather than partially deleting', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'one'); f.setTime(200); claim(kernel, 'two'); f.setTime(300); claim(kernel, 'anchor');
  f.close(kernel);
  await f.backup();
  assert.throws(() => previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 1 }),
    { code: 'archive_selection_empty' });
  assert.throws(() => previewAuditArchive(f.source, { backupPath: f.backupPath,
    cutoffAt: 250, maxRows: 1 }), { code: 'archive_selection_over_limit' });
  assert.deepEqual(raw(f.source, db => ({ version: db.prepare('PRAGMA user_version').get().user_version,
    rows: db.prepare('SELECT COUNT(*) n FROM audit').get().n }), { readOnly: true }),
  { version: 3, rows: 3 });
});

test('reusing an existing batch ID on a fresh selection is a durable conflict', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'one'); f.setTime(200); claim(kernel, 'two'); f.setTime(300); claim(kernel, 'anchor');
  f.close(kernel);
  await f.backup();
  const first = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 150 });
  const batchId = digest('duplicate');
  await applyAuditArchive(f.source, { backupPath: f.backupPath, expectedPreview: first,
    batchId, archiveSha256: digest('archive-one'), archiveBytes: statSync(f.backupPath).size,
    committedAt: 350 });
  const nextBackup = await f.backup('next');
  const second = previewAuditArchive(f.source, { backupPath: nextBackup, cutoffAt: 250 });
  await assert.rejects(applyAuditArchive(f.source, { backupPath: nextBackup,
    expectedPreview: second, batchId, archiveSha256: digest('archive-two'),
    archiveBytes: statSync(nextBackup).size, committedAt: 400 }),
  { code: 'archive_batch_conflict' });
  assert.deepEqual(raw(f.source, db => db.prepare('SELECT seq FROM audit ORDER BY seq').all().map(row => row.seq),
    { readOnly: true }), [2, 3]);
});

test('query verifies full raw selection before paging and never emits details by default', async t => {
  const f = fixture(t), kernel = f.open();
  const handle = claim(kernel, 'run-a');
  f.setTime(150); kernel.append(handle, { kind: 'fixture.event', details: { secret: 'PRIVATE_PAYLOAD' } });
  f.setTime(300); claim(kernel, 'anchor'); f.close(kernel);
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  await applyAuditArchive(f.source, { backupPath: f.backupPath, expectedPreview: preview,
    batchId: digest('page'), archiveSha256: digest('archive'),
    archiveBytes: statSync(f.backupPath).size, committedAt: 400 });
  const reader = new SqliteKernel(f.source, { readOnly: true });
  let coverage;
  try { coverage = reader.auditArchiveBatch('run-a', digest('page')).coverage; }
  finally { reader.close(); }
  const first = queryArchivedAudit(f.backupPath, { runKey: 'run-a', cutoffAt: 250,
    highwaterSeq: '3', expectedCoverage: coverage, limit: 1 });
  assert.equal(first.verifiedRowCount, 2);
  assert.equal(first.items.length, 1);
  assert.equal(first.nextCursor, '1');
  assert.equal(JSON.stringify(first).includes('PRIVATE_PAYLOAD'), false);
  assert.equal(JSON.stringify(first).includes('detailsBase64'), false);
  const next = queryArchivedAudit(f.backupPath, { runKey: 'run-a', cutoffAt: 250,
    highwaterSeq: '3', expectedCoverage: coverage, afterSeq: first.nextCursor, includeDetails: true });
  assert.deepEqual(next.items.map(item => item.seq), ['2']);
  assert.match(Buffer.from(next.items[0].detailsBase64, 'base64').toString(), /PRIVATE_PAYLOAD/);
  assert.equal(next.nextCursor, null);
  assert.throws(() => queryArchivedAudit(f.backupPath, { runKey: 'run-a', cutoffAt: 250,
    highwaterSeq: '3', expectedCoverage: { ...coverage, auditDigest: digest('wrong') } }),
  { code: 'archive_coverage_mismatch' });
});

test('post-commit callback failure is uncertain although archival may already be committed', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'old'); f.setTime(300); claim(kernel, 'anchor'); f.close(kernel);
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  await assert.rejects(applyAuditArchive(f.source, { backupPath: f.backupPath,
    expectedPreview: preview, batchId: digest('uncertain'), archiveSha256: digest('archive'),
    archiveBytes: statSync(f.backupPath).size, committedAt: 400,
    onStage(stage) { if (stage === 'after-commit') throw Error('injected private failure'); } }),
  { code: 'archive_uncertain' });
  const reader = new SqliteKernel(f.source, { readOnly: true });
  try {
    assert.equal(reader.inspect('old').auditHistory.archived, true);
    assert.equal(reader.auditArchiveBatch('old', digest('uncertain')).coverage.rowCount, 1);
  } finally { reader.close(); }
});

test('audit sequence MAX guard rejects append without random rowid reuse', t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'old'); f.close(kernel);
  raw(f.source, db => db.prepare('UPDATE audit SET seq=? WHERE seq=1').run(9223372036854775807n));
  const again = f.open();
  try { assert.throws(() => claim(again, 'new'), /Audit sequence exhausted/); }
  finally { f.close(again); }
  assert.equal(raw(f.source, db => db.prepare('SELECT COUNT(*) n FROM runs').get().n,
    { readOnly: true }), 1);
  assert.equal(raw(f.source, db => {
    const statement = db.prepare('SELECT MAX(seq) AS seq FROM audit');
    statement.setReadBigInts(true);
    return statement.get().seq;
  }, { readOnly: true }), 9223372036854775807n);
});

test('an open schema 3 reader fences exclusive archival; a reopened reader sees schema 4', async t => {
  const f = fixture(t), writer = f.open();
  claim(writer, 'old'); f.setTime(300); claim(writer, 'anchor'); f.close(writer);
  const reader = new SqliteKernel(f.source, { readOnly: true });
  assert.equal(reader.inspect('old').auditHistory.archived, false);
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  await assert.rejects(applyAuditArchive(f.source, { backupPath: f.backupPath, expectedPreview: preview,
    batchId: digest('refresh'), archiveSha256: digest('archive'),
    archiveBytes: statSync(f.backupPath).size, committedAt: 400 }),
  { code: 'archive_lock_failed' });
  assert.equal(reader.inspect('old').auditHistory.archived, false);
  reader.close();
  await applyAuditArchive(f.source, { backupPath: f.backupPath, expectedPreview: preview,
    batchId: digest('refresh'), archiveSha256: digest('archive'),
    archiveBytes: statSync(f.backupPath).size, committedAt: 400 });
  const reopened = new SqliteKernel(f.source, { readOnly: true });
  try {
    assert.ok(reopened.evidenceSnapshot('old'));
    assert.equal(reopened.inspect('old').auditHistory.archivedRowCount, 1);
    assert.equal(reopened.auditArchiveHistory('old').items.length, 1);
  } finally { reopened.close(); }
});

test('a long-lived reader refreshes schema version after synthetic ordinary WAL schema-4 commit', async t => {
  const f = fixture(t), writer = f.open();
  claim(writer, 'old'); f.setTime(300); claim(writer, 'anchor'); f.close(writer);
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  const reader = new SqliteKernel(f.source, { readOnly: true });
  try {
    assert.equal(reader.inspect('old').auditHistory.archived, false);
    // This intentionally uses an ordinary WAL writer, not applyAuditArchive.
    // Actual archival requires exclusive access and rejects the open reader.
    raw(f.source, db => {
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      try {
        for (const ddl of Object.values(AUDIT_ARCHIVE_TABLE_SQL)) db.exec(ddl);
        db.exec('PRAGMA user_version=4');
        db.prepare('INSERT INTO audit_archive_batches VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
          digest('synthetic-wal'), null, digest('archive'), statSync(f.backupPath).size,
          3, preview.sourceSnapshot.logicalDigest, 250, 2, 1, preview.selection.auditDigest, 400);
        db.prepare('INSERT INTO audit_archive_coverage VALUES(?,?,?,?,?,?)').run(
          'old', digest('synthetic-wal'), 1, 1, 1, preview.selection.auditDigest);
        db.prepare('DELETE FROM audit WHERE seq=1').run();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    assert.ok(reader.evidenceSnapshot('old'));
    assert.equal(reader.inspect('old').auditHistory.archivedRowCount, 1);
    assert.equal(reader.auditArchiveHistory('old').batchCount, 1);
  } finally { reader.close(); }
});

test('large INTEGER sequence and invalid UTF-8 detail bytes preserve exact archive digest', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'old'); f.setTime(300); claim(kernel, 'anchor'); f.close(kernel);
  const large = 9007199254740993n;
  raw(f.source, db => {
    db.prepare("UPDATE audit SET seq=?,details=CAST(X'80' AS TEXT) WHERE run_key='old'").run(large);
    db.prepare("UPDATE audit SET seq=? WHERE run_key='anchor'").run(large + 1n);
  });
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  assert.equal(preview.selection.highwaterSeq, String(large + 1n));
  await applyAuditArchive(f.source, { backupPath: f.backupPath, expectedPreview: preview,
    batchId: digest('raw'), archiveSha256: digest('archive'),
    archiveBytes: statSync(f.backupPath).size, committedAt: 400 });
  const reader = new SqliteKernel(f.source, { readOnly: true });
  let coverage;
  try { coverage = reader.auditArchiveBatch('old', digest('raw')).coverage; }
  finally { reader.close(); }
  assert.equal(coverage.minSeq, String(large));
  const query = queryArchivedAudit(f.backupPath, { runKey: 'old', cutoffAt: 250,
    highwaterSeq: String(large + 1n), expectedCoverage: coverage, includeDetails: true });
  assert.equal(query.items[0].seq, String(large));
  assert.equal(query.items[0].detailsBase64, 'gA==');
  assert.equal(query.items[0].detailsDigest, createHash('sha256').update(Buffer.from([0x80])).digest('hex'));
});

test('schema 4 metadata corruption fails closed in evidence, history and direct batch reads', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'old'); f.setTime(300); claim(kernel, 'anchor'); f.close(kernel);
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  const batchId = digest('corruption');
  await applyAuditArchive(f.source, { backupPath: f.backupPath, expectedPreview: preview,
    batchId, archiveSha256: digest('archive'), archiveBytes: statSync(f.backupPath).size,
    committedAt: 400 });
  const rejects = () => {
    const reader = new SqliteKernel(f.source, { readOnly: true });
    try {
      assert.throws(() => reader.evidenceSnapshot('old'), /Invalid audit archive metadata/);
      assert.throws(() => reader.auditArchiveHistory('old'), /Invalid audit archive metadata/);
      assert.throws(() => reader.auditArchiveBatch('old', batchId), /Invalid audit archive metadata/);
    } finally { reader.close(); }
  };
  raw(f.source, db => db.prepare('UPDATE audit_archive_batches SET source_schema_version=4 WHERE id=?').run(batchId));
  rejects();
  raw(f.source, db => db.prepare('UPDATE audit_archive_batches SET source_schema_version=3 WHERE id=?').run(batchId));
  raw(f.source, db => { db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('UPDATE audit_archive_coverage SET run_key=? WHERE batch_id=?').run('orphan', batchId); });
  rejects();
  raw(f.source, db => db.prepare('UPDATE audit_archive_coverage SET run_key=? WHERE batch_id=?').run('old', batchId));
  raw(f.source, db => db.prepare('UPDATE audit SET seq=1 WHERE seq=2').run());
  rejects();
});

test('ordinary schema 4 writes retain corrupt archival metadata while explicit evidence reads reject it', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'old'); f.setTime(300); claim(kernel, 'anchor'); f.close(kernel);
  await f.backup();
  const preview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
  const batchId = digest('metadata-ordinary');
  await applyAuditArchive(f.source, { backupPath: f.backupPath, expectedPreview: preview,
    batchId, archiveSha256: digest('archive'), archiveBytes: statSync(f.backupPath).size,
    committedAt: 400 });
  raw(f.source, db => db.prepare('UPDATE audit_archive_batches SET source_schema_version=4 WHERE id=?').run(batchId));
  const ordinary = f.open();
  f.setTime(500);
  try {
    claim(ordinary, 'new');
    assert.throws(() => ordinary.evidenceSnapshot('new'), /Invalid audit archive metadata/);
  } finally { f.close(ordinary); }
  assert.deepEqual(raw(f.source, db => ({ version: db.prepare('PRAGMA user_version').get().user_version,
    sourceVersion: db.prepare('SELECT source_schema_version AS n FROM audit_archive_batches WHERE id=?').get(batchId).n,
    appended: db.prepare("SELECT COUNT(*) AS n FROM audit WHERE run_key='new'").get().n }),
  { readOnly: true }), { version: 4, sourceVersion: 4, appended: 1 });
});

test('archive core rejects UTF-16 ledgers before selection or query', async t => {
  const f = fixture(t);
  raw(f.source, db => db.exec(`PRAGMA encoding='UTF-16le';
    CREATE TABLE packs (id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
      body TEXT NOT NULL, PRIMARY KEY(id, version)) STRICT`));
  const kernel = f.open();
  claim(kernel, 'old'); f.setTime(300); claim(kernel, 'anchor'); f.close(kernel);
  await f.backup();
  assert.throws(() => previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 }),
    { code: 'archive_encoding_unsupported' });
  assert.throws(() => queryArchivedAudit(f.backupPath, { runKey: 'old', cutoffAt: 250,
    highwaterSeq: '2', expectedCoverage: { rowCount: 1, minSeq: '1', maxSeq: '1',
      auditDigest: digest('synthetic') } }), { code: 'archive_encoding_unsupported' });
  assert.equal(raw(f.source, db => db.prepare('PRAGMA user_version').get().user_version,
    { readOnly: true }), 3);
});

test('archive selection rejects stored run keys beyond the product bound', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'anchor'); f.close(kernel);
  raw(f.source, db => {
    db.prepare('UPDATE audit SET seq=2 WHERE seq=1').run();
    const key = 'x'.repeat(1025);
    db.prepare("INSERT INTO runs VALUES(?,?,'admitted',1,'fixture',10000,'{}',NULL)")
      .run(key, digest('oversized'));
    db.prepare("INSERT INTO audit VALUES(1,?,'synthetic','{}',100)").run(key);
  });
  await f.backup();
  assert.throws(() => previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 }),
    { code: 'archive_run_key_invalid' });
  assert.equal(raw(f.source, db => db.prepare('SELECT COUNT(*) n FROM audit').get().n,
    { readOnly: true }), 2);
});

test('archive selection rejects invalid UTF-8 run-key bytes without deleting them', async t => {
  const f = fixture(t), kernel = f.open();
  claim(kernel, 'anchor'); f.close(kernel);
  raw(f.source, db => {
    db.prepare('UPDATE audit SET seq=2 WHERE seq=1').run();
    db.exec(`INSERT INTO runs VALUES(CAST(X'80' AS TEXT),'synthetic','admitted',1,
      'fixture',10000,'{}',NULL);
      INSERT INTO audit VALUES(1,CAST(X'80' AS TEXT),'synthetic','{}',100)`);
  });
  await f.backup();
  assert.throws(() => previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 }),
    { code: 'archive_run_key_invalid' });
  assert.equal(raw(f.source, db => db.prepare('SELECT COUNT(*) n FROM audit').get().n,
    { readOnly: true }), 2);
});

for (const holdStage of ['before-commit', 'after-commit']) {
  test(`killing a separate process at ${holdStage} reopens as one atomic archival state`,
    { timeout: 15000 }, async t => {
      const f = fixture(t), kernel = f.open();
      claim(kernel, 'old'); f.setTime(300); claim(kernel, 'anchor'); f.close(kernel);
      await f.backup();
      const expectedPreview = previewAuditArchive(f.source, { backupPath: f.backupPath, cutoffAt: 250 });
      const batchId = digest(holdStage);
      const options = { backupPath: f.backupPath, expectedPreview, batchId,
        archiveSha256: digest('archive'), archiveBytes: statSync(f.backupPath).size, committedAt: 400 };
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/audit-archive-kill.mjs', import.meta.url)),
        f.source, JSON.stringify(options), holdStage], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const closed = new Promise(resolve => child.once('close', resolve));
      try {
        const received = await waitForBarrier(child);
        assert.deepEqual(received, { stage: holdStage });
      } finally { await killAndClose(child, closed); }
      const reader = new SqliteKernel(f.source, { readOnly: true });
      try {
        const archived = holdStage === 'after-commit';
        assert.equal(reader.inspect('old').auditHistory.archived, archived);
        assert.equal(reader.auditArchiveBatch('old', batchId) !== null, archived);
      } finally { reader.close(); }
      assert.equal(raw(f.source, db => db.prepare('PRAGMA user_version').get().user_version,
        { readOnly: true }), holdStage === 'after-commit' ? 4 : 3);
    });
}

test('a child that never sends the barrier is timed out, killed, and fully closed',
  { timeout: 15000 }, async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/audit-archive-kill.mjs', import.meta.url)),
      'unused', '{}', 'never-send'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    try { await assert.rejects(waitForBarrier(child, 200), /fixture barrier timeout/); }
    finally { await killAndClose(child, closed); }
    assert.ok(child.exitCode !== null || child.signalCode !== null);
});
