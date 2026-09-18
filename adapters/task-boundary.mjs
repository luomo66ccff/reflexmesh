import { snapshot, ContractError } from '../dist/index.js';
import { ShadowBoundary } from './shadow-boundary.mjs';
import { inspectTaskIntent, taskReceiptFromState, scopeOfCall, intentDigest, INTENT_POLICY } from './task-evidence.mjs';

/** Opt-in task-aware observer. No envelope can authorize a tool or turn observation into truth. */
export class TaskAwareBoundary extends ShadowBoundary {
  #clock;
  constructor({ clock = Date.now, ...options }) {
    if (typeof clock !== 'function') throw new ContractError('Invalid intent clock');
    const provider = options.provider;
    const guarded = { id: provider.id, evaluate: async (state, questions, signal) => {
      const receipt = taskReceiptFromState(state);
      if (!receipt || receipt.status !== 'ready') throw new ContractError('Usable task intent is required');
      // Recheck immediately before egress, not only before a possibly delayed admission.
      signal.throwIfAborted();
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new ContractError('Invalid intent clock');
      if (receipt.source !== 'model-reported' && (now < receipt.issuedAt || now >= receipt.expiresAt)) throw new ContractError('Task intent expired before evaluation');
      return provider.evaluate(state, questions, signal);
    } };
    super({ ...options, provider: guarded, binding: { ...options.binding, taskEvidencePolicy: INTENT_POLICY } });
    this.#clock = clock;
  }
  event(call, intent = null) {
    const event = super.event(call);
    const selected = inspectTaskIntent(intent, scopeOfCall(call), this.#clock());
    return { ...event, state: { ...event.state, userIntent: selected.summary, taskEvidence: selected.receipt } };
  }
  async before(call, intent = null) {
    // Inherited before snapshots our event once. Receipt on the result is metadata only.
    const result = await super.before(call, intent);
    const stored = this.inspect(call);
    return snapshot({ ...result, taskEvidence: stored?.evidence?.taskEvidence ?? null });
  }
  beforeReported(call, summary = null) {
    // MCP text is a MODEL-REPORTED summary. Never pretend the client supplies authenticated host provenance or capture time.
    const envelope = summary == null ? null : { schemaVersion: 1,
      id: intentDigest([call.sessionId, call.agentId, call.callId, 'model-reported']), scope: scopeOfCall(call),
      source: 'model-reported', summary, issuedAt: null, expiresAt: null };
    return this.before(call, envelope);
  }
}
