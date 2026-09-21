import { ContractError, snapshot } from '../dist/index.js';

export const STORAGE_TABLES = Object.freeze([
  'packs', 'runs', 'audit', 'observations', 'labels', 'recovery_reviews', 'claude_hook_pairs',
]);
const RUN_STATES = Object.freeze(['admitted', 'executing', 'completed', 'unknown']);
const PAIR_STATES = Object.freeze(['pending', 'ready', 'blocked']);
const check = (ok, message) => { if (!ok) throw new ContractError(message); };
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const countMap = states => Object.fromEntries(states.map(state => [state, 0]));

/** Pure projection of fixed, bounded SQLite metadata rows. No row body can reach the result. */
export function storageView({ ledgerSchemaVersion, scanLimit, pages, rows }) {
  check([1, 2, 3].includes(ledgerSchemaVersion) && Number.isSafeInteger(scanLimit)
    && scanLimit >= 1 && scanLimit <= 10000, 'Invalid storage view options');
  check(exact(pages, ['pageSize', 'pageCount', 'freelistCount'])
    && Number.isSafeInteger(pages.pageSize) && pages.pageSize >= 512 && pages.pageSize <= 65536
    && (pages.pageSize & (pages.pageSize - 1)) === 0
    && Number.isSafeInteger(pages.pageCount) && pages.pageCount >= 0
    && Number.isSafeInteger(pages.freelistCount) && pages.freelistCount >= 0
    && pages.freelistCount <= pages.pageCount
    && Number.isSafeInteger(pages.pageSize * pages.pageCount)
    && Number.isSafeInteger(pages.pageSize * pages.freelistCount), 'Invalid SQLite page metadata');
  check(exact(rows, STORAGE_TABLES), 'Invalid storage table set');
  const tables = {}, runCounts = countMap(RUN_STATES), pairCounts = countMap(PAIR_STATES);
  let pairOnly = 0;
  for (const table of STORAGE_TABLES) {
    const supported = table === 'recovery_reviews' ? ledgerSchemaVersion >= 2
      : table === 'claude_hook_pairs' ? ledgerSchemaVersion >= 3 : true;
    const items = rows[table];
    if (!supported) {
      check(items === null, 'Unsupported storage table must not be scanned');
      tables[table] = { supported: false, scanned: null, truncated: null, total: null };
      continue;
    }
    check(Array.isArray(items) && items.length <= scanLimit + 1, 'Invalid storage scan rows');
    const scanned = items.slice(0, scanLimit);
    for (const row of items) {
      if (table === 'runs') check(exact(row, ['state']) && RUN_STATES.includes(row.state), 'Invalid run scan state');
      else if (table === 'claude_hook_pairs') check(exact(row, ['state', 'pairOnly'])
        && PAIR_STATES.includes(row.state) && [0, 1].includes(row.pairOnly), 'Invalid pair scan state');
      else check(exact(row, ['present']) && row.present === 1, 'Invalid storage scan marker');
    }
    if (table === 'runs') for (const row of scanned) runCounts[row.state]++;
    if (table === 'claude_hook_pairs') for (const row of scanned) {
      pairCounts[row.state]++;
      pairOnly += row.pairOnly;
    }
    const truncated = items.length > scanLimit;
    tables[table] = { supported: true, scanned: scanned.length, truncated, total: truncated ? null : scanned.length };
  }
  return snapshot({
    schemaVersion: 1, kind: 'reflexmesh-storage-snapshot', ledgerSchemaVersion, scanLimit,
    pages: { pageSize: pages.pageSize, pageCount: pages.pageCount, freelistCount: pages.freelistCount,
      logicalBytes: pages.pageSize * pages.pageCount,
      reusableBytes: pages.pageSize * pages.freelistCount },
    tables,
    runStates: { sample: 'scanned-runs', supported: true, counts: runCounts },
    pairStates: { sample: 'scanned-claude-hook-pairs', supported: ledgerSchemaVersion >= 3,
      counts: ledgerSchemaVersion >= 3 ? pairCounts : null,
      pairOnly: ledgerSchemaVersion >= 3 ? pairOnly : null },
  });
}
