#!/usr/bin/env node
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { ContractError } from '../dist/index.js';
import { SqliteKernel } from './sqlite-kernel.mjs';
import { validateRecoveryReview } from './recovery-contract.mjs';

const USAGE = `ReflexMesh local recovery review (never retries or executes tools)
  node adapters/recovery-cli.mjs list --db PATH [--limit 50] [--after KEY] [--include-reviewed]
  node adapters/recovery-cli.mjs inspect --db PATH --key KEY
  node adapters/recovery-cli.mjs review --db PATH --file REVIEW.json [--apply]
Omitting --apply is a read-only preview. Stop/quiesce workers and check external evidence first.
`;
const fail = message => { throw new ContractError(message); };
export function parseRecoveryOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const [command, ...rest] = argv;
  if (!['list','inspect','review'].includes(command)) fail('Expected list, inspect or review');
  const allowed = { list: ['db','limit','after','include-reviewed'], inspect: ['db','key'], review: ['db','file','apply'] }[command];
  const options = { command };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i], name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!allowed.includes(name) || Object.hasOwn(options, name)) fail('Unknown or duplicate recovery option');
    if (['apply','include-reviewed'].includes(name)) options[name] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) fail('Missing recovery option value');
      options[name] = value;
    }
  }
  if (!options.db || options.db === ':memory:') fail('An existing database path is required');
  if (command === 'inspect' && !options.key) fail('Recovery key required');
  if (command === 'review' && !options.file) fail('Recovery review file required');
  if (options.limit !== undefined) {
    if (!/^[0-9]+$/.test(options.limit)) fail('Invalid recovery page limit');
    options.limit = Number(options.limit);
    if (options.limit < 1 || options.limit > 100) fail('Invalid recovery page limit');
  }
  return options;
}
export async function readRecoveryFile(path) {
  const max = 16384;
  const entry = await lstat(path);
  if (!entry.isFile()) fail('Review must be a regular file of at most 16 KiB');
  // Refuse links/FIFOs before opening; also avoid following a replaced link or blocking on a FIFO on POSIX.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) fail('Review must be a regular file of at most 16 KiB');
    // Bound even a file that grows after stat; never echo its contents on a parse failure.
    const buffer = Buffer.alloc(max + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > max) fail('Review exceeds 16 KiB');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { fail('Invalid review JSON'); }
    return validateRecoveryReview(value);
  } finally { await handle.close(); }
}
export async function recoveryMain(argv, output = process.stdout) {
  const options = parseRecoveryOptions(argv);
  if (options.help) { output.write(USAGE); return; }
  const path = resolve(options.db);
  let kernel = new SqliteKernel(path, { readOnly: true });
  try {
    let result;
    if (options.command === 'list') {
      result = kernel.listRecoveries({ limit: options.limit ?? 50, after: options.after ?? '', includeReviewed: options['include-reviewed'] ?? false });
    } else if (options.command === 'inspect') {
      result = kernel.recoverySnapshot(options.key);
      if (!result) fail('Unknown recovery run');
    } else {
      const review = await readRecoveryFile(options.file);
      result = kernel.previewRecovery(review);
      if (options.apply) {
        kernel.close(); kernel = undefined;
        // Explicit apply may upgrade schema 1 to 2. reviewRecovery rechecks state atomically.
        kernel = new SqliteKernel(path);
        result = kernel.reviewRecovery(review);
      }
    }
    output.write(JSON.stringify(result, null, 2) + '\n');
  } finally { kernel?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await recoveryMain(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`ReflexMesh recovery: ${error instanceof ContractError ? error.message : 'database or input unavailable'}.\n`);
    process.exitCode = 1;
  }
}
