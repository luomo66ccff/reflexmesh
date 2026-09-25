import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ContractError } from '../dist/index.js';

const MAX_STORY_BYTES = 128 * 1024;
const escapeHtml = value => String(value ?? 'Not recorded').replace(/[&<>"']/gu, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const display = value => value === null || value === undefined || value === '' ? 'Not recorded' : escapeHtml(value);
const item = (label, value) => `<div class="fact"><dt>${label}</dt><dd>${display(value)}</dd></div>`;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Render only the bounded evidenceSnapshot projection, never a raw ledger row or transcript. */
export function renderEvidenceStory(snapshot, { synthetic = false } = {}) {
  if (!snapshot || snapshot.metadataCoverage !== 'bounded-projection' || typeof snapshot.key !== 'string'
    || !snapshot.run || !snapshot.decision || !snapshot.hostOutcome || !snapshot.taskEvidence
    || !snapshot.recovery || !Array.isArray(snapshot.hostOutcome.byProvenance)
    || !Array.isArray(snapshot.notes)) throw new ContractError('A bounded evidence snapshot is required');
  const { run, taskEvidence: task, decision, hostOutcome: host, recovery } = snapshot;
  const outcomeTone = ['missing', 'unknown', 'conflicting', 'unrecognized'].includes(host.status) ? 'caution' : 'neutral';
  const needsAttention = recovery.required || outcomeTone === 'caution' || ['blocked', 'pending'].includes(host.hookPairing?.state);
  const stateText = recovery.required
    ? 'Execution uncertain · do not retry'
    : needsAttention ? 'Needs independent review' : 'Evidence recorded · not authorization';
  const sources = host.byProvenance.length ? host.byProvenance.map(group =>
    `<li><span>${display(group.provenance)}</span><strong>${display(group.status)}</strong><small>${count(group.count)} report${count(group.count) === 1 ? '' : 's'}</small></li>`).join('')
    : '<li class="empty">No host outcome has been recorded.</li>';
  const notes = snapshot.notes.length ? snapshot.notes.map(note => `<li>${display(note)}</li>`).join('')
    : '<li>No additional projection notes.</li>';
  const archive = snapshot.auditHistory?.archived ? '<p class="archive">Some audit rows are archived. External archive availability has not been checked.</p>' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Evidence story · ReflexMesh</title>
<style>
:root{color-scheme:light;--ink:#14202b;--muted:#52616c;--line:#c7d6d5;--paper:#f5f6ef;--surface:#fffefa;--teal:#0b645d;--orange:#a44021;--gold:#f1cf80;font-family:Arial,Helvetica,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);line-height:1.5}main{max-width:1120px;margin:auto;padding:32px 24px 80px}.eyebrow{font-size:.75rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--teal)}h1{font-family:Georgia,serif;font-size:clamp(2.7rem,7vw,5.8rem);line-height:1.02;letter-spacing:-.05em;margin:12px 0 18px}h2{font-family:Georgia,serif;font-size:1.8rem;line-height:1.12;margin:0 0 14px}h3{font-size:1.05rem;margin:0 0 12px}p{margin:0 0 14px}.lead{font-size:1.15rem;max-width:68ch;color:var(--muted)}.mast{border-bottom:2px solid var(--ink);display:flex;justify-content:space-between;gap:16px;padding-bottom:12px;font-size:.8rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.hero{padding:48px 0 32px}.status{display:inline-block;border:1px solid var(--teal);color:var(--teal);padding:7px 12px;border-radius:100px;font-weight:800;font-size:.8rem}.status.caution{border-color:var(--orange);color:var(--orange)}.synthetic{background:#e4f2eb;border-left:5px solid var(--teal);padding:18px 20px;margin:8px 0 28px}.rail{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:24px 0 36px}.rail div{background:var(--ink);color:#fff;padding:18px;min-height:116px}.rail span{display:block;color:#a8cac6;font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.rail strong{display:block;font-size:1.2rem;margin-top:12px;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:18px}.card{background:var(--surface);border:1px solid var(--line);padding:26px;box-shadow:4px 4px 0 #dce7e0}.card.wide{grid-column:1/-1}.number{color:var(--teal);font-weight:800;font-size:.78rem;letter-spacing:.12em}.sub{color:var(--muted);max-width:65ch}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:20px 0 0}.fact{border-top:1px solid var(--line);padding-top:8px;min-width:0}.fact dt{font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:800}.fact dd{margin:4px 0 0;font-weight:700;overflow-wrap:anywhere}.callout{background:#fff2df;border-left:5px solid var(--orange);padding:14px 16px;margin-top:18px;color:#63301e}.source-list,.notes{padding-left:0;list-style:none;margin:18px 0 0}.source-list li{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;border-top:1px solid var(--line);padding:12px 0;overflow-wrap:anywhere}.source-list small{color:var(--muted)}.notes li{border-top:1px solid var(--line);padding:10px 0}.archive{color:var(--orange);font-weight:700}.key{font-family:Consolas,monospace;overflow-wrap:anywhere;background:#e7eeeb;padding:10px 12px}.footer{border-top:2px solid var(--ink);margin-top:42px;padding-top:20px;color:var(--muted);font-size:.9rem}@media(max-width:760px){main{padding:20px 16px 50px}.mast{flex-wrap:wrap}.hero{padding-top:36px}.rail{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{display:block}.card{margin-bottom:16px;padding:20px}.facts{grid-template-columns:1fr}}@media(max-width:420px){.rail{grid-template-columns:1fr 1fr}.rail div{min-height:100px;padding:12px}.rail strong{font-size:1rem}.source-list li{grid-template-columns:1fr 1fr}.source-list small{grid-column:1/-1}}@media print{body{background:#fff}.card{box-shadow:none}main{padding:0}.rail div{print-color-adjust:exact}}
</style>
</head>
<body>
<main>
<header class="mast"><span>ReflexMesh / local evidence</span><span>Bounded projection · offline report</span></header>
<section class="hero" aria-labelledby="page-title"><p class="eyebrow">A decision is not an execution</p><h1 id="page-title">Evidence story.</h1><p class="lead">Follow one call from task evidence to semantic decision, then to separately reported host observations. This page cannot authorize, retry, or verify a host action.</p><span class="status${needsAttention ? ' caution' : ''}">${stateText}</span></section>
${synthetic ? '<aside class="synthetic"><strong>Synthetic lesson.</strong> This page uses fixture predictions and a test-oracle report. No real model, host tool, user profile, or external provider ran.</aside>' : ''}
<div class="rail" aria-label="Evidence at a glance"><div><span>Task evidence</span><strong>${display(task.recordedStatus)}</strong></div><div><span>Semantic decision</span><strong>${display(decision.effect)}</strong></div><div><span>Host report</span><strong>${display(host.status)}</strong></div><div><span>Independent labels</span><strong>${count(snapshot.labelCount)}</strong></div></div>
<div class="grid">
<section class="card wide" aria-labelledby="identity"><span class="number">01 / identity</span><h2 id="identity">The recorded call</h2><p class="sub">This identifier selects one ledger projection. It is not a retry token.</p><p class="key">${escapeHtml(snapshot.key)}</p><dl class="facts">${item('Run state', run.state)}${item('Mode', run.mode)}${item('Result status', run.resultStatus)}${item('Pack', snapshot.pack?.id)}${item('Pack version', snapshot.pack?.version)}${item('Provider', snapshot.binding?.providerId)}${item('Model', snapshot.binding?.modelId)}${item('Provider semantics', snapshot.providerCapabilities?.probabilitySemantics)}</dl></section>
<section class="card" aria-labelledby="task"><span class="number">02 / before decision</span><h2 id="task">Task evidence</h2><p class="sub">Coverage describes what was recorded at decision time, not full authorization or current freshness.</p><dl class="facts">${item('Recorded status', task.recordedStatus)}${item('Coverage', task.coverage)}${item('Source', task.source)}${item('Freshness', task.recordedFreshness)}</dl></section>
<section class="card" aria-labelledby="decision"><span class="number">03 / policy</span><h2 id="decision">Semantic decision</h2><p class="sub">${display(decision.explanation)}</p><dl class="facts">${item('Effect', decision.effect)}${item('Rule', decision.ruleId)}${item('Reason', decision.reasonCode)}${item('Provider result', decision.providerResultRecorded ? 'Recorded' : 'Not recorded')}</dl><p class="callout">A shadow allow is not host permission. The host retains authority over its tools.</p></section>
<section class="card" aria-labelledby="outcome"><span class="number">04 / after decision</span><h2 id="outcome">Host observations</h2><p class="sub">Reports are observations, not independently verified truth or calibration labels.</p><dl class="facts">${item('Aggregate status', host.status)}${item('Report count', count(host.count))}${item('Hook pairing', host.hookPairing?.state)}${item('Pairing reason', host.hookPairing?.reasonCode)}</dl><ul class="source-list">${sources}</ul></section>
<section class="card" aria-labelledby="recovery"><span class="number">05 / what remains open</span><h2 id="recovery">Labels &amp; recovery</h2><p class="sub">Independent labels are a separate evidence stream. An operator conclusion does not turn an UNKNOWN execution into a replayable success.</p><dl class="facts">${item('Independent labels', count(snapshot.labelCount))}${item('Recovery required', recovery.required ? 'Yes' : 'No')}${item('Operator conclusion', recovery.resolution)}${item('Execution allowed here', 'No')}</dl>${recovery.required ? '<p class="callout">Execution is unknown. Reconcile externally; do not retry under this call identity.</p>' : ''}</section>
<section class="card wide" aria-labelledby="limits"><span class="number">06 / reading guide</span><h2 id="limits">Limits of this view</h2><ul class="notes">${notes}</ul>${archive}<p class="sub">This static report contains bounded local metadata, not a transcript, raw task text, tool output, full audit body, or proof of real-world effects.</p></section>
</div><footer class="footer">Generated locally from one read-only evidence projection. No scripts, external assets, network requests, provider calls, or permission changes are part of this page. Keep the exported file private: metadata and identifiers can still be sensitive.</footer>
</main>
</body>
</html>
`;
}

export async function writeEvidenceStory(outputPath, snapshot, options = {}) {
  if (!snapshot) throw new ContractError('Unknown evidence key');
  if (typeof outputPath !== 'string' || !outputPath || outputPath.length > 1024
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(outputPath))
    throw new ContractError('A new --out FILE path is required');
  const bytes = Buffer.from(renderEvidenceStory(snapshot, options), 'utf8');
  if (bytes.length < 1 || bytes.length > MAX_STORY_BYTES) throw new ContractError('Evidence story exceeds the export size limit');
  const path = resolve(outputPath);
  let file, created = false;
  try {
    file = await open(path, 'wx+', 0o600);
    created = true;
    await file.writeFile(bytes);
    await file.sync();
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== bytes.length) throw new Error('Write size mismatch');
    const readback = Buffer.alloc(bytes.length);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(readback, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== bytes.length || !readback.equals(bytes)) throw new Error('Write readback mismatch');
    return { kind: 'evidence_story', sourceKey: snapshot.key, outputPath: path,
      bytesWritten: bytes.length, executionAllowed: false };
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ContractError('Destination already exists; choose a new file');
    if (created) throw new ContractError('Evidence story write could not be verified; inspect the new file before continuing');
    throw new ContractError('Evidence story destination is unavailable; check the parent directory');
  } finally {
    try { await file?.close(); }
    catch { throw new ContractError('Evidence story close could not be verified; inspect the new file before continuing'); }
  }
}

export function formatEvidenceStory(receipt) {
  return ['ReflexMesh offline evidence story created from one bounded ledger projection.',
    `New private file: ${JSON.stringify(receipt.outputPath)}`,
    `Source key: ${JSON.stringify(receipt.sourceKey)}`,
    'Open it locally in a browser. No script, external asset, provider, tool, host permission or ledger record was changed.',
    'Reported outcomes are not truth labels; this view never authorizes a retry. Keep metadata private.',
  ].join('\n') + '\n';
}
