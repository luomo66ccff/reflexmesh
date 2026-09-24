#!/usr/bin/env node
import { ContractError } from '../dist/index.js';
import { compareEvaluations } from './evaluation-report.mjs';
import { evaluationDatasetDigest, validateEvaluationDataset, validateEvaluationLabels } from './evaluation-contract.mjs';
import { readEvaluationJson, reserveEvaluationOutput } from './evaluation-files.mjs';
import { planEvaluation } from './evaluation-plan.mjs';
import { isDirectRun } from './direct-run.mjs';

const USAGE = `ReflexMesh evaluation: paired evidence, not automatic model promotion
  npm run evaluation -- validate --dataset FILE [--labels FILE] [--json]
  npm run evaluation -- plan --dataset FILE --provider deepseek|jev --max-requests N [--json]
  npm run evaluation -- run --dataset FILE --deployment-id ID --id RUN_ID --out NEW_FILE --max-requests N --allow-remote [--expect-plan-digest SHA256] [--timeout-ms 15000] [--max-output-tokens N]
  npm run evaluation -- compare --dataset FILE --labels FILE --champion FILE --challenger FILE [--bins 10] [--json] [--out NEW_FILE]
Validate/plan/compare are local only. Plan checks declared capabilities, not model quality, endpoint availability or cost.
Run requires explicit provider/model/revision/key and REFLEXMESH_ALLOW_REMOTE=true.
Run never reads labels, loads a host profile or executes tools. Each case keeps its full question contract.
Outputs must be new files. Interrupted/failed remote requests are never retried automatically.
Comparison uses only the same labeled cases where both sides succeeded; missing/failure coverage stays visible.
Labels and provider origins are operator declarations, not verified provenance. Synthetic demos are not model-quality evidence.
`;
const fail = text => { throw new ContractError(text); };
export function parseEvaluationOptions(argv) {
  if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const [command, ...args] = argv;
  const allowed = { validate: ['dataset', 'labels', 'json'],
    plan: ['dataset', 'provider', 'max-requests', 'json'],
    run: ['dataset', 'deployment-id', 'id', 'out', 'max-requests', 'allow-remote', 'expect-plan-digest', 'timeout-ms', 'max-output-tokens'],
    compare: ['dataset', 'labels', 'champion', 'challenger', 'bins', 'json', 'out'] }[command];
  if (!allowed) fail('Expected validate, plan, run or compare; use --help');
  const options = { command };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!allowed.includes(key) || Object.hasOwn(options, key)) fail('Unknown or duplicate evaluation option');
    if (['json', 'allow-remote'].includes(key)) options[key] = true;
    else { const value = args[++i]; if (!value || value.startsWith('--')) fail('Missing evaluation option value'); options[key] = value; }
  }
  const required = { validate: ['dataset'], plan: ['dataset', 'provider', 'max-requests'],
    run: ['dataset', 'deployment-id', 'id', 'out', 'max-requests', 'allow-remote'],
    compare: ['dataset', 'labels', 'champion', 'challenger'] }[command];
  if (required.some(key => !Object.hasOwn(options, key))) fail('Missing required evaluation option; use --help');
  for (const [key, max] of [['max-requests', 1000], ['timeout-ms', 120000], ['max-output-tokens', 4096], ['bins', 100]]) {
    if (options[key] !== undefined) {
      if (!/^[0-9]+$/.test(options[key]) || Number(options[key]) < 1 || Number(options[key]) > max) fail('Invalid evaluation budget or bin count');
      options[key] = Number(options[key]);
    }
  }
  if (options['expect-plan-digest'] !== undefined && !/^[a-f0-9]{64}$/.test(options['expect-plan-digest']))
    fail('Invalid evaluation plan digest');
  return options;
}
const quote = value => JSON.stringify(value);
const counts = values => Object.entries(values).map(([name, count]) => `${name}=${count}`).join(', ');
const metricText = metrics => metrics === null ? 'no estimate' : Object.entries(metrics)
  .filter(([, value]) => typeof value === 'number').map(([key, value]) => `${key}=${Number(value.toFixed(6))}`).join(', ');
export function formatEvaluationReport(report) {
  const lines = ['ReflexMesh paired comparison — descriptive only; no automatic promotion',
    `Dataset ${quote(report.dataset.id)} @ ${quote(report.dataset.revision)}: ${report.dataset.caseCount} cases (${report.dataset.dataKind})`,
    'Label independence is operator-asserted, not verified. Available subsets are not compared directly.'];
  for (const side of ['champion', 'challenger']) {
    const value = report.sides[side];
    lines.push(`${side}: ${quote(value.deploymentId)} / ${quote(value.providerId)} / ${quote(value.modelId)} @ ${quote(value.revision)}; ${value.probabilitySemantics}; origin=${value.origin}`);
  }
  if (report.dataset.dataKind === 'synthetic' || Object.values(report.sides).some(side => side.probabilitySemantics === 'synthetic-fixture' || side.origin === 'synthetic-fixture'))
    lines.push('SYNTHETIC evidence is present. This is not a measured real-world model-quality claim.');
  for (const question of report.questions) {
    lines.push(`\n${quote(question.questionId)} (${question.type}): labeled ${question.labeledCases}/${question.totalCases}; paired ${question.paired.count}/${question.labeledCases}`);
    lines.push(`  champion coverage: ${counts(question.coverage.champion.all)}`,
      `  challenger coverage: ${counts(question.coverage.challenger.all)}`,
      `  labeled classes: ${quote(question.labelDistribution.all.byClass)}; paired classes: ${quote(question.labelDistribution.paired.byClass)}`,
      `  available champion (different population; no direct delta): ${metricText(question.availableSubset.champion.metrics)}`,
      `  available challenger (different population; no direct delta): ${metricText(question.availableSubset.challenger.metrics)}`,
      `  paired champion: ${metricText(question.paired.champion)}`,
      `  paired challenger: ${metricText(question.paired.challenger)}`,
      `  delta (challenger - champion): ${metricText(question.paired.delta)}`);
  }
  lines.push(`\nPolicy disagreements: ${report.policy.disagreementCount}/${report.policy.bothOkCount} both-successful cases (may include unlabeled cases).`,
    'Policy transitions are not false-allow/false-deny rates. No tool, permission, threshold or deployment change is made.');
  return lines.join('\n') + '\n';
}

