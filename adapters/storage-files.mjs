import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContractError, snapshot } from '../dist/index.js';

/** Canonicalize the explicitly selected existing database, including its parent aliases. */
export function resolveStorageDatabasePath(path) {
  try {
    if (typeof path !== 'string' || !path || path === ':memory:') throw new Error('Invalid path');
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isFile()) throw new Error('Not a file');
    return canonical;
  } catch { throw new ContractError('Storage diagnostics require an existing regular database file'); }
}

/** Metadata only. A missing sidecar is distinct from an unreadable one; never follow sidecar links. */
export function storageFileSnapshot(canonicalPath, { lstat = lstatSync } = {}) {
  if (typeof canonicalPath !== 'string' || !canonicalPath || typeof lstat !== 'function')
    throw new ContractError('Invalid storage metadata request');
  const observe = path => {
    try {
      const entry = lstat(path, { bigint: true });
      if (entry.isSymbolicLink() || !entry.isFile()) return { status: 'not_regular', logicalBytes: null };
      if (typeof entry.size !== 'bigint' || entry.size < 0n || entry.size > BigInt(Number.MAX_SAFE_INTEGER))
        return { status: 'unavailable', logicalBytes: null };
      return { status: 'present', logicalBytes: Number(entry.size) };
    } catch (error) { return { status: error?.code === 'ENOENT' ? 'missing' : 'unavailable', logicalBytes: null }; }
  };
  return snapshot({ measurement: 'logical-file-lengths-not-disk-allocation', atomicWithDatabase: false,
    entries: { database: observe(canonicalPath), wal: observe(`${canonicalPath}-wal`), shm: observe(`${canonicalPath}-shm`) } });
}
