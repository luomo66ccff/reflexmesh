import assert from 'node:assert/strict';
import test from 'node:test';
import { SUPPORTED_CLAUDE_VERSIONS, supportedClaudeVersion } from '../scripts/claude-probe-version.mjs';

test('Claude probes accept only exact individually validated host revisions', () => {
  assert.deepEqual(SUPPORTED_CLAUDE_VERSIONS, ['2.1.263', '2.1.280']);
  assert.equal(supportedClaudeVersion('2.1.263 (Claude Code)\n'), '2.1.263');
  assert.equal(supportedClaudeVersion('2.1.280 (Claude Code)\r\n'), '2.1.280');
  for (const label of ['2.1.279 (Claude Code)', '2.1.281 (Claude Code)', '2.1.280',
    '2.1.280 (Other CLI)', '2.1.280 (Claude Code)\nextra', null]) {
    assert.equal(supportedClaudeVersion(label), null);
  }
});
