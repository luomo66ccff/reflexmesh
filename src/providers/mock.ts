import type { DecisionProvider, Json, ProviderResult, Questions } from '../core/types.js';
import { assertProviderInput, validateProviderCapabilities } from '../core/provider-capabilities.js';
/** Test fixture provider; never describe these outputs as real model evaluations. */
export class MockProvider implements DecisionProvider {
  readonly id = 'mock';
  readonly capabilities = validateProviderCapabilities({
    schemaVersion: 1, resultContract: 'probabilistic-v1', probabilitySemantics: 'synthetic-fixture',
    answers: { noul: 'probability', choice: 'distribution-with-confidence',
      score: 'distribution-with-confidence-and-expected-value' },
    limits: { maxStateBytes: 1_048_576, maxQuestions: 128, maxChoicesPerQuestion: 255 },
  });
  constructor(private readonly responder: (state: Json, questions: Questions) => ProviderResult | Promise<ProviderResult>) {}
  async evaluate(state: Json, questions: Questions, signal: AbortSignal): Promise<ProviderResult> {
    assertProviderInput(this.capabilities, state, questions, signal);
    const result = await this.responder(state, questions);
    signal.throwIfAborted();
    return result;
  }
}
