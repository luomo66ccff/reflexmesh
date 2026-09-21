import { snapshot } from '../dist/index.js';
import { storageTables } from './storage-view.mjs';

const RUN_STATES = Object.freeze(['admitted', 'executing', 'completed', 'unknown']);
const PAIR_STATES = Object.freeze(['pending', 'ready', 'blocked']);
const HEX = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const count = value => Number.isSafeInteger(value) && value >= 0;

export class BackupManifestError extends Error {
  constructor() { super('Invalid backup manifest'); this.name = 'BackupManifestError'; this.code = 'backup_manifest_invalid'; }
}
const check = ok => { if (!ok) throw new BackupManifestError(); };

function validSummary(summary, version) {
  check(exact(summary, ['schemaVersion', 'kind', 'ledgerSchemaVersion', 'scanLimit', 'pages', 'tables', 'runStates', 'pairStates'])
    && summary.schemaVersion === (version === 4 ? 2 : 1) && summary.kind === 'reflexmesh-storage-snapshot'
    && summary.ledgerSchemaVersion === version && summary.scanLimit === 1000);
  const pages = summary.pages;
  check(exact(pages, ['pageSize', 'pageCount', 'freelistCount', 'logicalBytes', 'reusableBytes'])
    && Number.isSafeInteger(pages.pageSize) && pages.pageSize >= 512 && pages.pageSize <= 65536
    && (pages.pageSize & (pages.pageSize - 1)) === 0 && count(pages.pageCount) && count(pages.freelistCount)
    && pages.freelistCount <= pages.pageCount && Number.isSafeInteger(pages.pageSize * pages.pageCount)
    && pages.logicalBytes === pages.pageSize * pages.pageCount
    && pages.reusableBytes === pages.pageSize * pages.freelistCount);
  check(exact(summary.tables, storageTables(version)));
  for (const table of storageTables(version)) {
    const item = summary.tables[table];
    const supported = table === 'recovery_reviews' ? version >= 2
      : table === 'claude_hook_pairs' ? version >= 3 : true;
    check(exact(item, ['supported', 'scanned', 'truncated', 'total']) && item.supported === supported);
    if (supported) check(count(item.scanned) && item.scanned <= 1000
      && typeof item.truncated === 'boolean'
      && (item.truncated ? item.scanned === 1000 && item.total === null : item.total === item.scanned));
    else check(item.scanned === null && item.truncated === null && item.total === null);
  }
  check(exact(summary.runStates, ['sample', 'supported', 'counts'])
    && summary.runStates.sample === 'scanned-runs' && summary.runStates.supported === true
    && exact(summary.runStates.counts, RUN_STATES)
    && RUN_STATES.every(name => count(summary.runStates.counts[name]))
    && RUN_STATES.reduce((sum, name) => sum + summary.runStates.counts[name], 0) === summary.tables.runs.scanned);
  const pair = summary.pairStates, supported = version >= 3;
  check(exact(pair, ['sample', 'supported', 'counts', 'pairOnly'])
    && pair.sample === 'scanned-claude-hook-pairs' && pair.supported === supported);
  if (supported) check(exact(pair.counts, PAIR_STATES) && PAIR_STATES.every(name => count(pair.counts[name]))
    && PAIR_STATES.reduce((sum, name) => sum + pair.counts[name], 0) === summary.tables.claude_hook_pairs.scanned
    && count(pair.pairOnly) && pair.pairOnly <= summary.tables.claude_hook_pairs.scanned);
  else check(pair.counts === null && pair.pairOnly === null);
}

/** Fixed, privacy-minimal manifest; not a restoration authorization. */
export function validateBackupManifest(input) {
  let value;
  try { value = snapshot(input); } catch { throw new BackupManifestError(); }
  check(exact(value, ['schemaVersion', 'kind', 'createdAt', 'ledgerSchemaVersion', 'database',
    'runtime', 'summary', 'checks', 'restoreAuthorized', 'retryAllowed',
    ...(value.ledgerSchemaVersion === 4 ? ['externalAuditArchives'] : [])])
    && value.schemaVersion === (value.ledgerSchemaVersion === 4 ? 2 : 1) && value.kind === 'reflexmesh-ledger-backup'
    && typeof value.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt
    && [1, 2, 3, 4].includes(value.ledgerSchemaVersion)
    && value.restoreAuthorized === false && value.retryAllowed === false);
  check(exact(value.database, ['file', 'bytes', 'sha256']) && value.database.file === 'ledger.sqlite'
    && Number.isSafeInteger(value.database.bytes) && value.database.bytes > 0
    && typeof value.database.sha256 === 'string' && HEX.test(value.database.sha256));
  check(exact(value.runtime, ['nodeVersion', 'sqliteVersion'])
    && typeof value.runtime.nodeVersion === 'string' && value.runtime.nodeVersion.length <= 32
    && VERSION.test(value.runtime.nodeVersion)
    && typeof value.runtime.sqliteVersion === 'string' && value.runtime.sqliteVersion.length <= 32
    && VERSION.test(value.runtime.sqliteVersion));
  validSummary(value.summary, value.ledgerSchemaVersion);
  check(value.ledgerSchemaVersion !== 4 || value.externalAuditArchives === 'not_verified');
  check(value.database.bytes === value.summary.pages.logicalBytes);
  check(exact(value.checks, ['integrity', 'foreignKeys', 'schema'])
    && value.checks.integrity === 'ok' && value.checks.foreignKeys === 'ok'
    && value.checks.schema === 'recognized');
  return value;
}
