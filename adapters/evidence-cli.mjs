#!/usr/bin/env node
import { resolve } from 'node:path';
import { ContractError } from '../dist/index.js';
import { SqliteKernel } from './sqlite-kernel.mjs';
import { isDirectRun } from './direct-run.mjs';
import { resolveStorageDatabasePath } from './storage-files.mjs';
import { formatStorageReport, storageReport } from './storage-report.mjs';

const USAGE = `ReflexMesh evidence: explain decisions separately from host outcomes (read-only)
  npm run evidence -- list --db PATH [--limit 20] [--after KEY] [--state STATE] [--json]
  npm run evidence -- attention --db PATH [--limit 20] [--after KEY] [--json]
  npm run evidence -- inspect --db PATH --key KEY [--json]
  npm run evidence -- storage --db PATH [--scan-limit 1000] [--json]
States: admitted, executing, completed, unknown. Pages are ordered by key, not recency.
Attention covers decision rows only; pair-only reservations are excluded, and this is not a complete error inventory.
Storage includes bounded table/pair-only counts and file lengths, never deletion eligibility or automatic cleanup.
Archived audit bodies require audit-archive-cli history/query and explicit archive files; a backup does not verify external archives.
No provider, tool, permission change or replay is invoked. Use --json for metadata receipts.
The database must already exist. Build once with npm run build before using this CLI.
For paths containing spaces on Windows, use the direct node adapters/evidence-cli.mjs entrypoint with a quoted path.
`;
const fail = message => { throw new ContractError(message); };
export function parseEvidenceOptions(argv) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--help')) return { help: true };
  const [command, ...rest] = argv;
  if (!['list','attention','inspect','storage'].includes(command)) fail('Expected list, attention, inspect or storage; use --help');
  const allowed = command === 'list' ? ['db','limit','after','state','json']
    : command === 'attention' ? ['db','limit','after','json']
      : command === 'storage' ? ['db','scan-limit','json'] : ['db','key','json'];
  const options = { command };
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed.includes(name) || Object.hasOwn(options, name)) fail('Unknown or duplicate evidence option');
    if (name === 'json') options.json = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) fail('Missing evidence option value');
      options[name] = value;
    }
  }
  if (!options.db || options.db === ':memory:') fail('An existing --db PATH is required');
  if (command === 'inspect' && !options.key) fail('An evidence --key is required');
  if (options.limit !== undefined) {
    if (!/^[0-9]+$/.test(options.limit) || Number(options.limit) < 1 || Number(options.limit) > 100) fail('Evidence limit must be 1 through 100');
    options.limit = Number(options.limit);
  }
  if (options.state !== undefined && !['admitted','executing','completed','unknown'].includes(options.state)) fail('Invalid evidence state');
  if (options['scan-limit'] !== undefined) {
    if (!/^[0-9]+$/.test(options['scan-limit']) || Number(options['scan-limit']) < 1 || Number(options['scan-limit']) > 10000)
      fail('Storage scan limit must be 1 through 10000');
    options['scan-limit'] = Number(options['scan-limit']);
  }
  return options;
}
export function formatEvidence(result, command) {
  if (command === 'storage') return formatStorageReport(result);
  const quote = value => JSON.stringify(value ?? 'not recorded');
  const sources = item => item.hostOutcome.byProvenance.map(group => `${group.provenance}:${group.status}=${group.count}`).join(', ') || 'none';
  if (command === 'attention') {
    const lines = ['ReflexMesh attention (read-only; key order, not chronological)',
      'Decision rows only; pair-only reservations without runs are excluded. This is not a complete error inventory.'];
    for (const item of result.items) {
      lines.push(`${quote(item.key)} | run: ${item.run.state} | outcome observations: ${item.hostOutcome.status} [${sources(item)}] | hook pairing: ${item.hostOutcome.hookPairing.state}`);
      for (const reason of item.attention.reasons) lines.push(`  ${reason.code}: ${reason.explanation}`);
      if (item.auditHistory?.archived) lines.push('  Audit history partially archived; external archive availability not checked.');
    }
    if (!result.items.length) lines.push('No matching decision rows; absence is not proof of host safety or non-execution.');
    if (result.nextCursor !== null) lines.push(`Next page: --after ${quote(result.nextCursor)}`);
    lines.push('Use inspect --db PATH --key KEY for bounded decision and outcome detail; this command never authorizes a retry.');
    return lines.join('\n') + '\n';
  }
  if (command === 'list') {
    const lines = ['ReflexMesh evidence (read-only; key order, not chronological)'];
    for (const item of result.items) lines.push(`${quote(item.key)} | run: ${item.run.state} | decision: ${item.decision.effect ?? 'not recorded'} | host outcome: ${item.hostOutcome.status} [${sources(item)}] | task: ${item.taskEvidence.recordedStatus} | hook pairing: ${item.hostOutcome.hookPairing?.state ?? 'not_recorded'}${item.auditHistory?.archived ? ' | audit: partially archived (availability not checked)' : ''}`);
    if (!result.items.length) lines.push('No matching calls. A completed shadow decision is not proof of host execution.');
    if (result.nextCursor !== null) lines.push(`Next page: --after ${quote(result.nextCursor)}`);
    lines.push('Use inspect --db PATH --key KEY to see binding, reasons and evidence coverage.');
    return lines.join('\n') + '\n';
  }
  return [
    `Call: ${quote(result.key)}`,
    `Run: ${result.run.state}; mode: ${result.run.mode ?? 'not recorded'}; result: ${result.run.resultStatus ?? 'not recorded'}`,
    `Decision: ${result.decision.effect ?? 'not recorded'}; rule: ${quote(result.decision.ruleId)}; reason: ${quote(result.decision.reasonCode)}`,
    `Why: ${result.decision.explanation}`,
    ...(result.decision.directive ? [`Advisory directive: ${quote(result.decision.directive)}`] : []),
    `Pack: ${quote(result.pack.id)} @ ${quote(result.pack.version)}`,
    `Provider: ${quote(result.binding.providerId)} / ${quote(result.binding.modelId)} @ ${quote(result.binding.revision)}`,
    `Provider declaration: ${quote(result.providerCapabilities.digest)}; probability semantics: ${result.providerCapabilities.probabilitySemantics ?? 'not recorded'} (not a calibration claim)`,
    `Task at decision: ${result.taskEvidence.recordedStatus}; coverage: ${result.taskEvidence.coverage ?? 'not recorded'}; source: ${result.taskEvidence.source ?? 'not recorded'}`,
    `Host outcome: ${result.hostOutcome.status}; observations: ${result.hostOutcome.count}; labels: ${result.labelCount}`,
    `Outcome sources: ${sources(result)}`,
    `Claude hook pairing: ${result.hostOutcome.hookPairing?.state ?? 'not_recorded'}; reason: ${result.hostOutcome.hookPairing?.reasonCode ?? 'none'}`,
    `Recovery required: ${result.recovery.required}; operator conclusion: ${result.recovery.resolution ?? 'none'}; execution allowed by this inspector: false`,
    ...(result.auditHistory ? [`Audit: ${result.auditHistory.archivedRowCount} archived rows in ${result.auditHistory.batchCount} batches; external files not checked.`] : []),
    ...result.notes,
  ].join('\n') + '\n';
}
export async function evidenceMain(argv, output = process.stdout) {
  const options = parseEvidenceOptions(argv);
  if (options.help) { output.write(USAGE); return; }
  const path = options.command === 'storage' ? resolveStorageDatabasePath(options.db) : resolve(options.db);
  const kernel = new SqliteKernel(path, { readOnly: true });
  try {
    const result = options.command === 'storage' ? storageReport(kernel, path, options['scan-limit'] ?? 1000)
      : options.command === 'list'
      ? kernel.listEvidence({ limit: options.limit ?? 20, after: options.after ?? '', state: options.state ?? null })
      : options.command === 'attention'
        ? kernel.listAttention({ limit: options.limit ?? 20, after: options.after ?? '' })
        : kernel.evidenceSnapshot(options.key);
    if (!result) fail('Unknown evidence key');
    output.write(options.json ? JSON.stringify(result, null, 2) + '\n' : formatEvidence(result, options.command));
  } finally { kernel.close(); }
}
if (isDirectRun(import.meta.url)) {
  try { await evidenceMain(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`ReflexMesh evidence: ${error instanceof ContractError ? error.message : 'database unavailable or invalid; check --db and build first'}.\n`);
    process.exitCode = 1;
  }
}
