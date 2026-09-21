import type { DecisionProvider, Json, ProviderCapabilitiesV1, Questions } from './types.js';
import { assertJson, canonical, ContractError, record, snapshot, validateQuestions } from './validation.js';

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function validLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** A trusted declaration, not a model-supplied capability or calibration certificate. */
export function validateProviderCapabilities(value: unknown): ProviderCapabilitiesV1 {
  assertJson(value);
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'resultContract', 'probabilitySemantics', 'answers', 'limits'])
    || value.schemaVersion !== 1 || !['probabilistic-v1', 'label-only-v1'].includes(value.resultContract as string)
    || !['provider-native', 'elicited-estimate', 'synthetic-fixture', 'none'].includes(value.probabilitySemantics as string)
    || !record(value.answers) || !exactKeys(value.answers, ['noul', 'choice', 'score'])
    || !['probability', 'unsupported'].includes(value.answers.noul as string)
    || !['distribution-with-confidence', 'label-only', 'unsupported'].includes(value.answers.choice as string)
    || !['distribution-with-confidence-and-expected-value', 'unsupported'].includes(value.answers.score as string)
    || !record(value.limits) || !exactKeys(value.limits, ['maxStateBytes', 'maxQuestions', 'maxChoicesPerQuestion'])
    || !validLimit(value.limits.maxStateBytes) || !validLimit(value.limits.maxQuestions)
    || !validLimit(value.limits.maxChoicesPerQuestion)) throw new ContractError('Invalid provider capabilities');
  const answers = value.answers;
  const numeric = answers.noul !== 'unsupported' || answers.choice === 'distribution-with-confidence'
    || answers.score !== 'unsupported';
  if (value.resultContract === 'probabilistic-v1') {
    if (answers.choice === 'label-only' || (numeric && value.probabilitySemantics === 'none')
      || (!numeric && value.probabilitySemantics !== 'none')) throw new ContractError('Contradictory provider capabilities');
  } else if (answers.noul !== 'unsupported' || answers.score !== 'unsupported'
    || answers.choice === 'distribution-with-confidence' || value.probabilitySemantics !== 'none') {
    throw new ContractError('Contradictory provider capabilities');
  }
  return snapshot(value as unknown as ProviderCapabilitiesV1);
}

/** Recheck actual final input immediately before the selected provider can make an egress call. */
export function assertProviderInput(caps: ProviderCapabilitiesV1, state: Json, questions: Questions, signal: AbortSignal): void {
  const validated = validateProviderCapabilities(caps);
  if (!signal || typeof signal.throwIfAborted !== 'function' || typeof signal.aborted !== 'boolean')
    throw new ContractError('Invalid provider signal');
  signal.throwIfAborted();
  assertJson(state);
  // validateQuestions checks the semantic fields, but not hidden JSON serialization hooks.
  // Reject accessors/toJSON before a provider can serialize a different wire question set.
  const questionJson: unknown = questions;
  assertJson(questionJson);
  validateQuestions(questions);
  if (new TextEncoder().encode(canonical(state)).length > validated.limits.maxStateBytes)
    throw new ContractError('Provider state byte limit exceeded');
  if (Object.keys(questions).length > validated.limits.maxQuestions)
    throw new ContractError('Provider question limit exceeded');
  if (validated.resultContract !== 'probabilistic-v1')
    throw new ContractError('Unsupported provider result contract');
  for (const question of Object.values(questions)) {
    if (question.type === 'noul' && validated.answers.noul !== 'probability')
      throw new ContractError('Unsupported provider question type');
    if (question.type === 'choice' && validated.answers.choice !== 'distribution-with-confidence')
      throw new ContractError('Unsupported provider question type');
    if (question.type === 'score' && validated.answers.score !== 'distribution-with-confidence-and-expected-value')
      throw new ContractError('Unsupported provider question type');
    const choices = question.type === 'choice' ? Object.keys(question.criteria).length
      : question.type === 'score' ? question.criteria.length : 0;
    if (choices > validated.limits.maxChoicesPerQuestion)
      throw new ContractError('Provider choice limit exceeded');
  }
  signal.throwIfAborted();
}

/** Capture id, declaration and method once; later mutation cannot widen this wrapper's authority. */
export function snapshotProvider(provider: DecisionProvider): DecisionProvider {
  const id = provider?.id, model = provider?.model, evaluate = provider?.evaluate;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id)
    || typeof evaluate !== 'function'
    || (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 256
      || /[\u0000-\u001f\u007f-\u009f]/.test(model)))) throw new ContractError('Invalid decision provider');
  const capabilities = validateProviderCapabilities(provider.capabilities);
  return Object.freeze({ id, ...(model === undefined ? {} : { model }), capabilities,
    evaluate(state: Json, questions: Questions, signal: AbortSignal) {
      assertProviderInput(capabilities, state, questions, signal);
      return evaluate.call(provider, state, questions, signal);
    },
  });
}
