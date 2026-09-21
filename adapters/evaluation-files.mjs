import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { ContractError, canonical } from '../dist/index.js';

export const EVALUATION_FILE_LIMIT = 4 * 1024 * 1024;
const fail = () => { throw new ContractError('Evaluation file unavailable, oversized or invalid'); };

/** Explicit regular file only; bounded bytes/fatal UTF-8, no config discovery or raw parser errors. */
export function readEvaluationJson(path, maxBytes = EVALUATION_FILE_LIMIT) {
  if (typeof path !== 'string' || !path || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EVALUATION_FILE_LIMIT) fail();
  let fd;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxBytes) fail();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) fail();
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) fail();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch { fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Reserve before any paid evaluation. An interrupted/failed receipt is never overwritten or retried automatically. */
export function reserveEvaluationOutput(path) {
  if (typeof path !== 'string' || !path) throw new ContractError('Explicit new evaluation output required');
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch { throw new ContractError('Evaluation output must be a new file in an existing directory'); }
  let finished = false;
  const write = value => {
    const bytes = Buffer.from(canonical(value) + '\n');
    if (bytes.length > EVALUATION_FILE_LIMIT) throw new ContractError('Evaluation output size limit exceeded');
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('Short evaluation write');
      offset += count;
    }
    fsyncSync(fd);
  };
  try { write({ schemaVersion: 1, kind: 'reflexmesh-evaluation-incomplete', retryAllowed: false }); }
  catch { closeSync(fd); throw new ContractError('Evaluation output reservation failed'); }
  return {
    finish(value) {
      if (finished) throw new ContractError('Evaluation output already closed');
      try { write(value); }
      catch { throw new ContractError('Evaluation result could not be persisted; do not automatically repeat remote requests'); }
      finally { finished = true; closeSync(fd); }
    },
    close() { if (!finished) { finished = true; closeSync(fd); } },
  };
}
