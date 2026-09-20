import { createHash } from 'node:crypto';
import { ContractError, canonical, record, snapshot } from '../dist/index.js';

export const INTENT_POLICY = 'explicit-summary-v1';
export const MAX_SUMMARY_BYTES = 2048;
export const MAX_INTENT_TTL_MS = 600000;
export const intentDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const names = ['codex', 'claude-code', 'deepseek-harness', 'openai-compatible'];
const sources = ['claude-explicit-summary', 'host-declared', 'model-reported'];
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
const fields = (v, keys) => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const check = (ok, msg) => { if (!ok) throw new ContractError(msg); };
export function validateIntentScope(value) {
  const v = snapshot(value);
  check(fields(v, ['harness','sessionId','agentId']) && names.includes(v.harness) && id(v.sessionId) && id(v.agentId), 'Invalid task scope');
  return v;
}
export const scopeOfCall = call => validateIntentScope({ harness: call.harness, sessionId: call.sessionId, agentId: call.agentId });

// A conservative, deliberately incomplete detector; NOT a general secret/PII scanner.
// Suspicious summaries are withheld as a whole rather than rewritten or truncated.
function suspicious(text) {
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/i.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i.test(text)
    || /\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[=:]\s*["']?[^\s"']{6,}/i.test(text)
    || /\b(?:sk-proj-|gh[pousr]_)[A-Za-z0-9_-]{12,}/.test(text);
}
export function summaryStatus(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return 'missing';
  if (Buffer.byteLength(value, 'utf8') > MAX_SUMMARY_BYTES) return 'too_large';
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'invalid';
  if (suspicious(value)) return 'withheld';
  return 'ready';
}
/** Only an explicit FIRST line is retained. All remaining prompt/transcript text is ignored. */
export function selectExplicitSummary(prompt) {
  if (typeof prompt !== 'string') return { status: 'missing', summary: null };
  const firstLine = prompt.split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith('ReflexMesh-Intent: ')) return { status: 'not_selected', summary: null };
  const selected = firstLine.slice('ReflexMesh-Intent: '.length).trim();
  const status = summaryStatus(selected);
  return { status, summary: status === 'ready' ? selected : null };
}
/** Source is provenance, not verified identity, authority, or a complete user-intent claim. */
export function inspectTaskIntent(input, callScope, now = Date.now()) {
  const scope = validateIntentScope(callScope);
  check(Number.isSafeInteger(now) && now >= 0, 'Invalid intent clock');
  if (input == null) return snapshot({ summary: null, receipt: { schemaVersion: 1, policy: INTENT_POLICY, status: 'missing', coverage: 'none' } });
  const v = snapshot(input);
  check(fields(v, ['schemaVersion','id','scope','source','summary','issuedAt','expiresAt']) && v.schemaVersion === 1 && id(v.id) && sources.includes(v.source), 'Invalid task intent envelope');
  validateIntentScope(v.scope);
  check(canonical(scope) === canonical(v.scope), 'Task intent scope mismatch');
  if (v.source === 'claude-explicit-summary') check(scope.harness === 'claude-code', 'Task intent source mismatch');
  const modelReported = v.source === 'model-reported';
  if (modelReported) check(v.issuedAt === null && v.expiresAt === null, 'Model-reported freshness must remain unverified');
  else check(Number.isSafeInteger(v.issuedAt) && Number.isSafeInteger(v.expiresAt) && v.issuedAt >= 0 && v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= MAX_INTENT_TTL_MS, 'Invalid intent lifetime');
  let status = summaryStatus(v.summary);
  if (!modelReported && (now < v.issuedAt || now >= v.expiresAt)) status = 'expired';
  const receipt = { schemaVersion: 1, policy: INTENT_POLICY, status, coverage: status === 'ready' ? 'summary-only' : 'none', id: v.id, source: v.source,
    scopeDigest: intentDigest(scope), freshness: modelReported ? 'unverified' : status === 'expired' ? 'expired' : 'within_ttl',
    issuedAt: v.issuedAt, expiresAt: v.expiresAt,
    ...(status === 'ready' ? { summaryDigest: intentDigest(v.summary) } : {}),
  };
  return snapshot({ summary: status === 'ready' ? v.summary : null, receipt });
}
/** Whitelist the metadata allowed in the durable journal; never retain the summary itself. */
export function taskReceiptFromState(state) {
  if (!record(state) || !Object.hasOwn(state, 'taskEvidence')) return undefined;
  const v = snapshot(state.taskEvidence);
  check(record(v) && v.schemaVersion === 1 && v.policy === INTENT_POLICY
    && ['missing','too_large','invalid','withheld','expired','ready'].includes(v.status), 'Invalid task receipt');
  if (!Object.hasOwn(v, 'id')) {
    check(fields(v, ['schemaVersion','policy','status','coverage']) && v.status === 'missing' && v.coverage === 'none' && state.userIntent === null, 'Invalid missing-task receipt');
    return v;
  }
  const keys = ['schemaVersion','policy','status','coverage','id','source','scopeDigest','freshness','issuedAt','expiresAt'];
  if (v.status === 'ready') keys.push('summaryDigest');
  check(v.coverage === (v.status === 'ready' ? 'summary-only' : 'none'), 'Invalid task coverage');
  check(fields(v, keys) && id(v.id) && sources.includes(v.source) && typeof v.scopeDigest === 'string' && /^[a-f0-9]{64}$/.test(v.scopeDigest), 'Invalid task receipt identity');
  if (v.source === 'model-reported') check(v.issuedAt === null && v.expiresAt === null && v.freshness === 'unverified', 'Invalid model receipt freshness');
  else check(Number.isSafeInteger(v.issuedAt) && Number.isSafeInteger(v.expiresAt) && v.issuedAt >= 0 && v.expiresAt > v.issuedAt
    && v.expiresAt - v.issuedAt <= MAX_INTENT_TTL_MS && v.freshness === (v.status === 'expired' ? 'expired' : 'within_ttl'), 'Invalid host receipt freshness');
  if (v.status === 'ready') check(summaryStatus(state.userIntent) === 'ready' && v.summaryDigest === intentDigest(state.userIntent), 'Task receipt content mismatch');
  else check(state.userIntent === null, 'Unavailable task must not retain summary text');
  return v;
}

/** Host resolvers are pure synchronous projections, not additional network/tool workflows. */
export function resolveHostIntent(resolver, input) {
  if (resolver === undefined) return null;
  check(typeof resolver === 'function', 'Invalid host intent resolver');
  const value = resolver(input);
  if (value && typeof value.then === 'function') {
    // Consume a rejected promise to avoid an unhandled rejection, but never await an unbounded resolver.
    Promise.resolve(value).catch(() => {});
    throw new ContractError('Host intent resolver must be synchronous');
  }
  return snapshot(value ?? null);
}
