import type { Answers, DecisionPack, Verdict } from './types.js';
/** Consumes already validated answers. No eval(), model-generated code, or dynamic actions. */
export function evaluatePolicy(pack: DecisionPack, answers: Answers): Verdict {
  for (const rule of pack.rules) {
    if (rule.all.every(c => {
      const answer = answers[c.answer];
      if (!answer) return false;
      const value = c.metric === 'confidence'
        ? ('confidence' in answer ? answer.confidence : undefined)
        : (answer.type === 'noul' ? answer.noul : answer.type === 'choice' ? answer.choice : answer.score);
      if (c.op === 'eq') return value === c.value;
      if (typeof value !== 'number' || typeof c.value !== 'number') return false;
      return c.op === 'gte' ? value >= c.value : value <= c.value;
    })) return { effect: rule.effect, ruleId: rule.id, ...(rule.directive === undefined ? {} : { directive: rule.directive }) };
  }
  return { effect: pack.fallback, ruleId: 'fallback' };
}
