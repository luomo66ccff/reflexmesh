import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { assertSqliteWalRuntime, classifySqliteVersion, inspectSqliteRuntime,
  SqliteRuntimeError } from '../adapters/sqlite-runtime.mjs';

function fixture(t) {
  const root = realpathSync(tmpdir()), dir = mkdtempSync(join(root, 'reflexmesh-sqlite-runtime-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.equal(dirname(target).toLowerCase(), root.toLowerCase());
    assert.ok(basename(target).startsWith('reflexmesh-sqlite-runtime-'));
    rmSync(target, { recursive: true, force: true });
  });
  return join(dir, 'PRIVATE_LEDGER.sqlite');
}

function withProbeVersion(version, action) {
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql === 'SELECT sqlite_version() AS version') return { get: () => ({ version }) };
    return original.call(this, sql);
  };
  try { return action(); }
  finally { DatabaseSync.prototype.prepare = original; }
}

test('pure classification recognizes only fixed release and backport lines', () => {
  for (const version of ['3.51.3', '3.51.4', '3.52.0', '3.44.6', '3.44.7', '3.50.7', '3.50.8'])
    assert.equal(classifySqliteVersion(version), 'present', version);
  for (const version of ['3.51.2', '3.50.6', '3.49.1', '3.45.3', '3.44.5', '3.43.0', '3.7.0'])
    assert.equal(classifySqliteVersion(version), 'affected', version);
  for (const version of [null, undefined, 3.51, '', '3.51', '3.51.3-extra', ' 3.51.3',
    '03.51.3', '3.051.3', '4.0.0', '2.99.0', '3.6.0', '3.9999999999999999999.1'])
    assert.equal(classifySqliteVersion(version), 'unknown', String(version));
});

test('actual independent in-memory probe returns bounded frozen metadata and no error body', () => {
  const view = inspectSqliteRuntime();
  assert.equal(Object.isFrozen(view), true);
  assert.deepEqual(Object.keys(view), ['schemaVersion', 'nodeVersion', 'sqliteVersion',
    'walResetFix', 'persistentWriteAllowed', 'probeStatus']);
  assert.equal(view.schemaVersion, 1);
  assert.match(view.nodeVersion, /^\d+\.\d+\.\d+$/);
  if (view.probeStatus === 'ok') {
    assert.match(view.sqliteVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(view.walResetFix, classifySqliteVersion(view.sqliteVersion));
    assert.equal(view.persistentWriteAllowed, view.walResetFix === 'present');
  } else {
    assert.equal(view.sqliteVersion, null);
    assert.equal(view.persistentWriteAllowed, false);
  }
});

test('a failed or malformed probe closes its independent connection and emits only fixed states', () => {
  const originalPrepare = DatabaseSync.prototype.prepare, originalClose = DatabaseSync.prototype.close;
  let closed = 0;
  DatabaseSync.prototype.close = function (...args) { closed++; return originalClose.apply(this, args); };
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql === 'SELECT sqlite_version() AS version') throw new Error('PRIVATE_PROBE_FAILURE_PATH_AND_TOKEN');
    return originalPrepare.call(this, sql);
  };
  try {
    const failed = inspectSqliteRuntime();
    assert.equal(failed.probeStatus, 'probe_failed');
    assert.equal(failed.sqliteVersion, null);
    assert.equal(failed.walResetFix, 'unknown');
    assert.equal(failed.persistentWriteAllowed, false);
    assert.equal(JSON.stringify(failed).includes('PRIVATE_PROBE_FAILURE_PATH_AND_TOKEN'), false);
    assert.equal(closed, 1);
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql === 'SELECT sqlite_version() AS version') return { get: () => ({ version: 'PRIVATE_BAD_VERSION' }) };
      return originalPrepare.call(this, sql);
    };
    const malformed = inspectSqliteRuntime();
    assert.equal(malformed.probeStatus, 'invalid_version');
    assert.equal(malformed.sqliteVersion, null);
    assert.equal(closed, 2);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    DatabaseSync.prototype.close = originalClose;
  }
});

test('affected runtime blocks new and existing writable files before creation, open or migration', t => {
  const path = fixture(t), before = existsSync(path);
  assert.equal(before, false);
  withProbeVersion('3.49.1', () => {
    assert.throws(() => new SqliteKernel(path), error => error instanceof SqliteRuntimeError
      && error.code === 'SQLITE_WAL_RUNTIME_UNSUPPORTED'
      && !error.message.includes(path) && !error.message.includes('3.49.1'));
    assert.equal(existsSync(path), false);
  });
  const db = new DatabaseSync(path);
  try { db.exec('CREATE TABLE historical (id TEXT PRIMARY KEY); INSERT INTO historical VALUES (\'retained\'); PRAGMA user_version=1;'); }
  finally { db.close(); }
  const bytes = readFileSync(path);
  withProbeVersion('3.49.1', () => {
    assert.throws(() => new SqliteKernel(path), SqliteRuntimeError);
    assert.deepEqual(readFileSync(path), bytes);
    const reader = new SqliteKernel(path, { readOnly: true });
    reader.close();
    const memory = new SqliteKernel(':memory:');
    memory.close();
  });
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(check.prepare('SELECT id FROM historical').get().id, 'retained');
  } finally { check.close(); }
});

test('fixed backport passes the live probe assertion while unknown future major remains blocked', () => {
  const accepted = withProbeVersion('3.50.7', () => assertSqliteWalRuntime());
  assert.equal(accepted.sqliteVersion, '3.50.7');
  assert.equal(accepted.persistentWriteAllowed, true);
  const future = withProbeVersion('4.0.0', () => inspectSqliteRuntime());
  assert.equal(future.probeStatus, 'ok');
  assert.equal(future.walResetFix, 'unknown');
  assert.equal(future.persistentWriteAllowed, false);
  withProbeVersion('4.0.0', () => assert.throws(() => assertSqliteWalRuntime(), SqliteRuntimeError));
});
