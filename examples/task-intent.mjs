#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { IntentCache } from '../adapters/intent-cache.mjs';
import { TaskAwareBoundary } from '../adapters/task-boundary.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { formatEvidence } from '../adapters/evidence-cli.mjs';
import { assertSqliteWalRuntime, SqliteRuntimeError } from '../adapters/sqlite-runtime.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

const SUMMARY = 'Read README without editing files';
const PRIVATE_BODY = 'PRIVATE_PROMPT_BODY_NOT_SELECTED';
const USAGE = `Usage: node examples/task-intent.mjs [--summary | --explain] [--out-dir NEW_DIRECTORY]
       npm run first-run [-- --out-dir NEW_DIRECTORY]
Runs only synthetic evidence fixtures; no model, user profile or host tool is used.
Without --out-dir, temporary databases are removed. A retained lesson contains only ledger.sqlite and START-HERE.md.
For paths with spaces, build first and pass the quoted path directly to node.
`;

export class DemoOptionsError extends Error {}

export function parseTaskIntentArgs(argv) {
  const options = { mode: 'json', outDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--summary' || arg === '--explain') {
      if (options.mode !== 'json') throw new DemoOptionsError('Conflicting output modes');
      options.mode = arg.slice(2);
    } else if (arg === '--out-dir') {
      const value = argv[++i];
      if (options.outDir !== null || typeof value !== 'string' || !value || value.startsWith('--')
        || value.trim() !== value || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value))
        throw new DemoOptionsError('Invalid output directory');
      options.outDir = value;
    } else if (arg === '--help' || arg === '-h') {
      if (i !== argv.length - 1 || options.outDir !== null) throw new DemoOptionsError('Help cannot be combined with an output path');
      options.mode = 'help';
    } else throw new DemoOptionsError('Unknown option');
  }
  return options;
}

