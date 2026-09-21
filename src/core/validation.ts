import type { Answer, Answers, DecisionEvent, DecisionPack, Json, ProviderResult, Questions } from './types.js';

export class ContractError extends Error {
  constructor(message: string) { super(message); this.name = 'ContractError'; }
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invariant(ok: boolean, message: string): asserts ok {
  if (!ok) throw new ContractError(message);
}
export function probability(value: unknown): asserts value is number {
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, 'Invalid probability');
}
export function positive(value: number, name: string): void {
  invariant(Number.isFinite(value) && value > 0, `Invalid ${name}`);
}
export function assertJson(value: unknown, depth = 0, seen = new Set<object>()): asserts value is Json {
  invariant(depth <= 40, 'JSON nesting limit exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { invariant(Number.isFinite(value), 'Non-finite JSON number'); return; }
  invariant(typeof value === 'object' && value !== null, 'Non-JSON value');
  invariant(!seen.has(value), 'Cyclic JSON');
  invariant(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'Non-plain JSON object');
  seen.add(value);
  if (Array.isArray(value)) {
    invariant(Object.getPrototypeOf(value) === Array.prototype, 'Non-plain JSON array');
    invariant(Object.getOwnPropertySymbols(value).length === 0, 'Symbol key in JSON array');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    invariant(Object.keys(descriptors).length === value.length + 1, 'Extra or sparse JSON array property');
    for (let i = 0; i < value.length; i++) {
      const descriptor = descriptors[String(i)];
      invariant(descriptor !== undefined, 'Sparse JSON array');
      invariant('value' in descriptor, 'JSON accessor rejected');
      assertJson(descriptor.value, depth + 1, seen);
    }
  } else {
    invariant(Object.getOwnPropertySymbols(value).length === 0, 'Symbol key in JSON');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      invariant('value' in descriptor, 'JSON accessor rejected');
      invariant(descriptor.enumerable === true, 'Non-enumerable JSON property rejected');
      assertJson(descriptor.value, depth + 1, seen);
    }
  }
  seen.delete(value);
}
export function canonical(value: unknown): string {
  assertJson(value);
  const walk = (v: Json): string => {
    if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + walk(v[k]!)).join(',') + '}';
    return JSON.stringify(v);
  };
  return walk(value);
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
export function snapshot<T>(value: T): T {
  assertJson(value);
  return freeze(structuredClone(value));
}
export async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateEvent(value: unknown): asserts value is DecisionEvent {
  assertJson(value);
  invariant(record(value), 'Invalid event');
  for (const key of ['id', 'type', 'source', 'tenantId', 'time']) {
    invariant(typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256, `Invalid event ${key}`);
  }
  invariant(Number.isFinite(Date.parse(value.time as string)), 'Invalid event time');
  invariant(Object.hasOwn(value, 'state'), 'Missing event state');
}
export function validateQuestions(questions: Questions): void {
  invariant(record(questions) && Object.keys(questions).length > 0 && Object.keys(questions).length <= 128, 'Invalid question count');
  for (const [name, q] of Object.entries(questions)) {
    invariant(/^[a-zA-Z][\w.-]{0,127}$/.test(name) && !['constructor', '__proto__', 'prototype'].includes(name), 'Unsafe question identifier');
    invariant(record(q) && typeof q.instructions === 'string' && q.instructions.length > 0, 'Missing instructions');
    invariant(['noul', 'choice', 'score'].includes(q.type), 'Unknown question type');
    if (q.type === 'choice') {
      invariant(record(q.criteria), 'Invalid choice criteria');
      const keys = Object.keys(q.criteria);
      invariant(keys.length >= 2 && keys.length <= 255, 'Invalid choice count');
      invariant(keys.every(k => k.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(k)), 'Unsafe choice identifier');
      invariant(Object.values(q.criteria).every(v => typeof v === 'string'), 'Invalid criterion description');
    } else if (q.type === 'score') {
      invariant(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 255 && q.criteria.every(v => typeof v === 'string'), 'Invalid score rubric');
    }
  }
}
function distribution(value: unknown, keys: readonly string[]): Readonly<Record<string, number>> {
  invariant(record(value), 'Missing probability distribution');
  invariant(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'Distribution label mismatch');
  let sum = 0;
  for (const p of Object.values(value)) { probability(p); sum += p; }
  invariant(Math.abs(sum - 1) <= 0.001, 'Probability mass must sum to one');
  return value as Record<string, number>;
}
export function validateResult(questions: Questions, value: unknown): ProviderResult {
  invariant(record(value) && typeof value.model === 'string' && value.model.length > 0 && record(value.answers), 'Invalid provider result');
  const raw = value.answers;
  invariant(Object.keys(raw).length === Object.keys(questions).length, 'Answer count mismatch');
  const entries: [string, Answer][] = [];
  for (const [id, q] of Object.entries(questions)) {
    invariant(Object.hasOwn(raw, id), 'Missing answer');
    const a = raw[id];
    invariant(record(a) && a.type === q.type, 'Answer type mismatch');
    if (q.type === 'noul') {
      probability(a.noul); entries.push([id, { type: 'noul', noul: a.noul }]);
    } else if (q.type === 'choice') {
      probability(a.confidence);
      invariant(typeof a.choice === 'string' && Object.hasOwn(q.criteria, a.choice), 'Unknown selected label');
      entries.push([id, { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: distribution(a.probabilities, Object.keys(q.criteria)) }]);
    } else {
      probability(a.confidence);
      invariant(typeof a.score === 'number' && Number.isFinite(a.score) && a.score >= 0 && a.score <= q.criteria.length - 1, 'Score outside rubric');
      const probabilities = distribution(a.probabilities, q.criteria.map((_, i) => String(i)));
      const expected = Object.entries(probabilities).reduce((sum, [k, p]) => sum + Number(k) * p, 0);
      invariant(Math.abs(expected - a.score) <= 0.002, 'Score inconsistent with expectation');
      entries.push([id, { type: 'score', score: a.score, confidence: a.confidence, probabilities }]);
    }
  }
  let usage: ProviderResult['usage'];
  if (value.usage !== undefined) {
    invariant(record(value.usage), 'Invalid usage');
    const { inputTokens, outputTokens } = value.usage;
    invariant(Number.isSafeInteger(inputTokens) && (inputTokens as number) >= 0 && Number.isSafeInteger(outputTokens) && (outputTokens as number) >= 0, 'Invalid token usage');
    usage = { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
  }
  return snapshot({ model: value.model, answers: Object.fromEntries(entries) as Answers, ...(usage ? { usage } : {}) });
}
export function validatePack(pack: DecisionPack): void {
  assertJson(pack);
  invariant(record(pack) && [pack.id, pack.version, pack.eventType].every(x => typeof x === 'string' && x.length > 0), 'Invalid pack metadata');
  validateQuestions(pack.questions);
  invariant(['deny', 'confirm', 'escalate'].includes(pack.fallback), 'Unsafe fallback');
  invariant(Array.isArray(pack.rules), 'Invalid rules');
  const ids = new Set<string>();
  for (const rule of pack.rules) {
    invariant(typeof rule.id === 'string' && rule.id.length > 0 && !ids.has(rule.id), 'Invalid or duplicate rule'); ids.add(rule.id);
    invariant(['allow', 'deny', 'confirm', 'escalate'].includes(rule.effect), 'Unknown effect');
    invariant(rule.directive === undefined || typeof rule.directive === 'string', 'Invalid directive');
    invariant(Array.isArray(rule.all) && rule.all.length > 0, 'Unconditional rule not allowed');
    for (const c of rule.all) {
      invariant(Object.hasOwn(pack.questions, c.answer), 'Unknown question in condition');
      const q = pack.questions[c.answer]!;
      invariant(['value', 'confidence'].includes(c.metric) && ['eq', 'gte', 'lte'].includes(c.op), 'Invalid condition');
      if (c.metric === 'confidence') { invariant(q.type !== 'noul', 'Noul has no confidence field'); probability(c.value); }
      else if (q.type === 'choice') invariant(c.op === 'eq' && typeof c.value === 'string' && Object.hasOwn(q.criteria, c.value), 'Invalid choice condition');
      else {
        invariant(typeof c.value === 'number' && Number.isFinite(c.value), 'Invalid numeric condition');
        if (q.type === 'noul') probability(c.value);
        else invariant((c.value as number) >= 0 && (c.value as number) <= q.criteria.length - 1, 'Condition outside rubric');
      }
    }
  }
}
