import { canonical, snapshot, validateCall, ContractError } from '../dist/index.js';
import { DurableMesh, eventKey, replayPolicy } from './durable-mesh.mjs';
import { digest } from './sqlite-kernel.mjs';
import { resolveHostIntent } from './task-evidence.mjs';
import { normalizeProviderBinding } from './provider-binding.mjs';

// Internal identity check for a Loader-owned synchronous storage fence.
export const BOUNDARY_USES_KERNEL = Symbol('reflexmesh.boundaryUsesKernel');

/** Observes host actions; never calls, grants, blocks, rewrites or replays a host tool. */
export class ShadowBoundary {
  #kernel; #mesh; #tenant; #scope; #pack; #deploymentDigest;
  constructor({ kernel, provider, binding, pack, tenantId, scope }) {
    if (![tenantId, scope].every(s => typeof s === 'string' && s.length > 0 && s.length <= 64)) throw new ContractError('Trusted tenant/scope required');
    this.#kernel = kernel; this.#tenant = tenantId; this.#scope = scope; this.#pack = snapshot(pack);
    const normalizedBinding = normalizeProviderBinding(provider, binding);
    this.#deploymentDigest = digest({ packDigest: digest(this.#pack), binding: normalizedBinding, mode: 'shadow' });
    this.#mesh = new DurableMesh({ kernel, provider, binding: normalizedBinding,
      mode: 'shadow', decisionTimeoutMs: 3000 }).registerPack(pack);
  }
  [BOUNDARY_USES_KERNEL](candidate) { return this.#kernel === candidate; }
  event(call, userIntent = null) {
    validateCall(call);
    if (userIntent !== null && (typeof userIntent !== 'string' || userIntent.length > 16000)) throw new ContractError('Invalid intent evidence');
    return { id: digest([call.sessionId, call.agentId, call.callId, 'before']), type: this.#pack.eventType,
      source: `reflexmesh:${this.#scope}:${call.harness}`, tenantId: this.#tenant, time: new Date().toISOString(),
      state: { userIntent, proposedAction: { toolId: call.toolName, args: call.arguments } } };
  }
  async before(call, userIntent = null) {
    const e = this.event(call, userIntent);
    const r = await this.#mesh.run(e, { packId: this.#pack.id });
    return snapshot({ schemaVersion: 1, decisionId: eventKey(e), mode: 'shadow', control: 'abstain', ...r });
  }
  after(call, status, evidence, provenance = 'harness-reported') {
    const e = this.event(call), key = eventKey(e);
    const original = this.#kernel.inspect(key);
    if (!original) throw new ContractError('Orphan outcome');
    if (original.evidence.actionDigest !== digest({ toolId: call.toolName, args: call.arguments })) throw new ContractError('Outcome action mismatch');
    // Validate a bounded digest, not a durable raw transcript or tool-output copy.
    if (Buffer.byteLength(canonical(evidence)) > 1000000) throw new ContractError('Outcome evidence too large');
    this.#kernel.observe(key, { id: digest([call.callId, 'outcome']), status, evidenceDigest: digest(evidence), provenance });
    return { decisionId: key, recorded: true, labelCreated: false };
  }
  #claudeDescriptor(call) {
    validateCall(call);
    if (call.harness !== 'claude-code') throw new ContractError('Claude hook call required');
    // Do not call an overridable event() here: reserve before reading task state.
    return { key: eventKey({ tenantId: this.#tenant, source: `reflexmesh:${this.#scope}:claude-code`,
      id: digest([call.sessionId, call.agentId, call.callId, 'before']) }),
    callDigest: digest(call), actionDigest: digest({ toolId: call.toolName, args: call.arguments }),
    deploymentDigest: this.#deploymentDigest };
  }
  async beforeClaudeHook(call, resolveIntent) {
    const normalized = snapshot(call);
    const receipt = this.#kernel.beginClaudeHookPairing(this.#claudeDescriptor(normalized));
    try {
      const intent = resolveHostIntent(resolveIntent, normalized);
      const result = await this.before(normalized, intent);
      this.#kernel.completeClaudeHookPairing(receipt, { decisionId: result.decisionId });
      return result;
    } catch (error) {
      // If storage also fails, pending still cannot authorize a post observation.
      try { this.#kernel.blockClaudeHookPairing(receipt, 'before_failed'); } catch {}
      throw error;
    }
  }
  afterClaudeHook(call, status, evidence) {
    const descriptor = this.#claudeDescriptor(snapshot(call));
    if (Buffer.byteLength(canonical(evidence)) > 1000000) throw new ContractError('Outcome evidence too large');
    this.#kernel.observeClaudeHookPairing(descriptor, { id: digest([call.callId, 'outcome']),
      status, evidenceDigest: digest(evidence), provenance: 'harness-reported' });
    return { decisionId: descriptor.key, recorded: true, labelCreated: false };
  }
  inspect(call) { return this.#kernel.inspect(eventKey(this.event(call))); }
  replay(call, candidatePack = this.#pack) { return replayPolicy(this.inspect(call), candidatePack); }
  inspectPack() { return snapshot({ pack: this.#pack, digest: digest(this.#pack), mode: 'shadow', control: 'abstain' }); }
}
