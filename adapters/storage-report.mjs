import { snapshot } from '../dist/index.js';
import { storageFileSnapshot } from './storage-files.mjs';

/** Compose the independently sampled filesystem metadata with one database read snapshot. */
export function storageReport(kernel, canonicalPath, scanLimit = 1000) {
  const database = kernel.storageSnapshot({ scanLimit });
  const files = storageFileSnapshot(canonicalPath);
  return snapshot({ schemaVersion: 1, kind: 'reflexmesh-storage-report', database, files,
    retention: { deletionAllowed: false, retryAllowed: false, ageEligibility: 'not-computed' }, executionAllowed: false });
}

export function formatStorageReport(report) {
  const data = report.database, pages = data.pages;
  const lines = ['ReflexMesh storage diagnostics (read-only; no cleanup or retry)',
    `Ledger schema ${data.ledgerSchemaVersion}; per-table scan limit ${data.scanLimit}. Samples are not chronological or representative.`,
    `Database pages: ${pages.pageCount} × ${pages.pageSize} bytes = ${pages.logicalBytes} logical bytes.`,
    `Reusable inside SQLite: ${pages.freelistCount} pages (${pages.reusableBytes} bytes); NOT a disk-space release estimate.`,
    'File observations (not atomic with the SQL snapshot; logical length, not allocated disk space):'];
  for (const [name, item] of Object.entries(report.files.entries))
    lines.push(`  ${name}: ${item.status}${item.logicalBytes === null ? '' : `, ${item.logicalBytes} bytes`}`);
  lines.push('Known tables (no per-table byte attribution):');
  for (const [name, item] of Object.entries(data.tables)) {
    lines.push(item.supported
      ? `  ${name}: scanned=${item.scanned}; ${item.truncated ? 'TRUNCATED, total unknown' : `total=${item.total}`}`
      : `  ${name}: not supported by this ledger schema; no invented zero count`);
  }
  const counts = value => Object.entries(value).map(([name, count]) => `${name}=${count}`).join(', ');
  lines.push(`Run states in scanned sample: ${counts(data.runStates.counts)}`);
  lines.push(data.pairStates.supported
    ? `Claude pair states in scanned sample: ${counts(data.pairStates.counts)}; pair-only=${data.pairStates.pairOnly}`
    : 'Claude pair guards: not recorded by this schema.');
  lines.push('Preserve run tombstones and pair guards, including completed, reviewed UNKNOWN and expired leases.',
    'No age-based deletion eligibility is computed. Counts do not authorize deleting audit, labels, reviews or packs.',
    'No DELETE, VACUUM, checkpoint, profile/provider access, review application or automatic retry is performed.',
    'SQLite WAL readers may touch shared-memory sidecars; read-only does not mean byte-for-byte filesystem immutability.',
    'Next: use evidence attention/inspect or recovery list/inspect to review cases. This summary is not an integrity or health certificate.');
  return lines.join('\n') + '\n';
}
