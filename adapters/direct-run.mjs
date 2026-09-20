import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function canonicalPath(path, canonicalize) {
  const absolute = resolve(path);
  try { return canonicalize(absolute); }
  catch { return absolute; }
}

/**
 * Detect direct ESM execution without assuming argv and import.meta.url use the
 * same textual path. Windows profile aliases, 8.3 paths and symlinks can name
 * the same entrypoint differently.
 */
export function isDirectRun(metaUrl, argvPath = process.argv[1], canonicalize = realpathSync.native) {
  if (typeof argvPath !== 'string' || argvPath.length === 0) return false;
  let modulePath;
  try { modulePath = fileURLToPath(metaUrl); }
  catch { return false; }
  const moduleReal = canonicalPath(modulePath, canonicalize);
  const argvReal = canonicalPath(argvPath, canonicalize);
  return process.platform === 'win32'
    ? moduleReal.toLowerCase() === argvReal.toLowerCase()
    : moduleReal === argvReal;
}
