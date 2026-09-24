import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekEstimateProvider, MemoryLedger, MockProvider, ReflexMesh, toolPreflightPack } from '../dist/index.js';
import { assertProviderInput, snapshotProvider, validateProviderCapabilities } from '../dist/core/provider-capabilities.js';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { DurableMesh, eventKey } from '../adapters/durable-mesh.mjs';
import { normalizeProviderBinding, ABSTAIN_CAPABILITIES } from '../adapters/provider-binding.mjs';
import { TaskAwareBoundary } from '../adapters/task-boundary.mjs';
import { event, requestOptions, result } from './helpers.mjs';

const signal = () => new AbortController().signal;
const binary = { yes: { type: 'noul', instructions: 'Is this true?' } };
const choice = n => ({ route: { type: 'choice', instructions: 'Select route.',
  criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`route${i}`, `Choice ${i}`])) } });
const caps = overrides => ({ schemaVersion: 1, resultContract: 'probabilistic-v1',
  probabilitySemantics: 'elicited-estimate',
  answers: { noul: 'probability', choice: 'unsupported', score: 'unsupported' },
  limits: { maxStateBytes: 100, maxQuestions: 2, maxChoicesPerQuestion: 2 }, ...overrides });
const binding = { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1',
  authorizationRevision: 'test-v1', toolsetRevision: 'test-v1' };

test('declarations are strict, deeply frozen and distinguish probability provenance', () => {
  const original = caps(), valid = validateProviderCapabilities(original);
  assert.notEqual(valid, original);
  assert.equal(Object.isFrozen(valid), true);
  assert.equal(Object.isFrozen(valid.answers), true);
  assert.equal(Object.isFrozen(valid.limits), true);
  original.answers.noul = 'unsupported';
  assert.equal(valid.answers.noul, 'probability');
  assert.throws(() => { valid.limits.maxStateBytes = 1000; }, TypeError);
  for (const bad of [null, { ...caps(), extra: true }, caps({ limits: { ...caps().limits, extra: 1 } }),
    caps({ answers: { ...caps().answers, choice: 'label-only' } }),
    caps({ probabilitySemantics: 'none' }), caps({ probabilitySemantics: 'calibrated' }),
    caps({ limits: { ...caps().limits, maxQuestions: 0 } }),
    caps({ limits: { ...caps().limits, maxStateBytes: 1.5 } }),
    caps({ limits: { ...caps().limits, maxQuestions: Number.MAX_SAFE_INTEGER + 1 } })])
    assert.throws(() => validateProviderCapabilities(bad));
  assert.equal(ABSTAIN_CAPABILITIES.probabilitySemantics, 'none');
  assert.deepEqual(Object.values(ABSTAIN_CAPABILITIES.answers), ['unsupported','unsupported','unsupported']);
  const labelOnly = validateProviderCapabilities({ ...caps(), resultContract: 'label-only-v1',
    probabilitySemantics: 'none', answers: { noul: 'unsupported', choice: 'label-only', score: 'unsupported' } });
  assert.throws(() => assertProviderInput(labelOnly, {}, choice(2), signal()), /result contract/);
});

test('final input gate checks UTF-8 bytes, types, question/choice limits and cancellation', () => {
  const limited = validateProviderCapabilities(caps({ limits: { maxStateBytes: 4, maxQuestions: 1, maxChoicesPerQuestion: 2 } }));
  assert.doesNotThrow(() => assertProviderInput(limited, 'é', binary, signal())); // JSON quotes plus two UTF-8 bytes.
  assert.throws(() => assertProviderInput(limited, '😊', binary, signal()), /byte limit/);
  assert.throws(() => assertProviderInput(limited, {}, { ...binary, second: binary.yes }, signal()), /question limit/);
  assert.throws(() => assertProviderInput(limited, {}, choice(2), signal()), /Unsupported provider question/);
  const choiceCaps = validateProviderCapabilities(caps({ answers: { ...caps().answers,
    choice: 'distribution-with-confidence' } }));
  assert.throws(() => assertProviderInput(choiceCaps, {}, choice(3), signal()), /choice limit/);
  const aborted = new AbortController(); aborted.abort();
  assert.throws(() => assertProviderInput(limited, {}, binary, aborted.signal));
  assert.throws(() => assertProviderInput(limited, {}, binary, {}), /Invalid provider signal/);
});

