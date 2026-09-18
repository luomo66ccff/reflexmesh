import { randomUUID } from 'node:crypto';
import { ReflexMesh, canonical, snapshot, validateEvent, validatePack, ContractError, evaluatePolicy, validateResult } from '../dist/index.js';
import { digest } from './sqlite-kernel.mjs';

export const eventKey = event => digest([event.tenantId, event.source, event.id]);
/** Reuses the v0.1 execution/policy engine; adds durable admission and evidence, not another agent loop. */
export class DurableMesh {
  #kernel; #options; #binding; #packs = new Map(); #tools = new Map(); #inFlight = new Map();
  constructor({ kernel, binding, leaseMs = 30000, ...options }) {
    for (const name of ['providerId','modelId','revision','authorizationRevision','toolsetRevision']) {
      if (typeof binding?.[name] !== 'string' || !binding[name].trim()) throw new ContractError(`Missing deployment ${name}`);
    }
    if (binding.providerId !== options.provider.id) throw new ContractError('Provider binding mismatch');
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 3600000) throw new ContractError('Invalid lease');
    this.#kernel = kernel; this.#binding = snapshot(binding);
    this.#options = { ...options, mode: options.mode ?? 'shadow', leaseMs };
    // Validate options now rather than after durable admission.
    new ReflexMesh({ ...options, ledger: { append: async () => {} } });
  }
  registerPack(pack) {
    validatePack(pack);
    if (this.#packs.has(pack.id)) throw new ContractError('Pack already registered');
    this.#kernel.registerPack(pack); this.#packs.set(pack.id, snapshot(pack)); return this;
  }
  registerTool(tool) {
    if (this.#tools.has(tool.id)) throw new ContractError('Tool already registered');
    new ReflexMesh({ provider: this.#options.provider, ledger: { append: async () => {} } }).registerTool(tool);
    this.#tools.set(tool.id, Object.freeze({ ...tool, execute: tool.execute.bind(tool) })); return this;
  }
  run(event, options) {
    try {
      validateEvent(event); const e = snapshot(event), o = snapshot(options);
      const pack = this.#packs.get(o.packId);
      if (!pack || pack.eventType !== e.type) throw new ContractError('No matching pack');
      const { time: _observedTime, ...semanticEvent } = e;
      // Observation time is not semantic identity. Put time-dependent evidence explicitly in state.
      const identity = { event: semanticEvent, options: o, pack, binding: this.#binding, mode: this.#options.mode };
      if (Buffer.byteLength(canonical(identity)) > (this.#options.maxEventBytes ?? 128000)) throw new ContractError('Event size limit exceeded');
      const key = eventKey(e), requestDigest = digest(identity), old = this.#inFlight.get(key);
      if (old) {
        if (old.digest !== requestDigest) throw new ContractError('Idempotency conflict');
        return old.promise;
      }
      const promise = this.#run(e, o, pack, key, requestDigest);
      this.#inFlight.set(key, { digest: requestDigest, promise });
      promise.then(() => this.#inFlight.delete(key), () => this.#inFlight.delete(key));
      return promise;
    } catch (e) { return Promise.reject(e); }
  }
  async #run(event, options, pack, key, requestDigest) {
    const admission = this.#kernel.claim({ key, requestDigest, owner: randomUUID(), leaseMs: this.#options.leaseMs,
      evidence: { schemaVersion: 1, eventId: event.id, tenantId: event.tenantId, source: event.source, eventType: event.type,
        inputDigest: requestDigest, actionDigest: digest(options.action ?? event.state?.proposedAction ?? null), pack: { id: pack.id, version: pack.version, digest: digest(pack), questionsDigest: digest(pack.questions) },
        binding: this.#binding, mode: this.#options.mode },
    });
    if (admission.kind === 'replay') return snapshot({ ...admission.result, replayed: true });
    if (admission.kind !== 'claimed') return snapshot({ eventId: event.id, status: admission.kind === 'busy' ? 'in_flight' : 'recovery_required', verdict: { effect: 'escalate', ruleId: 'durable_admission' }, reasonCode: admission.kind });
    const handle = admission.handle;
    try {
      const native = this.#options.provider, binding = this.#binding;
      const provider = { id: binding.providerId, evaluate: async (...args) => {
        const result = await native.evaluate(...args);
        if (result.model !== binding.modelId) throw new ContractError('Provider model changed; redeploy and recalibrate');
        return result;
      } };
      const mesh = new ReflexMesh({ ...this.#options, provider, ledger: { append: async row => this.#kernel.append(handle, row) } });
      mesh.registerPack(pack);
      for (const tool of this.#tools.values()) mesh.registerTool(tool);
      const result = await mesh.run(event, options);
      this.#kernel.complete(handle, result);
      return result;
    } catch (e) {
      try { this.#kernel.abandon(handle); } catch { /* Storage failure: retain the existing tombstone, never retry tools. */ }
      throw e;
    }
  }
}

/** Policy-only counterfactual: never receives a provider or executor. No claim of new-model replay. */
export function replayPolicy(record, candidatePack) {
  validatePack(candidatePack);
  if (record?.state !== 'completed' || !record.result?.provider) throw new ContractError('Completed prediction required');
  if (record.evidence.eventType !== candidatePack.eventType || record.evidence.pack.questionsDigest !== digest(candidatePack.questions)) throw new ContractError('Replay question contract mismatch');
  const prediction = validateResult(candidatePack.questions, record.result.provider);
  return snapshot({ hypothetical: true, executionAllowed: false, original: record.result.verdict,
    candidate: evaluatePolicy(candidatePack, prediction.answers), candidatePackDigest: digest(candidatePack),
    binding: record.evidence.binding });
}