function shellQuote(value) {
  if (process.platform === 'win32') return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function markdownFence(value, language) {
  const longest = Math.max(0, ...(value.match(/`+/gu) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function startHere(directory) {
  const db = join(directory, 'ledger.sqlite');
  const prefix = process.platform === 'win32' ? '& ' : '';
  const command = (verb, extra = '') => `${prefix}node adapters/evidence-cli.mjs ${verb} --db ${shellQuote(db)}${extra}`;
  const commands = [command('list'), command('attention'),
    command('inspect', ` --key ${shellQuote('<KEY_FROM_LIST>')}`)];
  const shell = process.platform === 'win32' ? 'powershell' : 'sh';
  return `# Synthetic evidence lesson\n\nThis is an **account-free synthetic fixture**, not a real host session or user ledger. No model or host tool ran. The task-summary cache was temporary and has been removed; raw task text is not retained in this directory.\n\nFrom the ReflexMesh repository root, use these read-only commands. The inspector does not call providers, run tools, retry actions or change ledger records. SQLite may create or interact with WAL/SHM sidecars; read-only access is not a byte-for-byte filesystem immutability guarantee.\n\n1. List the synthetic decisions and copy one exact key from the output.\n\n${markdownFence(commands[0], shell)}\n\n2. Find records needing attention. Missing reports in this fixture are expected; they do not imply a crash or non-execution.\n\n${markdownFence(commands[1], shell)}\n\n3. Inspect a decision by replacing KEY_FROM_LIST with a key from list. The report keeps the decision, host outcome and labels separate.\n\n${markdownFence(commands[2], shell)}\n\nThis directory was created only if it did not already exist. Keep or remove this synthetic lesson as you prefer; it grants no permission to act on a real system.\n`;
}

function removeOwnedDirectory(path, ownership) {
  if (!ownership) return;
  try {
    const current = lstatSync(path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownership.dev || current.ino !== ownership.ino
      || realpathSync(path) !== ownership.realPath) return;
    rmSync(path, { recursive: true, force: false });
  } catch {}
}

function removeTemporaryDirectory(path, prefix, tempRoot) {
  if (!path) return;
  try {
    const target = realpathSync(path);
    if (dirname(target) !== tempRoot || !basename(target).startsWith(prefix)) return;
    rmSync(target, { recursive: true, force: false });
  } catch {}
}

function retainInstructions(directory) {
  const content = startHere(directory);
  const destination = join(directory, 'START-HERE.md');
  writeFileSync(destination, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function summaryOutput({ runtime, report, outputDir, retained }) {
  const lines = [
    'ReflexMesh first-run lesson complete.',
    `Runtime: Node ${runtime.nodeVersion ?? 'unknown'}; SQLite ${runtime.sqliteVersion ?? 'unknown'}; WAL write gate passed.`,
    `Synthetic evidence: ${report.decisionCount} decisions, ${report.totalFixturePredictions} fixture prediction, ${report.labelsCreated} labels.`,
    'No model, external provider, user profile or host tool was accessed.',
  ];
  if (retained) lines.push(`Synthetic ledger retained at ${JSON.stringify(join(outputDir, 'ledger.sqlite'))}.`,
    'Read-only commands and interpretation notes are in START-HERE.md.');
  else lines.push('Temporary ledger and task-summary cache were removed.');
  return lines.join('\n') + '\n';
}

export async function main(argv = process.argv.slice(2), output = process.stdout, dependencies = {}) {
  const options = parseTaskIntentArgs(argv);
  if (options.mode === 'help') { output.write(USAGE); return 0; }

  // Check before creating the lesson directory, temporary cache or any database.
  const runtime = (dependencies.assertRuntime ?? assertSqliteWalRuntime)();
  const tempRoot = realpathSync(tmpdir());
  let outputDir, cacheDir, ownership = null, tempOutput = false;
  let cache, kernel, successful = false, predictions = 0;
  const retained = options.outDir !== null;
  try {
    if (retained) {
      outputDir = resolve(options.outDir);
      mkdirSync(outputDir, { mode: 0o700 });
      const stat = lstatSync(outputDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Output reservation failed');
      ownership = { dev: stat.dev, ino: stat.ino, realPath: realpathSync(outputDir) };
    } else {
      outputDir = mkdtempSync(join(tempRoot, 'rm-task-demo-'));
      tempOutput = true;
    }
    // Keep the raw selected summary only in a separate short-lived cache.
    cacheDir = retained ? mkdtempSync(join(tempRoot, 'rm-task-cache-')) : outputDir;
    kernel = new SqliteKernel(join(outputDir, 'ledger.sqlite'));
    cache = new IntentCache(join(cacheDir, 'intent.sqlite'), { tenantId: 'demo', scope: 'demo' });
    const boundary = new TaskAwareBoundary({ kernel,
      provider: new MockProvider(() => { predictions++; return { model: 'fixture-only', answers: {
        intentMatch: { type: 'noul', noul: 0.98 }, injection: { type: 'noul', noul: 0 },
      } }; }),
      binding: { providerId: 'mock', modelId: 'fixture-only', revision: 'fixture-1', authorizationRevision: 'host-owned-shadow', toolsetRevision: 'demo' },
      pack: toolPreflightPack, tenantId: 'demo', scope: 'demo',
    });
    const scope = { harness: 'claude-code', sessionId: 'example-session', agentId: 'root' };
    const call = { schemaVersion: 1, ...scope, callId: 'missing', toolName: 'Read', arguments: { path: 'README.md' } };
    const missing = await boundary.before(call, null);
    const beforeCapture = predictions;
    cache.capture(scope, `ReflexMesh-Intent: ${SUMMARY}\n${PRIVATE_BODY}`);
    const selected = cache.current(scope);
    const readCall = { ...call, callId: 'selected' };
    const assessed = await boundary.before(readCall, selected);
    const beforeOutcome = kernel.evidenceSnapshot(assessed.decisionId);
    const replay = await boundary.before(readCall, selected);
    boundary.after(readCall, 'succeeded', { synthetic: true, message: 'Fixture only; no actual tool ran' }, 'test-oracle');
    cache.clear(scope);
    const cleared = await boundary.before({ ...call, callId: 'after-stop' }, cache.current(scope));
    const receipt = boundary.inspect(readCall);
    const report = { demo: 'SYNTHETIC model and outcome fixtures; no actual model or tool invoked',
      missingIntent: { effect: missing.verdict.effect, providerCalls: beforeCapture },
      selectedIntent: { effect: assessed.verdict.effect, receipt: assessed.taskEvidence },
      duplicate: { replayed: replay.replayed },
      afterStop: { effect: cleared.verdict.effect, coverage: cleared.taskEvidence.coverage },
      totalFixturePredictions: predictions,
      selectedSummaryInJournal: JSON.stringify(receipt).includes(selected.summary),
      unselectedBodyInCache: readFileSync(join(cacheDir, 'intent.sqlite')).includes(Buffer.from(PRIVATE_BODY)),
      labelsCreated: receipt.labels.length,
      decisionCount: 3,
      ...(retained ? { retainedLedger: join(outputDir, 'ledger.sqlite') } : {}),
    };

    cache.close(); cache = undefined;
    kernel.close(); kernel = undefined;
    if (retained) retainInstructions(outputDir);
    successful = true;

    if (options.mode === 'summary') output.write(summaryOutput({ runtime, report, outputDir, retained }));
    else if (options.mode === 'explain') {
      output.write('ReflexMesh evidence walkthrough\nSYNTHETIC classification and outcomes; no real model or host tool runs.\n\n');
      // Re-opened read-only views demonstrate what the public evidence CLI reads.
      const view = new SqliteKernel(join(outputDir, 'ledger.sqlite'), { readOnly: true });
      try {
        for (const [title, key, snapshot] of [
          ['1. No selected task: provider is skipped', missing.decisionId, null],
          ['2. A decision exists, but the host result is still missing', assessed.decisionId, beforeOutcome],
          ['3. A fixture outcome arrives; it does not create a label', assessed.decisionId, null],
          ['4. The task is cleared; the previous intent is not reused', cleared.decisionId, null],
        ]) output.write(title + '\n' + formatEvidence(snapshot ?? view.evidenceSnapshot(key), 'inspect'));
      } finally { view.close(); }
      output.write(`Fixture provider calls: ${predictions}; duplicate replayed: ${replay.replayed}; labels created: ${receipt.labels.length}.\n`);
      output.write(retained ? `Synthetic lesson retained in ${JSON.stringify(outputDir)}; see START-HERE.md for read-only commands.\n`
        : 'The temporary ledger and summary cache are removed when this walkthrough exits.\n');
    } else output.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  } finally {
    cache?.close(); kernel?.close();
    if (cacheDir && retained) removeTemporaryDirectory(cacheDir, 'rm-task-cache-', tempRoot);
    if (tempOutput) removeTemporaryDirectory(outputDir, 'rm-task-demo-', tempRoot);
    else if (retained && !successful) removeOwnedDirectory(outputDir, ownership);
  }
}

if (isDirectRun(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) {
    if (error instanceof DemoOptionsError) process.stderr.write('Invalid first-run options; use --help. Existing paths are never overwritten.\n');
    else if (error instanceof SqliteRuntimeError) process.stderr.write('Persistent SQLite WAL write gate is blocked. Run node adapters/runtime-cli.mjs and choose a fixed Node runtime; no lesson files were created.\n');
    else process.stderr.write('ReflexMesh first-run lesson failed; existing paths were not modified. Check the runtime gate, build, parent directory and output-path availability.\n');
    process.exitCode = 1;
  }
}