test('nested question serialization hooks and getters reject before provider evaluation', () => {
  let calls = 0, getterCalls = 0, serializationCalls = 0;
  const provider = snapshotProvider({ id: 'fixture', capabilities: validateProviderCapabilities(caps()),
    evaluate: async () => { calls++; return result(); } });
  const withToJson = { yes: { type: 'noul', instructions: 'Is this true?',
    toJSON() { serializationCalls++; return { type: 'choice', instructions: 'Changed on wire' }; } } };
  assert.throws(() => provider.evaluate({}, withToJson, signal()), /Non-JSON value/);
  assert.equal(serializationCalls, 0);
  const withGetter = { yes: { type: 'noul' } };
  Object.defineProperty(withGetter.yes, 'instructions', { enumerable: true,
    get() { getterCalls++; return 'Changed during validation or serialization'; } });
  assert.throws(() => provider.evaluate({}, withGetter, signal()), /JSON accessor rejected/);
  assert.equal(getterCalls, 0);
  assert.equal(calls, 0);
});

test('array serialization hooks, extra fields and index getters cannot evade the state byte gate', () => {
  let calls = 0, serializationCalls = 0, getterCalls = 0;
  const provider = snapshotProvider({ id: 'fixture', capabilities: validateProviderCapabilities(caps()),
    evaluate: async () => { calls++; return result(); } });
  const withToJson = [];
  withToJson.toJSON = () => { serializationCalls++; return { hidden: 'x'.repeat(17_000) }; };
  assert.throws(() => provider.evaluate(withToJson, binary, signal()), /JSON array property/);
  assert.equal(serializationCalls, 0);
  const withExtra = [];
  withExtra.hidden = 'x'.repeat(17_000);
  assert.throws(() => provider.evaluate(withExtra, binary, signal()), /JSON array property/);
  const withIndexGetter = [null];
  Object.defineProperty(withIndexGetter, '0', { enumerable: true, configurable: true,
    get() { getterCalls++; return { hidden: 'x'.repeat(17_000) }; } });
  assert.throws(() => provider.evaluate(withIndexGetter, binary, signal()), /JSON accessor rejected/);
  assert.equal(getterCalls, 0);
  assert.equal(calls, 0);
});

test('captured provider id, declaration and method cannot be changed after wrapping', async () => {
  let oldCalls = 0, replacementCalls = 0;
  const original = { id: 'fixture', capabilities: caps(), async evaluate() { oldCalls++; return result(); } };
  const provider = snapshotProvider(original);
  original.id = 'other'; original.capabilities.answers.noul = 'unsupported';
  original.evaluate = async () => { replacementCalls++; return result(); };
  assert.equal(provider.id, 'fixture');
  assert.equal(provider.capabilities.answers.noul, 'probability');
  await provider.evaluate({}, binary, signal());
  assert.equal(oldCalls, 1); assert.equal(replacementCalls, 0);
  assert.throws(() => provider.evaluate({}, choice(2), signal()), /Unsupported provider question/);
  assert.equal(oldCalls, 1);
  assert.throws(() => snapshotProvider({ id: 'missing', evaluate: async () => result() }));
});

test('only registered shipped preflight survives provider snapshots, not a lookalike ID or callback', () => {
  let fetchCalls = 0;
  const shipped = new DeepSeekEstimateProvider({ apiKey: 'fake', model: 'fixture', fetch: async () => { fetchCalls++; throw new Error('No network'); } });
  const captured = snapshotProvider(shipped), recaptured = snapshotProvider(captured);
  const long = { yes: { type: 'noul', instructions: 'x'.repeat(33000) } };
  assert.equal(captured.preflightInput({}, binary, signal()), true);
  assert.equal(captured.preflightInput({}, long, signal()), false);
  assert.equal(recaptured.preflightInput({}, long, signal()), false);
  assert.equal(Object.isFrozen(captured), true);
  const lookalike = snapshotProvider({ id: shipped.id, model: shipped.model, capabilities: shipped.capabilities,
    preflightInput() { throw new Error('Untrusted callback'); }, async evaluate() { throw new Error('No network'); } });
  assert.equal(lookalike.preflightInput, undefined);
  assert.equal(fetchCalls, 0);
});

