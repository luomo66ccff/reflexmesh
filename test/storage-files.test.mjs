import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { resolveStorageDatabasePath, storageFileSnapshot } from '../adapters/storage-files.mjs';

function temporary(t) {
  const root = realpathSync(tmpdir()), dir = mkdtempSync(join(root, 'reflexmesh-storage-files-'));
  t.after(() => { const path = realpathSync(dir); assert.equal(dirname(path), root);
    assert.ok(basename(path).startsWith('reflexmesh-storage-files-')); rmSync(path, { recursive: true, force: true }); });
  return dir;
}
test('storage metadata returns only logical lengths, absent sidecars and fixed statuses', t => {
  const path = join(temporary(t), 'private.sqlite'); writeFileSync(path, 'PRIVATE_CONTENT');
  writeFileSync(`${path}-wal`, '1234');
  const canonical = resolveStorageDatabasePath(path), report = storageFileSnapshot(canonical);
  assert.deepEqual(report.entries.database, { status: 'present', logicalBytes: 15 });
  assert.deepEqual(report.entries.wal, { status: 'present', logicalBytes: 4 });
  assert.deepEqual(report.entries.shm, { status: 'missing', logicalBytes: null });
  assert.equal(report.atomicWithDatabase, false); assert.equal(Object.isFrozen(report.entries), true);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false); assert.equal(JSON.stringify(report).includes(path), false);
});
test('missing/non-regular database paths fail without creation or raw path disclosure', t => {
  const dir = temporary(t);
  for (const value of [null, '', ':memory:', dir, join(dir, 'PRIVATE_MISSING.sqlite')])
    assert.throws(() => resolveStorageDatabasePath(value), e => /existing regular/.test(e.message) && !e.message.includes('PRIVATE'));
});
test('sidecar directory or symbolic-link metadata cannot masquerade as a regular zero-byte file', t => {
  const path = join(temporary(t), 'ledger.sqlite'); writeFileSync(path, ''); mkdirSync(`${path}-wal`);
  assert.deepEqual(storageFileSnapshot(path).entries.wal, { status: 'not_regular', logicalBytes: null });
  const symlink = storageFileSnapshot(path, { lstat: () => ({ isSymbolicLink: () => true, isFile: () => true, size: 99n }) });
  assert.equal(symlink.entries.database.status, 'not_regular');
});
test('permission/IO failures remain unavailable, not missing or zero bytes, with no error leak', () => {
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR']) {
    const report = storageFileSnapshot('PRIVATE_PATH', { lstat: () => { throw Object.assign(new Error('PRIVATE_ERROR'), { code }); } });
    assert.deepEqual(report.entries.wal, { status: 'unavailable', logicalBytes: null });
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  }
});
test('zero-byte regular files are present; unsafe or non-bigint sizes are never rounded', () => {
  const observe = size => storageFileSnapshot('fixture', { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, size }) });
  assert.deepEqual(observe(0n).entries.database, { status: 'present', logicalBytes: 0 });
  for (const size of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1, NaN]) assert.equal(observe(size).entries.wal.status, 'unavailable');
  assert.throws(() => storageFileSnapshot('')); assert.throws(() => storageFileSnapshot('a', { lstat: null }));
});
