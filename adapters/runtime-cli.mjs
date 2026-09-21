#!/usr/bin/env node
import { inspectSqliteRuntime } from './sqlite-runtime.mjs';
import { isDirectRun } from './direct-run.mjs';

const USAGE = `ReflexMesh SQLite runtime preflight (no build or ledger required)
  node adapters/runtime-cli.mjs [--json]
Checks only this Node process with a temporary in-memory SQLite connection.
No files, profiles, credentials, providers, or host tools are opened.
See docs/SQLITE-RUNTIME.md for manual upgrade and restart guidance.
`;

export function runtimeMain(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && argv[0] === '--help') { output.write(USAGE); return 0; }
  if (argv.length > 1 || argv.length === 1 && argv[0] !== '--json') {
    output.write('Invalid runtime options; use --help.\n'); return 2;
  }
  const report = inspectSqliteRuntime();
  output.write(argv.includes('--json') ? `${JSON.stringify(report)}\n` : [
    `ReflexMesh runtime: Node ${report.nodeVersion ?? 'unknown'}; SQLite ${report.sqliteVersion ?? 'unknown'}`,
    `WAL-reset fix: ${report.walResetFix}; persistent ledger write gate: ${report.persistentWriteAllowed ? 'passed' : 'blocked'}`,
    'This version check does not certify database integrity, other workers, or all SQLite defects.',
    'Read-only diagnosis and in-memory use remain available where the SQLite API works.',
    'Manually choose a fixed Node runtime and restart old workers; no automatic upgrade or retry.',
    'See docs/SQLITE-RUNTIME.md.', '',
  ].join('\n'));
  return report.persistentWriteAllowed ? 0 : 1;
}

if (isDirectRun(import.meta.url)) process.exitCode = runtimeMain();
