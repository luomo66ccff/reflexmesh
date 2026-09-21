#!/usr/bin/env node
import { isDirectRun } from './direct-run.mjs';

export const AUDIT_ARCHIVE_USAGE = `ReflexMesh audit archival (explicit historical audit deletion, not guard deletion)
  node adapters/audit-archive-cli.mjs preview --db ABS_FILE --backup-dir ABS_ARCHIVE --out-dir NEW_ABS_PLAN --cutoff-ms UNIX_MS [--max-rows 10000] [--json]
  node adapters/audit-archive-cli.mjs apply --db ABS_FILE --backup-dir ABS_ARCHIVE --plan-dir ABS_PLAN --apply --quiescent [--json]
  node adapters/audit-archive-cli.mjs inspect --plan-dir ABS_PLAN [--json]
  node adapters/audit-archive-cli.mjs history --db ABS_FILE --key KEY [--after BATCH_ID] [--limit 20] [--json]
  node adapters/audit-archive-cli.mjs query --db ABS_FILE --key KEY --batch BATCH_ID --archive-dir ABS_ARCHIVE [--after-seq DECIMAL] [--limit 20] [--include-details] [--json]
All worker commands accept --timeout-ms 30000 (100..300000). Build first.
Create and verify a full backup first. Preview writes only a new plan directory.
Apply upgrades schema 3 to 4 and deletes audit rows at < cutoff, seq < captured MAX.
Close ALL ledger connections (including idle read-only inspectors) and old binaries first; --quiescent is a declaration, not proof.
Keep all archives: each batch references one full backup. New backups do NOT contain older external audit bodies.
history/query are local read-only; query verifies ONE batch, never a complete archive chain.
Default query returns bounded metadata/digests. --include-details explicitly emits base64 audit bytes, with size limits.
No retry, restore, provider call, execution permission or secure-erasure claim.
An apply attempt is single-use. Lost receipts mean unknown; inspect, never automatically retry.
See docs/AUDIT-ARCHIVAL.md. Quote Windows paths containing spaces.
`;
export function parseAuditArchiveOptions(argv) {
  const invalid = () => { throw new Error('invalid_arguments'); };
  if (!Array.isArray(argv)) invalid();
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const [operation, ...rest] = argv;
  const sets = {
    preview: ['db', 'backup-dir', 'out-dir', 'cutoff-ms', 'max-rows'],
    apply: ['db', 'backup-dir', 'plan-dir', 'apply', 'quiescent'],
    inspect: ['plan-dir'], history: ['db', 'key', 'after', 'limit'],
    query: ['db', 'key', 'batch', 'archive-dir', 'after-seq', 'limit', 'include-details'],
  };
  const required = { preview: ['db', 'backup-dir', 'out-dir', 'cutoff-ms'],
    apply: ['db', 'backup-dir', 'plan-dir', 'apply', 'quiescent'], inspect: ['plan-dir'],
    history: ['db', 'key'], query: ['db', 'key', 'batch', 'archive-dir'] };
  if (!Object.hasOwn(sets, operation)) invalid();
  const allowed = [...sets[operation], 'json', ...(operation === 'inspect' ? [] : ['timeout-ms'])], values = {};
  for (let i = 0; i < rest.length; i++) {
    const key = typeof rest[i] === 'string' && rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed.includes(key) || Object.hasOwn(values, key)) invalid();
    if (['apply', 'quiescent', 'json', 'include-details'].includes(key)) values[key] = true;
    else {
      const value = rest[++i];
      if (typeof value !== 'string' || !value || value.startsWith('--')) invalid();
      values[key] = value;
    }
  }
  if (!required[operation].every(key => values[key] !== undefined)) invalid();
  for (const [key, min, max] of [['cutoff-ms', 0, Number.MAX_SAFE_INTEGER], ['max-rows', 1, 10000],
    ['limit', 1, 50], ['timeout-ms', 100, 300000]]) {
    if (values[key] !== undefined && (!/^(0|[1-9]\d*)$/.test(values[key])
      || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < min || Number(values[key]) > max)) invalid();
  }
  for (const key of ['batch', 'after']) if (values[key] !== undefined && !/^[a-f0-9]{64}$/.test(values[key])) invalid();
  if (values['after-seq'] !== undefined && (!/^(0|[1-9]\d{0,18})$/.test(values['after-seq'])
    || BigInt(values['after-seq']) > 9223372036854775807n)) invalid();
  return { operation, values, timeoutMs: Number(values['timeout-ms'] ?? 30000) };
}
export async function auditArchiveMain(argv = process.argv.slice(2), output = process.stdout, { signal } = {}) {
  let parsed;
  try { parsed = parseAuditArchiveOptions(argv); }
  catch {
    output.write('{"status":"rejected","code":"invalid_arguments","retryAllowed":false}\n'); return 2;
  }
  if (parsed.help) { output.write(AUDIT_ARCHIVE_USAGE); return 0; }
  try {
    const api = await import('./audit-archive.mjs');
    const { operation, values: v, timeoutMs } = parsed;
    const common = { dbPath: v.db, timeoutMs, signal };
    const result = operation === 'preview' ? await api.previewLedgerAuditArchive({ ...common, backupDirectory: v['backup-dir'],
      outDir: v['out-dir'], cutoffAt: Number(v['cutoff-ms']), maxRows: Number(v['max-rows'] ?? 10000) })
      : operation === 'apply' ? await api.applyLedgerAuditArchive({ ...common, backupDirectory: v['backup-dir'],
        planDirectory: v['plan-dir'], quiescent: v.quiescent })
        : operation === 'inspect' ? api.inspectAuditArchiveAttempt(v['plan-dir'])
          : operation === 'history' ? await api.auditArchiveHistory({ ...common, runKey: v.key, after: v.after, limit: Number(v.limit ?? 20) })
            : await api.queryLedgerAuditArchive({ ...common, runKey: v.key, batchId: v.batch, backupDirectory: v['archive-dir'],
              afterSeq: v['after-seq'], limit: Number(v.limit ?? 20), includeDetails: v['include-details'] ?? false });
    // JSON-escaped metadata avoids terminal injection from local evidence strings.
    output.write(v.json ? `${JSON.stringify(result)}\n` : `ReflexMesh audit archive: ${result.status}\n${JSON.stringify(result, null, 2)}\nKeep every referenced archive. No retry or restore is authorized.\n`);
    return result.status === 'apply_unknown' ? 1 : 0;
  } catch (error) {
    const known = new Set(['invalid_options', 'invalid_plan', 'invalid_plan_directory', 'source_is_archive', 'output_overlap',
      'source_changed', 'archive_changed', 'plan_changed', 'quiescence_required', 'invalid_receipt',
      'archive_cancelled', 'archive_timeout', 'archive_unverified', 'apply_unknown', 'apply_unknown_worker_unconfirmed',
      'worker_termination_unconfirmed']);
    const code = error?.code === 'SQLITE_WAL_RUNTIME_UNSUPPORTED' ? 'sqlite_runtime_unsupported'
      : error?.code === 'EEXIST' ? 'output_or_attempt_exists' : error?.code === 'ENOENT' ? 'archive_or_path_unavailable'
        : error?.code === 'ERR_MODULE_NOT_FOUND' ? 'build_required' : known.has(error?.code) ? error.code : 'archive_unverified';
    output.write(`${JSON.stringify({ status: code.startsWith('apply_unknown') ? 'apply_unknown' : 'unverified', code, retryAllowed: false })}\n`);
    return code === 'archive_cancelled' ? 130 : 1;
  }
}
if (isDirectRun(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { process.exitCode = await auditArchiveMain(process.argv.slice(2), process.stdout, { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
