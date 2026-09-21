import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export class BackupError extends Error {
  constructor(code = 'backup_failed') { super(`ReflexMesh backup: ${code}`); this.code = code; this.name = 'BackupError'; }
}
export const BACKUP_FAILURE_CODES = new Set(['backup_runtime_unsupported', 'backup_source_invalid',
  'backup_destination_invalid', 'backup_schema_unrecognized', 'backup_integrity_failed', 'backup_foreign_keys_failed',
  'backup_journal_not_delete', 'backup_sidecar_present', 'backup_failed', 'backup_manifest_invalid',
  'archive_changed', 'archive_mismatch', 'manifest_mismatch', 'archive_incomplete', 'archive_layout_invalid',
  'archive_has_sidecars', 'unsafe_file', 'unsafe_source_sidecar', 'archive_unreadable', 'metadata_too_large']);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const control = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
export function explicitLocalPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1000 || control.test(value)
    || value === ':memory:' || /^[\\/]{2}/.test(value)
    || process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':'))
    || process.platform !== 'win32' && !isAbsolute(value)) throw new BackupError('invalid_path');
  return resolve(value);
}
export function regularFile(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 0n
    || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new BackupError('unsafe_file');
  return stat;
}
export function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}
/** Older Windows Node path stats can report dev=0 while handle stats know the volume.
 * This exception is cross-path/handle only; never weaken either object's before/after identity. */
export function sameOpenedFile(pathStat, handleStat, platform = process.platform) {
  const fields = ['ino', 'size', 'mtimeNs', 'ctimeNs'];
  return typeof pathStat.dev === 'bigint' && typeof handleStat.dev === 'bigint'
    && fields.every(key => typeof pathStat[key] === 'bigint' && pathStat[key] === handleStat[key])
    && (pathStat.dev === handleStat.dev || platform === 'win32' && pathStat.dev === 0n);
}
export function noSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(`${path}${suffix}`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new BackupError('archive_unreadable'); }
    throw new BackupError('archive_has_sidecars');
  }
}
export function sourcePath(value) {
  const selected = explicitLocalPath(value);
  regularFile(selected);
  const path = realpathSync(selected);
  regularFile(path);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { regularFile(`${path}${suffix}`); }
    catch (error) { if (error.code !== 'ENOENT') throw new BackupError('unsafe_source_sidecar'); }
  }
  return path;
}
export function reserveBackupDirectory(dbPath, outDir) {
  const source = sourcePath(dbPath), selected = explicitLocalPath(outDir);
  const parent = realpathSync(dirname(selected));
  if (!lstatSync(parent).isDirectory()) throw new BackupError('invalid_directory');
  const output = join(parent, basename(selected));
  const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (['', '-wal', '-shm', '-journal'].some(suffix => compare(output) === compare(`${source}${suffix}`)))
    throw new BackupError('source_output_overlap');
  mkdirSync(output, { mode: 0o700 }); // No recursive creation or existing-directory reuse.
  writeExclusive(join(output, 'INCOMPLETE'), 'ReflexMesh backup incomplete; do not restore.\n');
  return { source, output, directoryIdentity: directoryIdentity(output) };
}
export function directoryIdentity(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BackupError('unsafe_directory');
  return `${stat.dev}:${stat.ino}`;
}
export function archiveDirectory(value, { incomplete = false } = {}) {
  const selected = explicitLocalPath(value);
  directoryIdentity(selected);
  const path = realpathSync(selected);
  directoryIdentity(path);
  if (!incomplete && existsSync(join(path, 'INCOMPLETE'))) throw new BackupError('archive_incomplete');
  const expected = ['COMPLETE', 'ledger.sqlite', 'manifest.json', ...(incomplete ? ['INCOMPLETE'] : [])];
  if (readdirSync(path).sort().join(',') !== expected.sort().join(','))
    throw new BackupError('archive_layout_invalid');
  for (const name of expected) regularFile(join(path, name));
  return path;
}
export function writeExclusive(path, text) {
  let fd;
  try { fd = openSync(path, 'wx', 0o600); writeFileSync(fd, text); fsyncSync(fd); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readBounded(path, maximum = 64 * 1024) {
  const before = regularFile(path);
  if (before.size > BigInt(maximum)) throw new BackupError('metadata_too_large');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameOpenedFile(before, opened)) throw new BackupError('archive_changed');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0, read;
    while (length < buffer.length && (read = readSync(fd, buffer, length, buffer.length - length, length)) > 0) length += read;
    if (length > maximum || length !== Number(before.size)
      || fileIdentity(fstatSync(fd, { bigint: true })) !== fileIdentity(opened)
      || fileIdentity(regularFile(path)) !== fileIdentity(before)) throw new BackupError('archive_changed');
    return buffer.subarray(0, length);
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** Run inside the bounded worker, not the CLI process. No whole-file allocation. */
export function hashFile(path) {
  const before = regularFile(path), expected = fileIdentity(before);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameOpenedFile(before, opened)) throw new BackupError('archive_changed');
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, offset)) > 0) { hash.update(buffer.subarray(0, count)); offset += count; }
    if (offset !== Number(before.size) || fileIdentity(fstatSync(fd, { bigint: true })) !== fileIdentity(opened)
      || fileIdentity(regularFile(path)) !== expected) throw new BackupError('archive_changed');
    return { bytes: offset, sha256: hash.digest('hex'), identity: expected };
  } finally { if (fd !== undefined) closeSync(fd); }
}
