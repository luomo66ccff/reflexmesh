import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { IntentCache } from '../adapters/intent-cache.mjs';
import { TaskAwareBoundary } from '../adapters/task-boundary.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { formatEvidence } from '../adapters/evidence-cli.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--explain')) throw new Error('Expected no arguments or --explain');
const explain = args[0] === '--explain';

const dir = await mkdtemp(join(tmpdir(), 'rm-task-demo-'));
let cache, kernel, predictions = 0;
try {
  kernel = new SqliteKernel(join(dir, 'ledger.sqlite'));
  cache = new IntentCache(join(dir, 'intent.sqlite'), { tenantId: 'demo', scope: 'demo' });
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
  cache.capture(scope, 'ReflexMesh-Intent: Read README without editing files\nPRIVATE_PROMPT_BODY_NOT_SELECTED');
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
    unselectedBodyInCache: (await readFile(join(dir, 'intent.sqlite'))).includes(Buffer.from('PRIVATE_PROMPT_BODY_NOT_SELECTED')),
    labelsCreated: receipt.labels.length,
  };
  if (explain) {
    console.log('ReflexMesh evidence walkthrough\nSYNTHETIC classification and outcomes; no real model or host tool runs.\n');
    for (const [title, view] of [
      ['1. No selected task: provider is skipped', kernel.evidenceSnapshot(missing.decisionId)],
      ['2. A decision exists, but the host result is still missing', beforeOutcome],
      ['3. A fixture outcome arrives; it does not create a label', kernel.evidenceSnapshot(assessed.decisionId)],
      ['4. The task is cleared; the previous intent is not reused', kernel.evidenceSnapshot(cleared.decisionId)],
    ]) console.log(title + '\n' + formatEvidence(view, 'inspect'));
    console.log(`Fixture provider calls: ${predictions}; duplicate replayed: ${replay.replayed}; labels created: ${receipt.labels.length}.`);
    console.log('The temporary ledger and summary cache are removed when this walkthrough exits.');
  } else console.log(JSON.stringify(report, null, 2));
} finally { cache?.close(); kernel?.close(); await rm(dir, { recursive: true, force: true }); }
