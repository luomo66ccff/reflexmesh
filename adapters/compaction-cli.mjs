#!/usr/bin/env node
import { isDirectRun } from './direct-run.mjs';

export const COMPACTION_USAGE = `ReflexMesh ledger compaction (all logical rows retained)
  node adapters/compaction-cli.mjs preview --db ABS_FILE --backup-dir ABS_ARCHIVE --out-dir NEW_ABS_PLAN_DIRECTORY [--timeout-ms 30000] [--json]
  node adapters/compaction-cli.mjs apply --db ABS_FILE --backup-dir ABS_ARCHIVE --plan-dir ABS_PLAN_DIRECTORY --apply --quiescent [--timeout-ms 30000] [--json]
  node adapters/compaction-cli.mjs inspect --plan-dir ABS_PLAN_DIRECTORY [--json]
  node adapters/compaction-cli.mjs --help
Build first. Create/verify a consistent archive with backup-cli before preview.
Preview never VACUUMs or changes application rows. Apply is an explicit local database rewrite.
Stop all host workers first; --quiescent is your declaration, not authenticated proof.
An exclusive SQLite maintenance lock and exact plan/backup comparison are required.
All rows, replay/UNKNOWN/pairing guards, labels and reviews are retained. No TTL deletion.
An attempt is never reused. Timeout/crash/lost reply may mean apply_unknown: inspect, do not retry automatically.
Backups remain full unencrypted copies; compaction is not secure erasure or restore permission.
Physical disk allocation and exact reclaimable bytes are not promised. See docs/LEDGER-COMPACTION.md.
Use the quoted Node entrypoint directly for Windows paths containing spaces.
`;

export function parseCompactionOptions(argv) {
  if (!Array.isArray(argv)) throw new Error('invalid_arguments');
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const [operation, ...rest] = argv;
  const allowed = operation === 'preview' ? ['db', 'backup-dir', 'out-dir', 'timeout-ms', 'json']
    : operation === 'apply' ? ['db', 'backup-dir', 'plan-dir', 'timeout-ms', 'apply', 'quiescent', 'json']
      : operation === 'inspect' ? ['plan-dir', 'json'] : null;
  if (!allowed) throw new Error('invalid_arguments');
  const values = {};
  for (let i = 0; i < rest.length; i++) {
    const key = typeof rest[i] === 'string' && rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw new Error('invalid_arguments');
    if (['json', 'apply', 'quiescent'].includes(key)) { values[key] = true; continue; }
    const value = rest[++i];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('invalid_arguments');
    values[key] = value;
  }
  if (operation !== 'inspect' && (!values.db || !values['backup-dir'])
    || operation === 'preview' && !values['out-dir']
    || operation !== 'preview' && !values['plan-dir']
    || operation === 'apply' && (!values.apply || !values.quiescent)) throw new Error('invalid_arguments');
  if (values['timeout-ms'] !== undefined && (!/^[1-9]\d*$/.test(values['timeout-ms'])
    || Number(values['timeout-ms']) < 100 || Number(values['timeout-ms']) > 300000)) throw new Error('invalid_arguments');
  return { operation, values, timeoutMs: Number(values['timeout-ms'] ?? 30000) };
}
const codes = new Set(['invalid_options', 'invalid_plan', 'invalid_plan_directory', 'source_is_backup',
  'source_changed', 'output_overlap', 'backup_changed', 'plan_changed', 'quiescence_required',
  'compaction_cancelled', 'compaction_timeout', 'compaction_unverified', 'invalid_receipt',
  'apply_unknown', 'apply_unknown_worker_unconfirmed', 'worker_termination_unconfirmed']);
function codeFor(error) {
  if (error?.code === 'SQLITE_WAL_RUNTIME_UNSUPPORTED') return 'sqlite_runtime_unsupported';
  if (error?.code === 'EEXIST') return 'output_or_attempt_exists';
  if (error?.code === 'ENOENT') return 'path_missing';
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return 'build_required';
  return codes.has(error?.code) ? error.code : 'compaction_unverified';
}
export async function compactionMain(argv = process.argv.slice(2), output = process.stdout, { signal } = {}) {
  let parsed;
  try { parsed = parseCompactionOptions(argv); }
  catch {
    output.write(argv.includes('--json') ? '{"status":"rejected","code":"invalid_arguments","retryAllowed":false}\n'
      : 'Invalid compaction arguments; no operation started. Use --help.\n');
    return 2;
  }
  if (parsed.help) { output.write(COMPACTION_USAGE); return 0; }
  try {
    const api = await import('./compaction.mjs');
    const { operation, values, timeoutMs } = parsed;
    const common = { dbPath: values.db, backupDirectory: values['backup-dir'], timeoutMs, signal };
    const result = operation === 'preview'
      ? await api.previewLedgerCompaction({ ...common, outDir: values['out-dir'] })
      : operation === 'apply'
        ? await api.applyLedgerCompaction({ ...common, planDirectory: values['plan-dir'], quiescent: values.quiescent })
        : api.inspectCompactionAttempt(values['plan-dir']);
    output.write(values.json ? `${JSON.stringify(result)}\n` : [
      `ReflexMesh compaction: ${result.status}`,
      result.snapshot ? `Schema ${result.snapshot.ledgerSchemaVersion}; ${result.snapshot.pages.freelistCount} free SQLite pages; this is not a deletion plan.`
        : result.after ? `Logical database bytes: ${result.logicalPageBytesBefore} -> ${result.logicalPageBytesAfter}; all logical rows preserved.`
          : 'This inspects local operation receipts only; it does not verify the current ledger.',
      'No logical records are deleted; no retry or restore permission is granted.',
      'Actual filesystem allocation, secure erasure and backup freshness are not certified.',
      'Keep the operation directory and full backup. See docs/LEDGER-COMPACTION.md.', '',
    ].join('\n'));
    return result.status === 'apply_unknown' ? 1 : 0;
  } catch (error) {
    const code = codeFor(error), unknown = code.startsWith('apply_unknown');
    output.write(parsed.values.json ? `${JSON.stringify({ status: unknown ? 'apply_unknown' : 'unverified', code, retryAllowed: false })}\n`
      : `ReflexMesh compaction ${unknown ? 'outcome unknown' : 'unverified'}: ${code}. Keep the plan/attempt and backup; never automatically retry or restore.\n`);
    return code === 'compaction_cancelled' ? 130 : 1;
  }
}
if (isDirectRun(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { process.exitCode = await compactionMain(process.argv.slice(2), process.stdout, { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
