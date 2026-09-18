import type { DecisionPack, Question } from './types.js';
import { assertJson, ContractError, snapshot, validatePack } from './validation.js';

export type PortableQuestion =
  | { readonly type: 'binary'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string; readonly choices: Readonly<Record<string, string>> }
  | { readonly type: 'ordinal'; readonly instructions: string; readonly levels: readonly [string, string, ...string[]] };
export interface PortableDecisionPack extends Omit<DecisionPack, 'questions'> {
  readonly schemaVersion: 1;
  readonly questions: Readonly<Record<string, PortableQuestion>>;
}
/** Additive migration bridge. v0.1 Noul/Score wire contracts remain inside the existing engine. */
export function compilePortablePack(source: PortableDecisionPack): DecisionPack {
  assertJson(source);
  if (source.schemaVersion !== 1) throw new ContractError('Unsupported portable pack schema');
  const questions: Record<string, Question> = Object.fromEntries(Object.entries(source.questions).map(([id, q]) => {
    let wire: Question;
    switch (q.type) {
      case 'binary': wire = { type: 'noul', instructions: q.instructions }; break;
      case 'choice': wire = { type: 'choice', instructions: q.instructions, criteria: q.choices }; break;
      case 'ordinal': wire = { type: 'score', instructions: q.instructions, criteria: q.levels }; break;
      default: throw new ContractError('Unsupported portable question');
    }
    return [id, wire];
  }));
  const pack: DecisionPack = { id: source.id, version: source.version, eventType: source.eventType, questions, rules: source.rules, fallback: source.fallback };
  validatePack(pack);
  return snapshot(pack);
}
