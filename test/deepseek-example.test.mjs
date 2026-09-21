import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runDeepSeekShadowExample, main } from '../examples/deepseek-shadow.mjs';
import { openLocalBoundary } from '../adapters/local-config.mjs';

const env = { REFLEXMESH_ALLOW_REMOTE: 'true', DEEPSEEK_API_KEY: 'OFFLINE_SECRET', DEEPSEEK_MODEL: 'fixture-model', REFLEXMESH_PROVIDER_REVISION: 'fixture-v1' };
const fixture = async (_url, init) => {
  const request = JSON.parse(init.body), { questions } = JSON.parse(request.messages[1].content);
  return Response.json({ object: 'chat.completion', model: request.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.5 }])) }) } }],
    usage: { prompt_tokens: 50, completion_tokens: 30 } });
};
test('independent provider demo has one injected call and never claims real inference', async () => {
  let calls = 0;
  const report = await runDeepSeekShadowExample(env, { fetch: async (...args) => { calls++; return fixture(...args); } });
  assert.equal(report.status, 'passed', JSON.stringify(report)); assert.equal(calls, 1);
  assert.equal(report.assertions.length, 11); assert.equal(report.assertions.every(item => item.passed), true);
  assert.equal(report.transport, 'injected-transport'); assert.equal(report.realInferenceValidated, false);
  assert.equal(report.estimatedPeakUsd, undefined); assert.equal(JSON.stringify(report).includes('OFFLINE_SECRET'), false);
});
test('demo remote opt-in, model, key and revision are all required before dispatch', async () => {
  let calls = 0;
  for (const name of Object.keys(env)) {
    const configured = { ...env }; delete configured[name];
    const report = await runDeepSeekShadowExample(configured, { fetch: async () => { calls++; throw new Error('must not call'); } });
    assert.equal(report.status, 'failed'); assert.equal(report.requests, 0); assert.equal(report.realInferenceValidated, false);
  }
  assert.equal(calls, 0);
});
test('demo transport failure is redacted and never retried', async () => {
  let calls = 0;
  const report = await runDeepSeekShadowExample(env, { fetch: async () => { calls++; throw new Error('PRIVATE TRANSPORT'); } });
  assert.equal(calls, 1); assert.equal(report.status, 'failed'); assert.equal(report.realInferenceValidated, false);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});
test('default demo/help/unknown CLI arguments do not start the example', async () => {
  for (const args of [[], ['--help'], ['--execute', '--extra']]) {
    let output = ''; const code = await main(args, { write: text => { output += text; } }, env);
    assert.equal(code, args.length > 1 ? 1 : 0); assert.match(output, /Usage:/); assert.doesNotMatch(output, /OFFLINE_SECRET/);
  }
});
test('explicit local DeepSeek factory stays shadow and preserves bound capabilities', async () => {
  const root = realpathSync(tmpdir()), dir = mkdtempSync(join(root, 'reflexmesh-provider-factory-'));
  const fetch = globalThis.fetch; let kernel, calls = 0;
  try {
    const path = join(dir, 'state.sqlite');
    assert.throws(() => openLocalBoundary({ ...env, REFLEXMESH_ALLOW_REMOTE: 'false', REFLEXMESH_PROVIDER: 'deepseek', REFLEXMESH_DB: path }), /ALLOW_REMOTE/);
    assert.equal(existsSync(path), false);
    globalThis.fetch = async (...args) => { calls++; return fixture(...args); };
    const opened = openLocalBoundary({ ...env, REFLEXMESH_PROVIDER: 'deepseek', REFLEXMESH_DB: path }); kernel = opened.kernel;
    const call = { schemaVersion: 1, harness: 'codex', sessionId: 'synthetic', agentId: 'root', callId: 'synthetic', toolName: 'Read', arguments: { fixture: 'synthetic' } };
    const result = await opened.boundary.before(call, 'Read the synthetic fixture only.');
    assert.equal(result.mode, 'shadow'); assert.equal(result.control, 'abstain'); assert.equal(calls, 1);
    const stored = opened.boundary.inspect(call);
    assert.equal(stored.evidence.binding.providerId, 'deepseek/binary-json-estimate-v1');
    assert.equal(stored.evidence.providerCapabilities.probabilitySemantics, 'elicited-estimate');
    assert.match(stored.evidence.binding.capabilitiesDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(stored).includes('OFFLINE_SECRET'), false);
  } finally {
    globalThis.fetch = fetch; kernel?.close(); const target = realpathSync(dir);
    assert.equal(dirname(target), root); assert.ok(basename(target).startsWith('reflexmesh-provider-factory-'));
    rmSync(target, { recursive: true, force: true });
  }
});
