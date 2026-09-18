import { canonical, snapshot, validateCall, ContractError } from '../dist/index.js';
import { DurableMesh, eventKey, replayPolicy } from './durable-mesh.mjs';
import { digest } from './sqlite-kernel.mjs';

/** Observes host actions; never calls, grants, blocks, rewrites or replays a host tool. */
export class ShadowBoundary {
  #kernel; #mesh; #tenant; #scope; #pack;
  constructor({ kernel, provider, binding, pack, tenantId, scope }) {
    if (![tenantId, scope].every(s => typeof s === 'string' && s.length > 0 && s.length <= 64)) throw new ContractError('Trusted tenant/scope required');
    this.#kernel = kernel; this.#tenant = tenantId; this.#scope = scope; this.#pack = snapshot(pack);
    this.#mesh = new DurableMesh({ kernel, provider, binding, mode: 'shadow', decisionTimeoutMs: 3000 }).registerPack(pack);
  }
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
  inspect(call) { return this.#kernel.inspect(eventKey(this.event(call))); }
  replay(call, candidatePack = this.#pack) { return replayPolicy(this.inspect(call), candidatePack); }
  inspectPack() { return snapshot({ pack: this.#pack, digest: digest(this.#pack), mode: 'shadow', control: 'abstain' }); }
}
