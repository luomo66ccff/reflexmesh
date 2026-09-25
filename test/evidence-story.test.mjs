import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderEvidenceStory, writeEvidenceStory } from '../adapters/evidence-story.mjs';
import { parseEvidenceOptions } from '../adapters/evidence-cli.mjs';

const snapshot = () => ({
  metadataCoverage: 'bounded-projection', key: '<script>alert(1)</script>',
  run: { state: 'unknown', mode: 'shadow', resultStatus: 'recovery_required' },
  pack: { id: 'A & B', version: '1.0' }, binding: { providerId: 'mock', modelId: 'fixture' },
  providerCapabilities: { probabilitySemantics: 'synthetic-fixture' },
  taskEvidence: { recordedStatus: 'ready', coverage: 'summary-only', source: 'host-declared', recordedFreshness: 'unverified' },
  decision: { effect: 'allow', ruleId: 'x"><img src=x>', reasonCode: null,
    explanation: 'Host authorization remains separate.', providerResultRecorded: true },
  hostOutcome: { status: 'conflicting', count: 2, byProvenance: [
    { provenance: 'test-oracle', status: 'succeeded', count: 1 },
    { provenance: 'harness-reported', status: 'failed', count: 1 },
  ], hookPairing: { state: 'blocked', reasonCode: 'outcome_conflict' } },
  labelCount: 0, recovery: { required: true, resolution: 'confirmed_succeeded', executionAllowed: false },
  notes: ['Reported outcome ≠ independent truth.', 'No raw body: <private>'],
});

test('story renders bounded metadata with escaped values and honest UNKNOWN semantics', () => {
  const html = renderEvidenceStory(snapshot());
  assert.match(html, /Execution uncertain · do not retry/);
  assert.match(html, /A shadow allow is not host permission/);
  assert.match(html, /Operator conclusion/);
  assert.match(html, /confirmed_succeeded/);
  assert.match(html, /Host observations/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /x&quot;&gt;&lt;img src=x&gt;/);
  assert.match(html, /A &amp; B/);
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('https://'));
  assert.match(html, /Content-Security-Policy/);
  assert.throws(() => renderEvidenceStory({ ...snapshot(), metadataCoverage: 'raw-ledger' }), /bounded evidence snapshot/);
});

test('story export is new-only and validates before writing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-story-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, '离线 story.html');
  await assert.rejects(writeEvidenceStory(destination, null), /Unknown evidence key/);
  assert.equal(existsSync(destination), false);
  await assert.rejects(writeEvidenceStory(join(root, 'bad\nname'), snapshot()), /new --out FILE/);
  const receipt = await writeEvidenceStory(destination, snapshot());
  assert.equal(receipt.executionAllowed, false);
  assert.equal(receipt.kind, 'evidence_story');
  assert.equal(receipt.bytesWritten, Buffer.byteLength(readFileSync(destination, 'utf8')));
  const before = readFileSync(destination);
  await assert.rejects(writeEvidenceStory(destination, snapshot()), /Destination already exists/);
  assert.deepEqual(readFileSync(destination), before);
});

test('story CLI requires an explicit key and new output path', () => {
  assert.throws(() => parseEvidenceOptions(['story', '--db', 'x']), /--key/);
  assert.throws(() => parseEvidenceOptions(['story', '--db', 'x', '--key', 'y']), /--out/);
  assert.deepEqual(parseEvidenceOptions(['story', '--db', 'x', '--key', 'y', '--out', 'new.html']),
    { command: 'story', db: 'x', key: 'y', out: 'new.html' });
});
