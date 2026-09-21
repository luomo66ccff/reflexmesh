// A bounded metadata projection, never a transcript, tool-output or audit export.
const known = (value, allowed, fallback = null) => allowed.includes(value) ? value : fallback;
const label = value => typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;

export function evidenceView(row, now) {
  const groups = JSON.parse(row.outcome_groups);
  const statuses = [...new Set(groups.map(g => g.status))];
  const outcomeStatus = statuses.length === 0 ? 'missing' : statuses.length > 1 ? 'conflicting' : statuses[0];
  const expired = row.lease_until <= now;
  const recoveryRequired = row.state === 'unknown' || (row.state === 'executing' && expired);
  const taskStatus = known(row.task_status, ['ready','missing','expired','withheld','too_large','invalid'], 'not_recorded');
  const effect = known(row.effect, ['allow','deny','confirm','escalate']);
  const why = row.has_prediction !== 1 && !['ready','not_recorded'].includes(taskStatus)
    ? `Task evidence was ${taskStatus}; task-aware assessment had no usable summary.`
    : row.rule_id === 'provider_unavailable_or_invalid'
      ? 'No valid provider result was recorded: the provider or its evidence was unavailable or invalid.'
      : effect === 'allow' ? 'The semantic policy matched an allow rule; host authorization remains separate.'
        : effect === 'confirm' ? 'The semantic policy requests confirmation; no approval is inferred.'
          : effect === 'deny' ? 'The semantic policy rejected the proposed decision.'
            : effect === 'escalate' ? 'The semantic policy requires review or more evidence.'
              : 'No policy verdict is recorded.';
  const notes = [];
  if (row.mode === 'shadow') notes.push('Shadow observation does not grant, deny or execute a host action.');
  if (outcomeStatus === 'missing') notes.push('No host outcome is recorded; this does not prove that the action did not run.');
  else notes.push('Reported outcomes are observations, not independent truth or calibration labels.');
  if (outcomeStatus === 'conflicting') notes.push('Outcome observations disagree; no successful outcome is selected automatically.');
  if (recoveryRequired) notes.push('Execution is unknown and must not be retried under this call identity.');
  if (taskStatus !== 'not_recorded') notes.push('Task coverage describes the evidence at decision time, not current freshness or full user authorization.');
  return {
    key: row.key,
    run: { state: row.state, epoch: row.epoch, mode: known(row.mode, ['shadow','active']),
      resultStatus: known(row.result_status, ['shadow','blocked','assessed','succeeded','recovery_required','in_flight']) },
    inputDigest: hash(row.request_digest), actionDigest: hash(row.action_digest),
    pack: { id: label(row.pack_id), version: label(row.pack_version), digest: hash(row.pack_digest) },
    binding: { providerId: label(row.provider_id), modelId: label(row.model_id), revision: label(row.revision),
      authorizationRevision: label(row.authorization_revision), toolsetRevision: label(row.toolset_revision) },
    taskEvidence: { recordedStatus: taskStatus, coverage: known(row.task_coverage, ['none','summary-only']),
      source: known(row.task_source, ['claude-explicit-summary','host-declared','model-reported']),
      recordedFreshness: known(row.task_freshness, ['within_ttl','expired','unverified']), summaryDigest: hash(row.summary_digest) },
    decision: { effect, ruleId: label(row.rule_id), directive: label(row.directive), explanation: why,
      reasonCode: label(row.reason_code), providerResultRecorded: row.has_prediction === 1 },
    hostOutcome: { status: outcomeStatus, count: groups.reduce((n, g) => n + g.count, 0), byProvenance: groups },
    labelCount: row.label_count,
    recovery: { required: recoveryRequired, leaseExpired: expired,
      resolution: known(row.resolution, ['unresolved','confirmed_succeeded','confirmed_failed','confirmed_not_executed']),
      executionAllowed: false },
    metadataCoverage: 'bounded-projection', notes,
  };
}

// Paths/columns are fixed implementation constants, never interpolated user input.
const textField = (column, path, alias) => `CASE WHEN json_type(${column}, '${path}')='text'
  AND length(json_extract(${column}, '${path}'))<=256 THEN json_extract(${column}, '${path}') ELSE NULL END AS ${alias}`;
export function evidenceColumns(schemaVersion) {
  const fields = {
    mode: '$.mode', action_digest: '$.actionDigest', pack_id: '$.pack.id', pack_version: '$.pack.version', pack_digest: '$.pack.digest',
    provider_id: '$.binding.providerId', model_id: '$.binding.modelId', revision: '$.binding.revision',
    authorization_revision: '$.binding.authorizationRevision', toolset_revision: '$.binding.toolsetRevision',
    task_status: '$.taskEvidence.status', task_coverage: '$.taskEvidence.coverage', task_source: '$.taskEvidence.source',
    task_freshness: '$.taskEvidence.freshness', summary_digest: '$.taskEvidence.summaryDigest',
  };
  return [
    'substr(r.key,1,1025) AS key', 'r.state', 'r.epoch', 'substr(r.request_digest,1,65) AS request_digest', 'r.lease_until',
    ...Object.entries(fields).map(([alias, path]) => textField('r.evidence', path, alias)),
    ...Object.entries({ result_status: '$.status', effect: '$.verdict.effect', rule_id: '$.verdict.ruleId', directive: '$.verdict.directive', reason_code: '$.reasonCode' })
      .map(([alias, path]) => textField('r.result', path, alias)),
    "CASE WHEN json_type(r.result, '$.provider')='object' THEN 1 ELSE 0 END AS has_prediction",
    '(SELECT COUNT(*) FROM labels WHERE run_key=r.key) AS label_count',
    `(SELECT json_group_array(json_object('status', status, 'provenance', provenance, 'count', total)) FROM (
      SELECT CASE WHEN json_extract(body,'$.status') IN ('succeeded','failed','unknown') THEN json_extract(body,'$.status') ELSE 'unrecognized' END AS status,
      CASE WHEN json_extract(body,'$.provenance') IN ('harness-reported','model-reported','test-oracle') THEN json_extract(body,'$.provenance') ELSE 'unrecognized' END AS provenance,
      COUNT(*) AS total FROM observations WHERE run_key=r.key GROUP BY status, provenance ORDER BY status, provenance LIMIT 16
    )) AS outcome_groups`,
    schemaVersion >= 2 ? `(SELECT CASE WHEN json_extract(body,'$.resolution') IN ('unresolved','confirmed_succeeded','confirmed_failed','confirmed_not_executed')
      THEN json_extract(body,'$.resolution') ELSE NULL END FROM recovery_reviews WHERE run_key=r.key ORDER BY applied_epoch DESC LIMIT 1) AS resolution` : 'NULL AS resolution',
  ].join(',\n');
}
