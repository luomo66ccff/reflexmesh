import type { AuditRecord, DecisionEvent, DecisionPack, DecisionProvider, Json, Ledger, Principal, ProposedAction, ProviderResult, RunResult, Tool, Verdict } from '../core/types.js';
import { canonical, ContractError, fingerprint, positive, snapshot, validateEvent, validatePack, validateResult, assertJson } from '../core/validation.js';
import { evaluatePolicy } from '../core/policy.js';
import { withDeadline } from './deadline.js';
import { snapshotProvider } from '../core/provider-capabilities.js';

export interface MeshOptions {
  provider: DecisionProvider;
  ledger: Ledger;
  mode?: 'shadow' | 'active';
  decisionTimeoutMs?: number;
  actionTimeoutMs?: number;
  maxEventBytes?: number;
  maxRetainedEvents?: number;
  /** Trusted application function; deny by default. Never use a model as authorization. */
  authorize?: (principal: Principal, action: ProposedAction, event: DecisionEvent) => boolean | Promise<boolean>;
}
export interface RunOptions { readonly packId: string; readonly action?: ProposedAction; readonly principal?: Principal }
export class ReflexMesh {
  readonly #packs = new Map<string, DecisionPack>();
  readonly #tools = new Map<string, Tool>();
  readonly #runs = new Map<string, { request: string; result: Promise<RunResult> }>();
  readonly #options: Required<Omit<MeshOptions, 'authorize'>> & Pick<MeshOptions, 'authorize'>;
  constructor(options: MeshOptions) {
    const decisionTimeoutMs = options.decisionTimeoutMs ?? 3000;
    const actionTimeoutMs = options.actionTimeoutMs ?? 5000;
    const maxEventBytes = options.maxEventBytes ?? 128_000;
    const maxRetainedEvents = options.maxRetainedEvents ?? 10_000;
    for (const [n, v] of Object.entries({ decisionTimeoutMs, actionTimeoutMs, maxEventBytes, maxRetainedEvents })) positive(v, n);
    if (!Number.isSafeInteger(maxRetainedEvents)) throw new ContractError('Invalid retained event limit');
    if (options.mode !== undefined && !['shadow', 'active'].includes(options.mode)) throw new ContractError('Invalid mode');
    this.#options = { ...options, provider: snapshotProvider(options.provider), mode: options.mode ?? 'shadow',
      decisionTimeoutMs, actionTimeoutMs, maxEventBytes, maxRetainedEvents };
  }
  registerPack(pack: DecisionPack): this {
    validatePack(pack);
    if (this.#packs.has(pack.id)) throw new ContractError('Pack already registered');
    this.#packs.set(pack.id, snapshot(pack)); return this;
  }
  registerTool(tool: Tool): this {
    if (!tool.id || this.#tools.has(tool.id) || !['read', 'write', 'destructive'].includes(tool.effect) || typeof tool.execute !== 'function' || typeof tool.idempotent !== 'boolean' || typeof tool.speculatable !== 'boolean') throw new ContractError('Invalid tool registration');
    this.#tools.set(tool.id, Object.freeze({ ...tool, execute: tool.execute.bind(tool) })); return this;
  }
  run(event: DecisionEvent, options: RunOptions): Promise<RunResult> {
    try {
      validateEvent(event);
      const pack = this.#packs.get(options.packId);
      if (!pack || pack.eventType !== event.type) throw new ContractError('No matching pack');
      assertJson(options);
      if (options.action && (typeof options.action.toolId !== 'string' || !Object.hasOwn(options.action, 'args'))) throw new ContractError('Invalid action');
      if (options.principal && (typeof options.principal.id !== 'string' || !options.principal.id || typeof options.principal.tenantId !== 'string')) throw new ContractError('Invalid principal');
      const request = canonical({ event, options, pack,
        provider: { id: this.#options.provider.id, capabilities: this.#options.provider.capabilities } });
      if (new TextEncoder().encode(request).length > this.#options.maxEventBytes) throw new ContractError('Event size limit exceeded');
      const key = canonical([event.tenantId, event.source, event.id]);
      const previous = this.#runs.get(key);
      if (previous) {
        if (previous.request !== request) throw new ContractError('Idempotency conflict');
        return previous.result;
      }
      // Never silently evict a side-effect tombstone: back-pressure instead of duplicate execution.
      if (this.#runs.size >= this.#options.maxRetainedEvents) throw new ContractError('Idempotency capacity reached');
      const e = snapshot(event); const o = snapshot(options);
      const result = this.#process(e, o, pack, request);
      this.#runs.set(key, { request, result });
      return result;
    } catch (error) { return Promise.reject(error); }
  }
  async #process(event: DecisionEvent, options: RunOptions, pack: DecisionPack, request: string): Promise<RunResult> {
    const audit = (kind: AuditRecord['kind'], details: Record<string, Json>): Promise<void> => this.#options.ledger.append({ kind, source: event.source, eventId: event.id, tenantId: event.tenantId, time: new Date().toISOString(), details });
    const requestHash = await fingerprint(JSON.parse(request));
    // Raw state, tool arguments, principal credentials and provider error text are not logged.
    await audit('decision.started', { pack: pack.id, packVersion: pack.version, providerId: this.#options.provider.id, requestHash });
    let provider: ProviderResult | undefined;
    let verdict: Verdict;
    const started = performance.now();
    try {
      const registered = options.action ? this.#tools.get(options.action.toolId) : undefined;
      const state: Json = options.action ? {
        untrustedState: event.state,
        proposedAction: { toolId: options.action.toolId, args: options.action.args },
        registeredEffect: registered?.effect ?? 'unknown',
      } : event.state;
      const raw = await withDeadline(this.#options.decisionTimeoutMs, signal => this.#options.provider.evaluate(snapshot(state), pack.questions, signal));
      provider = validateResult(pack.questions, raw);
      verdict = evaluatePolicy(pack, provider.answers);
    } catch {
      verdict = { effect: 'escalate', ruleId: 'provider_unavailable_or_invalid' };
    }
    await audit('decision.completed', { verdict: { ...verdict }, elapsedMs: performance.now() - started, ...(provider ? { model: provider.model, answers: provider.answers as unknown as Json } : {}) });
    const finish = async (status: RunResult['status'], reasonCode?: string, output?: Json): Promise<RunResult> => {
      await audit('outcome', { status, ...(reasonCode ? { reasonCode } : {}) });
      return snapshot({ eventId: event.id, status, verdict, ...(provider ? { provider } : {}), ...(reasonCode ? { reasonCode } : {}), ...(output === undefined ? {} : { output }) });
    };
    if (this.#options.mode === 'shadow') return finish('shadow');
    if (verdict.effect !== 'allow') return finish('blocked', verdict.effect);
    if (!options.action) return finish('assessed');
    const tool = this.#tools.get(options.action.toolId);
    if (!tool) return finish('blocked', 'unregistered_tool');
    if (!options.principal || options.principal.tenantId !== event.tenantId || !this.#options.authorize) return finish('blocked', 'authorization_required');
    // v0.1 deliberately refuses writes even with a favourable model score.
    if (tool.effect !== 'read') return finish('blocked', 'write_confirmation_not_implemented');
    let allowed = false;
    try { allowed = await withDeadline(this.#options.decisionTimeoutMs, async () => (await this.#options.authorize!(options.principal!, options.action!, event)) === true); } catch { /* deny */ }
    if (!allowed) return finish('blocked', 'authorization_denied');
    await audit('action.started', { toolId: tool.id });
    let output: Json;
    try {
      output = await withDeadline(this.#options.actionTimeoutMs, signal => tool.execute(options.action!.args, signal));
      assertJson(output);
    } catch { return finish('recovery_required', 'action_state_unknown'); }
    // Ledger failure here rejects and leaves a tombstone; the action is never automatically retried.
    return finish('succeeded', undefined, output);
  }
}