test('explicit model survives wrappers and a mismatched binding rejects before evaluation', t => {
  const kernel = new SqliteKernel(':memory:'); t.after(() => kernel.close());
  let calls = 0;
  const provider = { id: 'mock', model: 'actual-model', capabilities: new MockProvider(result).capabilities,
    evaluate: async () => { calls++; return result(); } };
  const captured = snapshotProvider(provider);
  assert.equal(captured.model, 'actual-model');
  provider.model = 'changed-after-snapshot';
  assert.equal(captured.model, 'actual-model');
  assert.throws(() => normalizeProviderBinding(captured, binding), /model binding mismatch/);
  assert.throws(() => new DurableMesh({ kernel, provider: captured, binding }), /model binding mismatch/);
  assert.throws(() => new TaskAwareBoundary({ kernel, provider: captured, binding,
    pack: toolPreflightPack, tenantId: 'fixture', scope: 'model-check' }), /model binding mismatch/);
  assert.equal(calls, 0);
  assert.equal(kernel.listEvidence().items.length, 0);
});

test('incompatible pack escalates with zero provider calls; invalid declaration rejects construction', async () => {
  let calls = 0;
  const provider = { id: 'fixture', capabilities: validateProviderCapabilities(caps({
    limits: { ...caps().limits, maxStateBytes: 1000 } })),
    evaluate: async () => { calls++; return result(); } };
  const mesh = new ReflexMesh({ provider, ledger: new MemoryLedger() }).registerPack(toolPreflightPack);
  const run = await mesh.run(event(), requestOptions());
  assert.equal(run.verdict.effect, 'allow'); assert.equal(calls, 1);
  const unsupported = { ...provider, capabilities: ABSTAIN_CAPABILITIES };
  const other = new ReflexMesh({ provider: unsupported, ledger: new MemoryLedger() }).registerPack(toolPreflightPack);
  const abstained = await other.run(event(), requestOptions());
  assert.equal(abstained.verdict.effect, 'escalate'); assert.equal(calls, 1);
  assert.throws(() => new ReflexMesh({ provider: { id: 'fixture', evaluate: provider.evaluate },
    ledger: new MemoryLedger() }));
});

test('normalized capability digest binds durable identity and projects without rewriting history', async t => {
  const kernel = new SqliteKernel(':memory:'); t.after(() => kernel.close());
  let calls = 0;
  const provider = new MockProvider(() => { calls++; return result(); });
  const normalized = normalizeProviderBinding(provider, binding);
  assert.match(normalized.capabilitiesDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(normalizeProviderBinding(provider, normalized), normalized);
  assert.throws(() => normalizeProviderBinding(provider, { ...binding, capabilitiesDigest: '0'.repeat(64) }),
    /capabilities binding mismatch/);
  const mesh = new DurableMesh({ kernel, provider, binding }).registerPack(toolPreflightPack);
  const e = event(), r = await mesh.run(e, requestOptions());
  assert.equal(r.verdict.effect, 'allow'); assert.equal(calls, 1);
  const stored = kernel.inspect(eventKey(e));
  assert.equal(stored.evidence.binding.capabilitiesDigest, normalized.capabilitiesDigest);
  assert.deepEqual(stored.evidence.providerCapabilities, provider.capabilities);
  const view = kernel.evidenceSnapshot(eventKey(e));
  assert.deepEqual(view.providerCapabilities,
    { digest: normalized.capabilitiesDigest, probabilitySemantics: 'synthetic-fixture' });
  const changed = { id: 'mock', capabilities: validateProviderCapabilities({
    ...provider.capabilities, probabilitySemantics: 'elicited-estimate' }), evaluate: async () => { calls++; return result(); } };
  await assert.rejects(new DurableMesh({ kernel, provider: changed, binding }).registerPack(toolPreflightPack)
    .run(e, requestOptions()), /Idempotency conflict/);
  assert.equal(calls, 1);
  const legacy = kernel.claim({ key: 'legacy', requestDigest: 'legacy', owner: 'fixture', leaseMs: 100,
    evidence: { mode: 'shadow', binding } });
  kernel.complete(legacy.handle, { status: 'shadow' });
  assert.deepEqual(kernel.evidenceSnapshot('legacy').providerCapabilities,
    { digest: null, probabilitySemantics: null });
  const oldEvent = event();
  const historical = kernel.claim({ key: eventKey(oldEvent), requestDigest: 'pre-capabilities-identity',
    owner: 'fixture', leaseMs: 100, evidence: { mode: 'shadow', binding } });
  kernel.complete(historical.handle, { status: 'shadow' });
  await assert.rejects(new DurableMesh({ kernel, provider, binding }).registerPack(toolPreflightPack)
    .run(oldEvent, requestOptions()), /Idempotency conflict/);
  assert.equal(calls, 1);
});
