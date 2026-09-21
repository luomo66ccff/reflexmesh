#!/usr/bin/env node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DeepSeekEstimateProvider, toolPreflightPack, canonical } from '../dist/index.js';
import { DurableMesh, eventKey, replayPolicy } from '../adapters/durable-mesh.mjs';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

const PREFIX = 'reflexmesh-deepseek-example-';
const row = (name, passed) => ({ name, passed: passed === true });
const REQUEST = Object.freeze({ userIntent: 'Read the fixed synthetic fixture only; do not modify it.' });
const ACTION = Object.freeze({ toolId: 'synthetic_read', args: Object.freeze({ fixture: 'PRIVATE_SYNTHETIC_ARGUMENT_FOR_READ_ONLY_DEMO' }) });

/** Only synthetic data; one guarded model request. No credential/profile discovery or tool execution. */
export async function runDeepSeekShadowExample(env = process.env, { fetch: injectedFetch } = {}) {
  const fetch = injectedFetch ?? globalThis.fetch.bind(globalThis);
  const report = { schemaVersion: 1, status: 'failed', reason: 'explicit_remote_configuration_required',
    inputKind: 'synthetic-only', realInferenceValidated: false, maxRequests: 1, maxOutputTokens: 512, requests: 0, httpStatuses: [],
    probabilitySemantics: 'elicited-estimate', calibrated: false, hostToolsExecuted: 0, labelsCreated: 0,
    transport: injectedFetch ? 'injected-transport' : 'official-api', assertions: [] };
  if (env.REFLEXMESH_ALLOW_REMOTE !== 'true' || !env.DEEPSEEK_MODEL || !env.DEEPSEEK_API_KEY || !env.REFLEXMESH_PROVIDER_REVISION?.trim()) return report;
  let directory, kernel, rejected = false, responses = 0;
  const root = realpathSync(tmpdir());
  try {
    const provider = new DeepSeekEstimateProvider({ apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL,
      fetch: async (url, init) => {
        let body;
        try { body = JSON.parse(init?.body); } catch { rejected = true; throw new Error('Request guard rejected'); }
        const user = body.messages?.[1];
        const expected = { state: { untrustedState: REQUEST, proposedAction: ACTION, registeredEffect: 'read' }, questions: toolPreflightPack.questions };
        if (report.requests !== 0 || url !== 'https://api.deepseek.com/chat/completions' || init?.method !== 'POST' || init.redirect !== 'error'
          || Buffer.byteLength(init.body) > 8000 || body.model !== env.DEEPSEEK_MODEL || body.max_tokens !== 512
          || body.stream !== false || body.thinking?.type !== 'disabled' || body.response_format?.type !== 'json_object'
          || Object.hasOwn(body, 'tools') || body.messages?.length !== 2 || body.messages[0]?.role !== 'system'
          || user?.role !== 'user' || user.content !== JSON.stringify(expected)) { rejected = true; throw new Error('Request guard rejected'); }
        report.requests++;
        const response = await fetch(url, init); // Forward the actual response unchanged; no fixture substitution here.
        report.httpStatuses.push(response.status);
        if (response.ok) responses++;
        return response;
      } });
    directory = mkdtempSync(join(root, PREFIX));
    const path = join(directory, 'ledger.sqlite');
    const binding = { providerId: provider.id, modelId: provider.model, revision: env.REFLEXMESH_PROVIDER_REVISION,
      authorizationRevision: 'synthetic-shadow-no-execution', toolsetRevision: 'synthetic-memory-only-v1', calibrationRef: null };
    let toolCalls = 0;
    const tool = { id: 'synthetic_read', effect: 'read', idempotent: true, speculatable: false,
      execute: async () => { toolCalls++; return 'synthetic'; } };
    const open = () => {
      kernel = new SqliteKernel(path);
      return new DurableMesh({ kernel, provider, binding, mode: 'shadow', decisionTimeoutMs: 15000, leaseMs: 20000 })
        .registerPack(toolPreflightPack).registerTool(tool);
    };
    const event = { id: randomUUID(), type: 'tool.requested', source: 'reflexmesh:deepseek-example', tenantId: 'synthetic-example', time: new Date().toISOString(), state: REQUEST };
    const options = { packId: toolPreflightPack.id, action: ACTION };
    const first = await open().run(event, options);
    if (!first.provider) { report.reason = 'provider_assessment_unavailable'; return report; }
    const key = eventKey(event), stored = kernel.inspect(key), publicEvidence = kernel.evidenceSnapshot(key);
    kernel.close(); kernel = null;
    const mesh = open(), replayed = await mesh.run({ ...event, time: new Date().toISOString() }, options);
    const replay = replayPolicy(kernel.inspect(key), toolPreflightPack);
    const unsupported = { id: 'unsupported-choice', version: '1', eventType: 'synthetic.choice',
      questions: { q: { type: 'choice', instructions: 'Choose a synthetic label.', criteria: { yes: 'yes', no: 'no' } } }, rules: [], fallback: 'escalate' };
    mesh.registerPack(unsupported);
    const refusal = await mesh.run({ ...event, id: randomUUID(), type: 'synthetic.choice' }, { packId: unsupported.id });
    const usage = first.provider.usage;
    report.assertions = [
      row('one_bounded_successful_transport_request', report.requests === 1 && responses === 1 && !rejected),
      row('explicit_model_and_estimate_provider', first.provider.model === provider.model && provider.id === 'deepseek/binary-json-estimate-v1'),
      row('exact_binary_answer_set', Object.keys(first.provider.answers).sort().join(',') === Object.keys(toolPreflightPack.questions).sort().join(',')
        && Object.values(first.provider.answers).every(answer => answer.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1)),
      row('capability_digest_bound_to_persisted_evidence', stored.evidence.binding.capabilitiesDigest === digest(provider.capabilities)),
      row('public_evidence_preserves_estimate_semantics', publicEvidence.providerCapabilities.probabilitySemantics === 'elicited-estimate'),
      row('same_identity_replays_after_reopen_without_another_request', replayed.replayed === true && canonical(replayed.provider) === canonical(first.provider) && report.requests === 1),
      row('unsupported_choice_refuses_before_egress', refusal.verdict.effect === 'escalate' && refusal.provider === undefined && report.requests === 1),
      row('policy_replay_is_non_executing', replay.hypothetical === true && replay.executionAllowed === false && report.requests === 1),
      row('shadow_did_not_execute_registered_tool_or_create_labels', first.status === 'shadow' && toolCalls === 0 && stored.labels.length === 0 && stored.observations.length === 0),
      row('usage_received_and_bounded', Number.isSafeInteger(usage?.inputTokens) && usage.inputTokens >= 0 && usage.inputTokens <= 10000
        && Number.isSafeInteger(usage?.outputTokens) && usage.outputTokens >= 0 && usage.outputTokens <= 512),
      row('ledger_omits_synthetic_task_and_raw_arguments', !JSON.stringify(stored).includes(REQUEST.userIntent) && !JSON.stringify(stored).includes(ACTION.args.fixture)),
    ];
    report.status = report.assertions.every(item => item.passed) ? 'passed' : 'failed';
    report.reason = report.status === 'passed' ? 'independent_provider_shadow_roundtrip' : 'verification_failed';
    report.realInferenceValidated = report.status === 'passed' && responses === 1 && !injectedFetch;
    report.model = provider.model; report.providerId = provider.id; report.verdict = first.verdict.effect;
    report.capabilitiesDigest = stored.evidence.binding.capabilitiesDigest; report.usage = usage;
    if (usage && provider.model === 'deepseek-flash' && !injectedFetch) {
      report.estimatedPeakUsd = (usage.inputTokens * 0.3 + usage.outputTokens * 1.2) / 1000000;
      report.costBasis = 'deepseek-flash published peak token rates checked 2026-09-22; estimate, not invoice';
    }
  } catch { report.reason = 'bounded_example_failed'; }
  finally {
    try {
      kernel?.close();
      if (directory) { const target = realpathSync(directory);
        if (dirname(target) !== root || !basename(target).startsWith(PREFIX)) throw new Error('Unsafe cleanup');
        rmSync(target, { recursive: true, force: true }); }
    } catch { report.status = 'failed'; report.reason = 'temporary_cleanup_failed'; }
  }
  return report;
}

export async function main(argv = process.argv.slice(2), output = process.stdout, env = process.env) {
  if (argv.length !== 1 || argv[0] !== '--execute') {
    output.write('Usage: npm run demo:deepseek -- --execute\nOne paid, bounded model request using synthetic data; no tools or labels.\nRequires explicit REFLEXMESH_ALLOW_REMOTE=true, DEEPSEEK_API_KEY, DEEPSEEK_MODEL, REFLEXMESH_PROVIDER_REVISION.\nNo profile or credential discovery. Inspect the guide before enabling remote transfer.\n');
    return argv.length === 0 || argv.length === 1 && ['--help', '-h'].includes(argv[0]) ? 0 : 1;
  }
  const report = await runDeepSeekShadowExample(env); output.write(JSON.stringify(report) + '\n'); return report.status === 'passed' ? 0 : 1;
}
if (isDirectRun(import.meta.url)) process.exitCode = await main();
