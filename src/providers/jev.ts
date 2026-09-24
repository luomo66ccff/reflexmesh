import type { DecisionProvider, Json, ProviderResult, Questions } from '../core/types.js';
import { ContractError, record, validateResult } from '../core/validation.js';
import { assertProviderInput, validateProviderCapabilities } from '../core/provider-capabilities.js';

export interface JevOptions {
  apiKey: string;
  /** Explicit model selection; use an account-supported pinned model for evaluated deployments. */
  model: string;
  /** Trusted transport injection for offline tests. No custom base URL in v0.1. */
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
}
/** Server-only HTTP adapter. Contract verified against official typesafe-sdk-js source. */
export const JEV_CAPABILITIES = validateProviderCapabilities({
  schemaVersion: 1, resultContract: 'probabilistic-v1', probabilitySemantics: 'provider-native',
  answers: { noul: 'probability', choice: 'distribution-with-confidence',
    score: 'distribution-with-confidence-and-expected-value' },
  limits: { maxStateBytes: 256_000, maxQuestions: 128, maxChoicesPerQuestion: 255 },
});
export class JevProvider implements DecisionProvider {
  readonly id = 'typesafe/jev';
  readonly capabilities = JEV_CAPABILITIES;
  readonly model: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxResponseBytes: number;
  constructor(options: JevOptions) {
    if (typeof window !== 'undefined') throw new ContractError('Jev credentials must stay on the server');
    if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new ContractError('Missing or invalid TypeSafe API key');
    if (typeof options.model !== 'string' || !options.model.trim()) throw new ContractError('Explicit model required');
    this.model = options.model;
    this.#apiKey = options.apiKey.trim();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1) throw new ContractError('Invalid response limit');
    Object.freeze(this);
  }
  async evaluate(state: Json, questions: Questions, signal: AbortSignal): Promise<ProviderResult> {
    assertProviderInput(this.capabilities, state, questions, signal);
    const body = JSON.stringify({ state, questions, model: this.model });
    if (new TextEncoder().encode(body).length > 256_000) throw new ContractError('Jev request byte limit exceeded');
    assertProviderInput(this.capabilities, state, questions, signal);
    // Intentionally one attempt: callers control latency/cost budgets and retries.
    const response = await this.#fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', signal, redirect: 'error',
      headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Do not leak a provider response body, which can echo sensitive state.
      throw new Error(`TypeSafe HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ContractError('Empty TypeSafe response');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = ''; let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > this.#maxResponseBytes) { await reader.cancel(); throw new ContractError('TypeSafe response too large'); }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    signal.throwIfAborted();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new ContractError('Invalid TypeSafe JSON'); }
    if (!record(raw)) throw new ContractError('Invalid TypeSafe result');
    if (raw.usage !== undefined && !record(raw.usage)) throw new ContractError('Invalid TypeSafe usage');
    const usage = record(raw.usage) ? { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens } : undefined;
    if (raw.model !== this.model) throw new ContractError('TypeSafe model mismatch');
    return validateResult(questions, { model: raw.model, answers: raw.answers, ...(usage === undefined ? {} : { usage }) });
  }
}
