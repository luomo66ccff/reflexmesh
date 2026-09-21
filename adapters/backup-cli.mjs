#!/usr/bin/env node
import { isDirectRun } from './direct-run.mjs';
import { BACKUP_FAILURE_CODES } from './backup-files.mjs';

export const BACKUP_USAGE = `ReflexMesh consistent ledger backup
  node adapters/backup-cli.mjs create --db ABS_FILE --out-dir NEW_ABS_DIRECTORY [--timeout-ms 30000] [--json]
  node adapters/backup-cli.mjs verify --dir ABS_ARCHIVE_DIRECTORY [--timeout-ms 30000] [--json]
  node adapters/backup-cli.mjs --help
Build first. Local trusted private directories only; existing output directories are never reused.
Create writes a full, unencrypted ledger copy. Source application rows are read-only.
Timeout/cancel/failure retains incomplete output; inspect manually, do not automatically retry.
Verify is local and read-only, not origin authentication or permission to restore an old snapshot.
Schema4 backups preserve online coverage, not older external audit bodies; external archive availability is NOT checked.
There is no production restore, deletion, provider call, or tool execution command.
For Windows paths containing spaces use this quoted Node entrypoint directly, not npm forwarding.
`;

export function parseBackupOptions(argv) {
  if (!Array.isArray(argv)) throw new Error('invalid_arguments');
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const [operation, ...rest] = argv;
  if (!['create', 'verify'].includes(operation)) throw new Error('invalid_arguments');
  const allowed = operation === 'create' ? ['db', 'out-dir', 'timeout-ms', 'json'] : ['dir', 'timeout-ms', 'json'];
  const values = {};
  for (let i = 0; i < rest.length; i++) {
    const key = typeof rest[i] === 'string' && rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw new Error('invalid_arguments');
    if (key === 'json') { values.json = true; continue; }
    const value = rest[++i];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('invalid_arguments');
    values[key] = value;
  }
  if (operation === 'create' && (!values.db || !values['out-dir']) || operation === 'verify' && !values.dir)
    throw new Error('invalid_arguments');
  if (values['timeout-ms'] !== undefined && (!/^[1-9]\d*$/.test(values['timeout-ms'])
    || Number(values['timeout-ms']) < 100 || Number(values['timeout-ms']) > 300000)) throw new Error('invalid_arguments');
  return { operation, values, timeoutMs: Number(values['timeout-ms'] ?? 30000) };
}

const publicCodes = new Set(['invalid_options', 'invalid_path', 'invalid_directory', 'unsafe_directory',
  'unsafe_file', 'unsafe_source_sidecar', 'source_output_overlap', 'archive_incomplete', 'archive_layout_invalid',
  'archive_changed', 'archive_has_sidecars', 'backup_cancelled', 'backup_timeout', 'worker_start_failed',
  'worker_termination_unconfirmed', 'backup_verification_failed']);
function codeFor(error) {
  if (error?.code === 'SQLITE_WAL_RUNTIME_UNSUPPORTED') return 'sqlite_runtime_unsupported';
  if (error?.code === 'EEXIST') return 'output_exists';
  if (error?.code === 'ENOENT') return 'path_missing';
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return 'build_required';
  return publicCodes.has(error?.code) || BACKUP_FAILURE_CODES.has(error?.code) ? error.code : 'backup_failed';
}
export async function backupMain(argv = process.argv.slice(2), output = process.stdout, { signal } = {}) {
  let parsed;
  try { parsed = parseBackupOptions(argv); }
  catch {
    output.write(argv.includes('--json') ? '{"status":"failed","code":"invalid_arguments"}\n'
      : 'Invalid backup arguments; use --help. No operation started.\n');
    return 2;
  }
  if (parsed.help) { output.write(BACKUP_USAGE); return 0; }
  try {
    const { createLedgerBackup, verifyLedgerBackup } = await import('./backup.mjs');
    const { operation, values, timeoutMs } = parsed;
    const report = operation === 'create'
      ? await createLedgerBackup({ dbPath: values.db, outDir: values['out-dir'], timeoutMs, signal })
      : await verifyLedgerBackup({ directory: values.dir, timeoutMs, signal });
    output.write(values.json ? `${JSON.stringify(report)}\n` : [
      `ReflexMesh backup ${operation}: verified archive`,
      `Ledger schema ${report.manifest.ledgerSchemaVersion}; ${report.manifest.database.bytes} bytes; SHA256 ${report.manifest.database.sha256}`,
      'SQLite integrity, foreign keys and recognized schema passed; bounded counts are in the manifest.',
      'This is a full unencrypted ledger copy, not a minimized dataset. Protect its directory.',
      ...(report.manifest.ledgerSchemaVersion === 4 ? ['Older external audit archives are NOT included or verified. Keep every referenced archive.'] : []),
      'Freshness and origin are not attested. Restore is NOT authorized; UNKNOWN stays non-retryable.',
      'Never overwrite a live ledger or lose newer admission/pairing guards. See docs/LEDGER-BACKUP.md.', '',
    ].join('\n'));
    return 0;
  } catch (error) {
    const code = codeFor(error);
    output.write(parsed.values.json ? `${JSON.stringify({ status: 'failed', code, restoreAuthorized: false, retryAllowed: false })}\n`
      : `ReflexMesh backup failed: ${code}. Any partial output is retained; do not restore or automatically retry. Use --help and docs/LEDGER-BACKUP.md.\n`);
    return code === 'backup_cancelled' ? 130 : 1;
  }
}

if (isDirectRun(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { process.exitCode = await backupMain(process.argv.slice(2), process.stdout, { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
