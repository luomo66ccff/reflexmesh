import type { DecisionProvider, Json, ProviderResult, Questions } from '../core/types.js';
/** Test fixture provider; never describe these outputs as real model evaluations. */
export class MockProvider implements DecisionProvider {
  readonly id = 'mock';
  constructor(private readonly responder: (state: Json, questions: Questions) => ProviderResult | Promise<ProviderResult>) {}
  async evaluate(state: Json, questions: Questions, signal: AbortSignal): Promise<ProviderResult> {
    signal.throwIfAborted();
    const result = await this.responder(state, questions);
    signal.throwIfAborted();
    return result;
  }
}
