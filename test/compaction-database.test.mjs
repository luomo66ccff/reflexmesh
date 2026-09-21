import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBackupDatabase } from '../adapters/backup-database.mjs';
import { compactLedger, CompactionDatabaseError, ledgerSnapshot } from '../adapters/compaction-database.mjs';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';

const prefix = 'reflexmesh-compaction-db-';
const writerFixture = fileURLToPath(new URL('./fixtures/compaction-writer.mjs', import.meta.url));
const workerFixture = fileURLToPath(new URL('./fixtures/compaction-worker.mjs', import.meta.url));
function fixture(t) {
  const temp = realpathSync(tmpdir()), dir = mkdtempSync(join(temp, prefix));
  const source = join(dir, 'state.sqlite'), archive = join(dir, 'archive');
  const backup = join(archive, 'ledger.sqlite');
  mkdirSync(archive, { mode: 0o700 });
  const kernels = new Set();
  t.after(() => {
    for (const kernel of kernels) kernel.close();
    const resolved = realpathSync(dir);
    assert.equal(dirname(resolved).toLowerCase(), temp.toLowerCase());
    assert.ok(basename(resolved).startsWith(prefix));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { dir, source, backup,
    open() { const kernel = new SqliteKernel(source); kernels.add(kernel); return kernel; },
    close(kernel) { kernel.close(); kernels.delete(kernel); },
    async backUp() { closeSync(openSync(backup, 'wx', 0o600)); return createBackupDatabase(source, backup); },
  };
}
function raw(path, callback, options = {}) {
  const db = new DatabaseSync(path, options);
  try { return callback(db); } finally { db.close(); }
}
function seed(f, { freePages = false } = {}) {
  const kernel = f.open();
  kernel.claim({ key: 'run-a', requestDigest: digest('request-a'), owner: 'fixture', leaseMs: 10000,
    evidence: { mode: 'shadow', body: 'PRIVATE_EVIDENCE' } });
  f.close(kernel);
  raw(f.source, db => {
    db.prepare('INSERT INTO labels VALUES(?,?,?)').run('run-a', 'label-a', 'PRIVATE_LABEL');
    db.prepare('INSERT INTO recovery_reviews VALUES(?,?,?,?,?,?)').run('run-a', 'review-a',
      'PRIVATE_REVIEW', digest('review'), 1, 42);
    db.prepare('INSERT INTO claude_hook_pairs VALUES(?,?,?,?,?,?,?,?)').run('pair-only', 'PRIVATE_TOKEN',
      digest('call'), digest('action'), digest('deployment'), null, 'blocked', 'before_failed');
    if (freePages) {
      const add = db.prepare('INSERT INTO observations VALUES(?,?,?)');
      for (let i = 0; i < 90; i++) add.run('run-a', `temporary-${i}`, 'PRIVATE_BULK'.repeat(1024));
      db.prepare("DELETE FROM observations WHERE id LIKE 'temporary-%'").run();
    }
  });
}
function sameLogical(left, right) {
  assert.equal(left.ledgerSchemaVersion, right.ledgerSchemaVersion);
  assert.equal(left.logicalDigest, right.logicalDigest);
  assert.deepEqual(left.rowCounts, right.rowCounts);
}

test('full explicit-row fingerprint survives VACUUM while free pages shrink and journal mode stays WAL', async t => {
  const f = fixture(t); seed(f, { freePages: true });
  const expected = ledgerSnapshot(f.source);
  assert.equal(expected.journalMode, 'wal');
  assert.ok(expected.pages.freelistCount > 0);
  assert.equal(expected.rowCounts.labels, 1);
  assert.equal(expected.rowCounts.recovery_reviews, 1);
  assert.equal(expected.rowCounts.claude_hook_pairs, 1);
  await f.backUp();
  const stages = [];
  const result = await compactLedger(f.source, { expectedSnapshot: expected, backupPath: f.backup,
    onStage: stage => { stages.push(stage); } });
  assert.deepEqual(stages, ['locked', 'before-vacuum', 'after-vacuum']);
  assert.equal(result.logicalContentPreserved, true);
  assert.deepEqual(result.before, expected);
  sameLogical(result.before, result.after);
  assert.equal(result.after.journalMode, 'wal');
  assert.equal(result.after.pages.pageSize, expected.pages.pageSize);
  assert.ok(result.after.pages.pageCount < result.before.pages.pageCount);
  assert.equal(result.after.pages.freelistCount, 0);
  sameLogical(ledgerSnapshot(f.source), expected);
});

for (const version of [1, 2]) test(`schema ${version} snapshot and VACUUM remain unmigrated`, async t => {
  const f = fixture(t), kernel = f.open();
  kernel.claim({ key: 'historical', requestDigest: digest('historical'), owner: 'fixture', leaseMs: 10000,
    evidence: { mode: 'shadow' } });
  f.close(kernel);
  raw(f.source, db => db.exec(`DROP INDEX runs_recovery_scan; DROP TABLE claude_hook_pairs;
    ${version === 1 ? 'DROP TABLE recovery_reviews;' : ''} PRAGMA user_version=${version};`));
  const expected = ledgerSnapshot(f.source);
  assert.equal(expected.ledgerSchemaVersion, version);
  assert.equal(expected.rowCounts.claude_hook_pairs, null);
  assert.equal(expected.rowCounts.recovery_reviews, version === 1 ? null : 0);
  await f.backUp();
  const result = await compactLedger(f.source, { expectedSnapshot: expected, backupPath: f.backup });
  sameLogical(result.before, result.after);
  assert.equal(raw(f.source, db => db.prepare('PRAGMA user_version').get().user_version, { readOnly: true }), version);
});

test('implicit rowid is excluded but 64-bit explicit INTEGER changes fingerprint without rounding', t => {
  const f = fixture(t); seed(f);
  const first = ledgerSnapshot(f.source);
  raw(f.source, db => db.exec("UPDATE runs SET rowid=rowid+1000 WHERE key='run-a'"));
  sameLogical(ledgerSnapshot(f.source), first);
  raw(f.source, db => db.prepare('INSERT INTO audit(seq,run_key,kind,details,at) VALUES(?,?,?,?,?)')
    .run(9007199254740993n, 'run-a', 'fixture', 'PRIVATE_AUDIT', 9007199254740993n));
  const large = ledgerSnapshot(f.source);
  assert.equal(large.rowCounts.audit, first.rowCounts.audit + 1);
  raw(f.source, db => db.prepare('UPDATE audit SET seq=?,at=? WHERE seq=?')
    .run(9007199254740994n, 9007199254740994n, 9007199254740993n));
  const adjacent = ledgerSnapshot(f.source);
  assert.notEqual(adjacent.logicalDigest, large.logicalDigest);
  assert.equal(adjacent.rowCounts.audit, large.rowCounts.audit);
});

test('same-row-count body and pairing reason changes alter the logical digest', t => {
  const f = fixture(t); seed(f);
  const original = ledgerSnapshot(f.source);
  raw(f.source, db => db.prepare('UPDATE labels SET body=? WHERE id=?').run('DIFFERENT_LABEL', 'label-a'));
  const labelChanged = ledgerSnapshot(f.source);
  assert.deepEqual(labelChanged.rowCounts, original.rowCounts);
  assert.notEqual(labelChanged.logicalDigest, original.logicalDigest);
  raw(f.source, db => db.prepare('UPDATE claude_hook_pairs SET reason_code=? WHERE key=?')
    .run('duplicate_pre', 'pair-only'));
  const reasonChanged = ledgerSnapshot(f.source);
  assert.deepEqual(reasonChanged.rowCounts, labelChanged.rowCounts);
  assert.notEqual(reasonChanged.logicalDigest, labelChanged.logicalDigest);
});

test('different malformed UTF-8 TEXT bytes cannot collapse through JavaScript replacement characters', t => {
  const f = fixture(t); seed(f);
  const setBody = byte => raw(f.source, db => db.prepare('UPDATE labels SET body=CAST(? AS TEXT) WHERE id=?')
    .run(Buffer.from([byte]), 'label-a'));
  setBody(0x80);
  const first = ledgerSnapshot(f.source);
  const firstDecoded = raw(f.source, db => db.prepare('SELECT body FROM labels WHERE id=?').get('label-a').body,
    { readOnly: true });
  setBody(0x81);
  const second = ledgerSnapshot(f.source);
  const secondDecoded = raw(f.source, db => db.prepare('SELECT body FROM labels WHERE id=?').get('label-a').body,
    { readOnly: true });
  assert.equal(firstDecoded, secondDecoded); // Both become U+FFFD through Node's text decoder.
  assert.deepEqual(first.rowCounts, second.rowCounts);
  assert.notEqual(first.logicalDigest, second.logicalDigest);
});

test('DELETE journal remains DELETE through compaction without changing schema', async t => {
  const f = fixture(t); seed(f);
  raw(f.source, db => assert.equal(db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode, 'delete'));
  const expected = ledgerSnapshot(f.source);
  assert.equal(expected.journalMode, 'delete');
  await f.backUp();
  const result = await compactLedger(f.source, { expectedSnapshot: expected, backupPath: f.backup });
  assert.equal(result.after.journalMode, 'delete');
  sameLogical(result.before, result.after);
});

test('stale source snapshot and wrong archive reject before VACUUM', async t => {
  const f = fixture(t); seed(f);
  const old = ledgerSnapshot(f.source);
  await f.backUp();
  raw(f.source, db => db.prepare('INSERT INTO packs VALUES(?,?,?,?)').run('later', '1', digest('later'), 'PRIVATE_PACK'));
  await assert.rejects(() => compactLedger(f.source, { expectedSnapshot: old, backupPath: f.backup }),
    error => error instanceof CompactionDatabaseError && error.code === 'compaction_stale_snapshot');
  const current = ledgerSnapshot(f.source), stage = [];
  await assert.rejects(() => compactLedger(f.source, { expectedSnapshot: current, backupPath: f.backup,
    onStage: value => stage.push(value) }),
  error => error instanceof CompactionDatabaseError && error.code === 'compaction_backup_mismatch');
  assert.deepEqual(stage, []);
  sameLogical(ledgerSnapshot(f.source), current);
});

test('read-only snapshot rejects foreign-key and schema damage before fingerprinting', t => {
  const f = fixture(t); seed(f);
  raw(f.source, db => {
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('INSERT INTO observations VALUES(?,?,?)').run('orphan', 'id', '{}');
  });
  assert.throws(() => ledgerSnapshot(f.source),
    error => error instanceof CompactionDatabaseError && error.code === 'compaction_foreign_keys_failed');
  raw(f.source, db => db.exec("DELETE FROM observations WHERE run_key='orphan'; DROP INDEX runs_recovery_scan"));
  assert.throws(() => ledgerSnapshot(f.source),
    error => error instanceof CompactionDatabaseError && error.code === 'compaction_schema_unrecognized');
});

for (const mode of ['wal', 'delete']) test(`post-COMMIT ${mode} exclusive lock rejects an independent OS writer before VACUUM`, async t => {
  const f = fixture(t); seed(f); const expected = ledgerSnapshot(f.source); await f.backUp();
  if (mode === 'delete') {
    raw(f.source, db => assert.equal(db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode, 'delete'));
  }
  const selected = ledgerSnapshot(f.source);
  assert.equal(selected.journalMode, mode);
  const stages = [];
  await compactLedger(f.source, { expectedSnapshot: selected, backupPath: f.backup,
    onStage: stage => {
      stages.push(stage);
      if (stage === 'locked' || stage === 'before-vacuum') {
        const child = spawnSync(process.execPath, [writerFixture, f.source],
          { encoding: 'utf8', timeout: 10000 });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout.trim(), 'busy');
      }
    },
  });
  assert.deepEqual(stages, ['locked', 'before-vacuum', 'after-vacuum']);
  sameLogical(ledgerSnapshot(f.source), expected);
});

test('synthetic SQLITE_FULL at VACUUM is uncertain, with source still reopenable', async t => {
  const f = fixture(t); seed(f, { freePages: true });
  const expected = ledgerSnapshot(f.source); await f.backUp();
  const originalExec = DatabaseSync.prototype.exec;
  let injected = 0;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'VACUUM') {
      injected++;
      const error = new Error('synthetic SQLITE_FULL');
      error.code = 'ERR_SQLITE_ERROR'; error.errcode = 13;
      throw error;
    }
    return originalExec.call(this, sql);
  };
  const stages = [];
  try {
    await assert.rejects(() => compactLedger(f.source, { expectedSnapshot: expected, backupPath: f.backup,
      onStage: stage => stages.push(stage) }),
    error => error instanceof CompactionDatabaseError && error.code === 'compaction_uncertain');
  } finally { DatabaseSync.prototype.exec = originalExec; }
  assert.equal(injected, 1);
  assert.deepEqual(stages, ['locked', 'before-vacuum']);
  sameLogical(ledgerSnapshot(f.source), expected);
});