export async function evaluationMain(argv, output = process.stdout, { env = process.env, createProvider, signal } = {}) {
  const options = parseEvaluationOptions(argv);
  if (options.help) { output.write(USAGE); return 0; }
  const dataset = validateEvaluationDataset(readEvaluationJson(options.dataset));
  if (options.command === 'validate') {
    const labels = options.labels ? validateEvaluationLabels(readEvaluationJson(options.labels), dataset) : null;
    const result = { valid: true, datasetDigest: evaluationDatasetDigest(dataset), cases: dataset.cases.length,
      questions: Object.keys(dataset.pack.questions).length, labels: labels?.labels.length ?? null, labelIndependenceVerified: false };
    output.write(options.json ? JSON.stringify(result) + '\n' : `Valid dataset: ${result.cases} cases, ${result.questions} questions; labels=${result.labels ?? 'not supplied'}.\nDataset digest: ${result.datasetDigest}\nIndependent label provenance is an operator assertion, not authenticated.\n`);
    return 0;
  }
  if (options.command === 'plan') {
    const plan = planEvaluation({ dataset, provider: options.provider, maxRequests: options['max-requests'] });
    output.write(options.json ? JSON.stringify(plan) + '\n'
      : `Offline evaluation plan: ${plan.dataset.cases} cases, ${plan.dataset.questions} questions; provider=${plan.provider}.\n`
        + `Compatible=${plan.eligibleCases}, unsupported=${plan.unsupportedCases}; at most ${plan.requestUpperBound} requests under cap ${plan.maxRequests}.\n`
        + `Deferred by cap if requests succeed=${plan.deferredByRequestCapIfNoFailure}; selected canonical state+question bytes=${plan.selectedCanonicalInputBytes}.\n`
        + `Dataset digest: ${plan.dataset.digest}\nPlan guard: ${plan.guardDigest}\nNo key, label, host profile or network was accessed. This is not a wire-size, model-quality or cost guarantee.\n`);
    return 0;
  }
  if (options.command === 'compare') {
    const report = compareEvaluations({ dataset, labels: readEvaluationJson(options.labels), champion: readEvaluationJson(options.champion),
      challenger: readEvaluationJson(options.challenger), binCount: options.bins ?? 10 });
    if (options.out) { const file = reserveEvaluationOutput(options.out); try { file.finish(report); } finally { file.close(); } }
    output.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatEvaluationReport(report));
    return 0;
  }
  // The three local branches above do not construct providers or read credentials.
  // An optional reviewed plan guard fails before provider/key access or output reservation.
  if (options['expect-plan-digest'] !== undefined) {
    const current = planEvaluation({ dataset, provider: env.REFLEXMESH_PROVIDER,
      maxRequests: options['max-requests'] });
    if (current.guardDigest !== options['expect-plan-digest'])
      throw new ContractError('Evaluation plan mismatch; no provider or output opened');
  }
  const factory = createProvider ?? (await import('./evaluation-provider.mjs')).createEvaluationProvider;
  const selected = await factory(env, { maxOutputTokens: options['max-output-tokens'] });
  const file = reserveEvaluationOutput(options.out);
  try {
    const { runEvaluation } = await import('./evaluation-runner.mjs');
    const result = await runEvaluation({ dataset, ...selected, deploymentId: options['deployment-id'], id: options.id,
      maxRequests: options['max-requests'], timeoutMs: options['timeout-ms'] ?? 15000, signal });
    file.finish(result);
    const statuses = Object.fromEntries(['ok', 'unsupported', 'failed', 'not_attempted'].map(status => [status, result.rows.filter(row => row.status === status).length]));
    output.write(JSON.stringify({ persisted: true, id: result.id, datasetDigest: result.datasetDigest,
      deploymentId: result.deployment.id, statuses, automaticRetryAllowed: false, toolsExecuted: 0 }) + '\n');
    return statuses.failed ? 2 : 0;
  } finally { file.close(); }
}
if (isDirectRun(import.meta.url)) {
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try { process.exitCode = await evaluationMain(process.argv.slice(2), process.stdout, { signal: controller.signal }); }
  catch (error) { process.stderr.write(`ReflexMesh evaluation: ${error instanceof ContractError ? error.message : 'operation failed; do not automatically repeat remote requests'}.\n`); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', interrupt); if (controller.signal.aborted) process.exitCode = 130; }
}
