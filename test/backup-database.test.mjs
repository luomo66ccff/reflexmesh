import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { BackupDatabaseError, createBackupDatabase, inspectBackupDatabase } from '../adapters/backup-database.mjs';
import { fileIdentity, sameOpenedFile } from '../adapters/backup-files.mjs';

const requireBuiltin = createRequire(import.meta.url);
const prefix = 'reflexmesh-backup-database-';
function fixture(t) {
  const root = realpathSync(tmpdir()), dir = mkdtempSync(join(root, prefix));
  const source = join(dir, 'source.sqlite'), bundle = join(dir, 'bundle'), target = join(bundle, 'ledger.sqlite');
  const kernels = new Set();
  mkdirSync(bundle, { mode: 0o700 });
  t.after(() => {
    for (const kernel of kernels) kernel.close();
    const resolved = realpathSync(dir);
    assert.equal(dirname(resolved).toLowerCase(), root.toLowerCase());
    assert.ok(basename(resolved).startsWith(prefix));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { source, target,
    reserve() { closeSync(openSync(target, 'wx', 0o600)); },
    open() { const kernel = new SqliteKernel(source); kernels.add(kernel); return kernel; },
    close(kernel) { kernel.close(); kernels.delete(kernel); },
  };
}
function claim(kernel, key, body = 'PRIVATE_LEDGER_BODY') {
  return kernel.claim({ key, requestDigest: digest(key), owner: 'fixture', leaseMs: 10000,
    evidence: { mode: 'shadow', body } }).handle;
}
function raw(path, fn, options = {}) {
  const db = new DatabaseSync(path, options);
  try { return fn(db); } finally { db.close(); }
}
function variantSource(source, table, rewrite) {
  const definitions = raw(source, db => db.prepare(
    "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid").all(), { readOnly: true });
  const target = join(dirname(source), 'malformed.sqlite');
  raw(target, db => {
    for (const item of definitions) {
      const ddl = item.type === 'table' && item.name === table ? rewrite(item.sql) : item.sql;
      if (item.type === 'table' && item.name === table) assert.notEqual(ddl, item.sql);
      db.exec(ddl + ';');
    }
    db.exec('PRAGMA user_version=3');
  });
  return target;
}

test('native online backup captures committed WAL rows, preserves source version and produces a standalone DELETE archive', async t => {
  const f = fixture(t), writer = f.open();
  const handle = claim(writer, 'run-in-wal');
  writer.complete(handle, { status: 'shadow', verdict: { effect: 'escalate', ruleId: 'fixture' } });
  writer.observe('run-in-wal', { id: 'observation', status: 'unknown', provenance: 'harness-reported',
    evidenceDigest: digest('PRIVATE_OUTPUT') });
  assert.equal(existsSync(f.source + '-wal'), true);
  f.reserve();
  const beforeVersion = raw(f.source, db => db.prepare('PRAGMA user_version').get().user_version, { readOnly: true });
  const made = await createBackupDatabase(f.source, f.target);
  assert.equal(made.ledgerSchemaVersion, 3);
  assert.equal(made.summary.scanLimit, 1000);
  assert.equal(made.summary.tables.runs.total, 1);
  assert.equal(made.summary.tables.observations.total, 1);
  assert.equal(Object.isFrozen(made.summary), true);
  assert.equal(raw(f.source, db => db.prepare('PRAGMA user_version').get().user_version, { readOnly: true }), beforeVersion);
  assert.equal(raw(f.target, db => db.prepare('PRAGMA journal_mode').get().journal_mode, { readOnly: true }), 'delete');
  assert.equal(raw(f.target, db => db.prepare('SELECT key FROM runs').get().key, { readOnly: true }), 'run-in-wal');
  for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(f.target + suffix), false);
  const inspected = await inspectBackupDatabase(f.target);
  assert.deepEqual(inspected, made);
  const encoded = JSON.stringify(made);
  for (const secret of [f.source, f.target, 'run-in-wal', 'PRIVATE_LEDGER_BODY', 'PRIVATE_OUTPUT'])
    assert.equal(encoded.includes(secret), false);
});

for (const version of [1, 2, 3]) test(`schema ${version} backup retains version and unsupported-table coverage`, async t => {
  const f = fixture(t), writer = f.open(); claim(writer, 'historical'); f.close(writer);
  if (version < 3) raw(f.source, db => db.exec(`DROP INDEX runs_recovery_scan; DROP TABLE claude_hook_pairs;
    ${version === 1 ? 'DROP TABLE recovery_reviews;' : ''} PRAGMA user_version=${version};`));
  f.reserve();
  const result = await createBackupDatabase(f.source, f.target);
  assert.equal(result.ledgerSchemaVersion, version);
  assert.equal(result.summary.ledgerSchemaVersion, version);
  assert.equal(result.summary.tables.runs.total, 1);
  assert.equal(result.summary.tables.claude_hook_pairs.supported, version === 3);
  assert.equal(result.summary.tables.recovery_reviews.supported, version >= 2);
  assert.equal(raw(f.target, db => db.prepare('PRAGMA user_version').get().user_version, { readOnly: true }), version);
});

test('unrecognized source schema rejects before writing the reserved destination', async t => {
  const f = fixture(t);
  raw(f.source, db => db.exec('CREATE TABLE runs (key TEXT); PRAGMA user_version=3;'));
  f.reserve();
  await assert.rejects(() => createBackupDatabase(f.source, f.target),
    error => error instanceof BackupDatabaseError && error.code === 'backup_schema_unrecognized');
  assert.equal(readFileSync(f.target).length, 0);
});

for (const [name, alter] of [
  ['missing CHECK', path => variantSource(path, 'runs', sql =>
    sql.replace("CHECK(state IN ('admitted','executing','completed','unknown'))", ''))],
  ['wrong-case enum literal', path => variantSource(path, 'runs', sql =>
    sql.replace("'admitted'", "'ADMITTED'"))],
  ['whitespace inside enum literal', path => variantSource(path, 'runs', sql =>
    sql.replace("'admitted'", "'ad mitted'"))],
  ['missing foreign key', path => variantSource(path, 'audit', sql =>
    sql.replace('REFERENCES runs(key)', ''))],
  ['extra view', path => { raw(path, db => db.exec('CREATE VIEW extra AS SELECT key FROM runs')); return path; }],
  ['extra sqlite-prefixed user table', path => { raw(path, db => db.exec('CREATE TABLE sqliteXshadow (note TEXT) STRICT')); return path; }],
  ['index name spoofed by table', path => { raw(path, db => db.exec('DROP INDEX runs_recovery_scan; CREATE TABLE runs_recovery_scan (name TEXT) STRICT')); return path; }],
]) test(`schema recognizer rejects ${name} before destination copy`, async t => {
  const f = fixture(t), writer = f.open(); f.close(writer);
  const source = alter(f.source); f.reserve();
  await assert.rejects(() => createBackupDatabase(source, f.target),
    error => error instanceof BackupDatabaseError && error.code === 'backup_schema_unrecognized');
  assert.equal(readFileSync(f.target).length, 0);
});

test('read-only verification rejects changed journal mode, broken foreign keys and sidecars without repair', async t => {
  const f = fixture(t), writer = f.open();
  claim(writer, 'original'); f.close(writer); f.reserve();
  await createBackupDatabase(f.source, f.target);
  raw(f.target, db => {
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('INSERT INTO observations VALUES(?,?,?)').run('orphan', 'outcome', '{}');
  });
  await assert.rejects(() => inspectBackupDatabase(f.target),
    error => error instanceof BackupDatabaseError && error.code === 'backup_foreign_keys_failed');
  raw(f.target, db => db.exec("DELETE FROM observations WHERE run_key='orphan'; PRAGMA journal_mode=WAL;"));
  await assert.rejects(() => inspectBackupDatabase(f.target),
    error => error instanceof BackupDatabaseError && ['backup_journal_not_delete', 'backup_sidecar_present'].includes(error.code));
  raw(f.target, db => db.exec('PRAGMA journal_mode=DELETE'));
  closeSync(openSync(f.target + '-wal', 'wx', 0o600));
  await assert.rejects(() => inspectBackupDatabase(f.target),
    error => error instanceof BackupDatabaseError && error.code === 'backup_sidecar_present');
});

test('WAL header without sidecars is rejected before any SQLite open and leaves archive bytes and directory untouched', async t => {
  const f = fixture(t), writer = f.open(); claim(writer, 'original'); f.close(writer); f.reserve();
  await createBackupDatabase(f.source, f.target);
  const fd = openSync(f.target, 'r+');
  try { assert.equal(writeSync(fd, Buffer.from([2, 2]), 0, 2, 18), 2); }
  finally { closeSync(fd); }
  const beforeBytes = readFileSync(f.target), beforeEntries = readdirSync(dirname(f.target)).sort();
  assert.deepEqual(beforeEntries, ['ledger.sqlite']);
  const api = requireBuiltin('node:sqlite'), originalDatabase = api.DatabaseSync;
  const originalSnapshot = SqliteKernel.prototype.storageSnapshot;
  let databaseOpens = 0, storageReads = 0;
  api.DatabaseSync = class { constructor() { databaseOpens++; throw new Error('unexpected SQLite open'); } };
  SqliteKernel.prototype.storageSnapshot = function () { storageReads++; throw new Error('unexpected storage snapshot'); };
  try {
    await assert.rejects(() => inspectBackupDatabase(f.target),
      error => error instanceof BackupDatabaseError && error.code === 'backup_journal_not_delete');
  } finally {
    api.DatabaseSync = originalDatabase;
    SqliteKernel.prototype.storageSnapshot = originalSnapshot;
  }
  assert.equal(databaseOpens, 0);
  assert.equal(storageReads, 0);
  assert.deepEqual(readdirSync(dirname(f.target)).sort(), beforeEntries);
  assert.deepEqual(readFileSync(f.target), beforeBytes);
});

test('short or invalid SQLite headers are rejected without opening a database', async t => {
  const f = fixture(t); f.reserve();
  await assert.rejects(() => inspectBackupDatabase(f.target),
    error => error instanceof BackupDatabaseError && error.code === 'backup_source_invalid');
  const fd = openSync(f.target, 'r+');
  try { assert.equal(writeSync(fd, Buffer.alloc(20), 0, 20, 0), 20); }
  finally { closeSync(fd); }
  await assert.rejects(() => inspectBackupDatabase(f.target),
    error => error instanceof BackupDatabaseError && error.code === 'backup_source_invalid');
  assert.deepEqual(readdirSync(dirname(f.target)), ['ledger.sqlite']);
});

test('header identity uses exact bigints while tolerating only unknown Windows path device IDs', () => {
  const pathStat = { dev: 0n, ino: 9007199254740993n, size: 4096n, mtimeNs: 123n, ctimeNs: 456n };
  const opened = { ...pathStat, dev: 1689772372n };
  assert.equal(sameOpenedFile(pathStat, opened, 'win32'), true);
  assert.equal(sameOpenedFile(pathStat, opened, 'linux'), false);
  assert.equal(sameOpenedFile(pathStat, { ...opened, ino: opened.ino + 1n }, 'win32'), false);
  assert.equal(sameOpenedFile(pathStat, { ...opened, size: opened.size + 1n }, 'win32'), false);
  assert.notEqual(fileIdentity(pathStat), fileIdentity({ ...pathStat, ino: pathStat.ino + 1n }));
  assert.notEqual(fileIdentity(opened), fileIdentity({ ...opened, mtimeNs: opened.mtimeNs + 1n }));
});

test('header read detects archive mutation before SQLite opens', async t => {
  const f = fixture(t), writer = f.open(); claim(writer, 'original'); f.close(writer); f.reserve();
  await createBackupDatabase(f.source, f.target);
  const fsApi = requireBuiltin('node:fs'), originalRead = fsApi.readSync;
  let injected = false;
  fsApi.readSync = (...args) => {
    const count = originalRead(...args);
    if (!injected) { injected = true; appendFileSync(f.target, Buffer.from([0x58])); }
    return count;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => inspectBackupDatabase(f.target),
      error => error instanceof BackupDatabaseError && error.code === 'backup_source_invalid');
  } finally {
    fsApi.readSync = originalRead;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.deepEqual(readdirSync(dirname(f.target)), ['ledger.sqlite']);
});

test('verification rejects appended archive bytes instead of certifying hidden trailing data', async t => {
  const f = fixture(t), writer = f.open(); claim(writer, 'original'); f.close(writer); f.reserve();
  await createBackupDatabase(f.source, f.target);
  appendFileSync(f.target, Buffer.from([0x58]));
  await assert.rejects(() => inspectBackupDatabase(f.target), BackupDatabaseError);
});

test('source and reserved target symlinks are rejected without following the target', async t => {
  const f = fixture(t), writer = f.open(); f.close(writer);
  const sourceLink = join(dirname(f.source), 'source-link.sqlite');
  try { symlinkSync(f.source, sourceLink, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('Local symlinks unavailable'); throw error; }
  f.reserve();
  await assert.rejects(() => createBackupDatabase(sourceLink, f.target),
    error => error instanceof BackupDatabaseError && error.code === 'backup_source_invalid');
  assert.equal(readFileSync(f.target).length, 0);
  const alternate = join(dirname(f.source), 'alternate-bundle');
  mkdirSync(alternate);
  const targetLink = join(alternate, 'ledger.sqlite');
  symlinkSync(f.source, targetLink, 'file');
  await assert.rejects(() => createBackupDatabase(f.source, targetLink),
    error => error instanceof BackupDatabaseError && error.code === 'backup_destination_invalid');
  const other = join(dirname(f.source), 'other.sqlite');
  symlinkSync(f.source, other, 'file');
  await assert.rejects(() => inspectBackupDatabase(other),
    error => error instanceof BackupDatabaseError && error.code === 'backup_source_invalid');
});

test('native backup remains a coherent snapshot across a concurrent writer commit', async t => {
  const f = fixture(t), writer = f.open();
  for (let i = 0; i < 120; i++) claim(writer, `base-${i}`, 'x'.repeat(4096));
  f.reserve();
  const api = requireBuiltin('node:sqlite'), original = api.backup;
  let injected = false;
  api.backup = (source, target) => original(source, target, { rate: 1,
    progress: () => {
      if (!injected) { injected = true; claim(writer, 'concurrent-row'); }
    },
  });
  let result;
  try { result = await createBackupDatabase(f.source, f.target); }
  finally { api.backup = original; }
  assert.equal(injected, true);
  assert.equal(result.summary.tables.runs.total, raw(f.target, db => db.prepare('SELECT count(*) n FROM runs').get().n, { readOnly: true }));
  const counts = raw(f.target, db => ({ runs: db.prepare("SELECT count(*) n FROM runs WHERE key='concurrent-row'").get().n,
    audits: db.prepare("SELECT count(*) n FROM audit WHERE run_key='concurrent-row'").get().n }), { readOnly: true });
  assert.deepEqual(counts, { runs: 0, audits: 0 }); // The source BEGIN was pinned before progress ran.
  const sourceCounts = raw(f.source, db => ({ runs: db.prepare("SELECT count(*) n FROM runs WHERE key='concurrent-row'").get().n,
    audits: db.prepare("SELECT count(*) n FROM audit WHERE run_key='concurrent-row'").get().n }), { readOnly: true });
  assert.deepEqual(sourceCounts, { runs: 1, audits: 1 });
});