test('post-VACUUM stage failure is uncertain even when full logical content survives', async t => {
  const f = fixture(t); seed(f, { freePages: true });
  const expected = ledgerSnapshot(f.source); await f.backUp();
  const stages = [];
  await assert.rejects(() => compactLedger(f.source, { expectedSnapshot: expected, backupPath: f.backup,
    onStage: stage => {
      stages.push(stage);
      if (stage === 'after-vacuum') throw new Error('synthetic postcheck I/O failure');
    } }),
  error => error instanceof CompactionDatabaseError && error.code === 'compaction_uncertain');
  assert.deepEqual(stages, ['locked', 'before-vacuum', 'after-vacuum']);
  const reopened = ledgerSnapshot(f.source);
  sameLogical(reopened, expected);
  assert.ok(reopened.pages.pageCount < expected.pages.pageCount);
});

async function gateAndKill(f, expected, gate) {
  const expectedFile = join(f.dir, `expected-${gate}.json`);
  writeFileSync(expectedFile, JSON.stringify(expected));
  const child = spawn(process.execPath, [workerFixture, f.source, f.backup, expectedFile, gate],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let output = '';
  const reached = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('compaction stage timed out')), 10000);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.includes('\n')) { clearTimeout(timer); resolve(output.trim()); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { if (!output.includes('\n')) { clearTimeout(timer); reject(new Error('child exited before stage')); } });
  });
  try { assert.equal(await reached, gate); }
  finally { child.kill('SIGKILL'); await closed; }
}
for (const gate of ['before-vacuum', 'after-vacuum']) test(`killed child at ${gate} reopens with complete logical rows`, { timeout: 20000 }, async t => {
  const f = fixture(t); seed(f, { freePages: true });
  const expected = ledgerSnapshot(f.source); await f.backUp();
  await gateAndKill(f, expected, gate);
  sameLogical(ledgerSnapshot(f.source), expected);
});

test('invalid options and absent source fail without creating a ledger', async t => {
  const f = fixture(t), missing = join(f.dir, 'missing.sqlite');
  assert.throws(() => ledgerSnapshot(missing), error => error.code === 'compaction_source_invalid');
  await assert.rejects(() => compactLedger(missing, { expectedSnapshot: {}, backupPath: f.backup }),
    error => error.code === 'compaction_snapshot_invalid');
  let getterCalls = 0;
  await assert.rejects(() => compactLedger(missing, { get expectedSnapshot() { getterCalls++; return {}; },
    backupPath: f.backup }), error => error.code === 'compaction_snapshot_invalid');
  assert.equal(getterCalls, 0);
  await assert.rejects(() => compactLedger(missing, { expectedSnapshot: {}, backupPath: f.backup,
    unexpected: 'field' }), error => error.code === 'compaction_snapshot_invalid');
  assert.equal(existsSync(f.source), false);
});
