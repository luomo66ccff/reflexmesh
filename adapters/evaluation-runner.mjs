import { canonical, ContractError, snapshot, validateResult } from '../dist/index.js';
import { assertProviderInput, snapshotProvider } from '../dist/core/provider-capabilities.js';
import { normalizeProviderBinding } from './provider-binding.mjs';
import { evaluationCaseDigest, evaluationDatasetDigest, validateEvaluationDataset, validateEvaluationPredictions } from './evaluation-contract.mjs';

/** Provider-only batch. Labels, tools, host runtimes and ledger mutation are intentionally absent. */
export async function runEvaluation({ dataset: input, provider, binding, deploymentId, id, maxRequests, timeoutMs = 15000, signal }) {
  const dataset = validateEvaluationDataset(input), selected = snapshotProvider(provider);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean'))
    throw new ContractError('Invalid evaluation request or timeout budget');
  if (!binding || binding.authorizationRevision !== 'eval-no-execution-v1' || binding.toolsetRevision !== 'eval-no-tools-v1' || binding.calibrationRef !== null)
    throw new ContractError('Evaluation requires a separate no-execution deployment');
  const deployment = { id: deploymentId, binding: normalizeProviderBinding(selected, binding), capabilities: selected.capabilities };
  const artifact = { schemaVersion: 1, kind: 'reflexmesh-predictions', id, datasetDigest: evaluationDatasetDigest(dataset), deployment,
    origin: selected.capabilities.probabilitySemantics === 'synthetic-fixture' ? 'synthetic-fixture' : 'provider-run', rows: [] };
  // Validate identity/binding before the first invocation, not only after spending the budget.
  validateEvaluationPredictions(artifact, dataset);
  let invocations = 0, stopReason = null;
  for (const item of dataset.cases) {
    const row = { caseId: item.id, inputDigest: evaluationCaseDigest(dataset, item.id) };
    if (signal?.aborted) stopReason = 'cancelled';
    if (stopReason) { artifact.rows.push({ ...row, status: 'not_attempted', reasonCode: stopReason }); continue; }
    try { assertProviderInput(selected.capabilities, item.state, dataset.pack.questions, new AbortController().signal); }
    catch { artifact.rows.push({ ...row, status: 'unsupported', reasonCode: 'input_incompatible' }); continue; }
    if (invocations >= maxRequests) { artifact.rows.push({ ...row, status: 'not_attempted', reasonCode: 'budget_exhausted' }); continue; }
    const controller = new AbortController(); let timer, timedOut = false, cancelled = false, rejectCancellation;
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    const cancel = () => { cancelled = true; controller.abort(); rejectCancellation(new Error('Evaluation cancelled')); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    timer = setTimeout(() => { timedOut = true; controller.abort(); rejectCancellation(new Error('Evaluation deadline')); }, timeoutMs);
    try {
      invocations++;
      const raw = await Promise.race([Promise.resolve().then(() => selected.evaluate(item.state, dataset.pack.questions, controller.signal)), cancellation]);
      controller.signal.throwIfAborted();
      const result = validateResult(dataset.pack.questions, raw);
      if (result.model !== deployment.binding.modelId || canonical(result) !== canonical(raw)) throw new ContractError('Evaluation result binding mismatch');
      artifact.rows.push({ ...row, status: 'ok', result });
    } catch {
      artifact.rows.push({ ...row, status: 'failed', reasonCode: cancelled ? 'cancelled' : timedOut ? 'deadline_exceeded' : 'provider_error' });
      stopReason = cancelled ? 'cancelled' : 'stopped_after_failure';
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  return snapshot(validateEvaluationPredictions(artifact, dataset));
}
