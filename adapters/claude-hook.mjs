#!/usr/bin/env node
import { fromClaudeHook } from '../dist/index.js';
import { isDirectRun } from './direct-run.mjs';
import { oneJson } from './stdio.mjs';
import { openLocalBoundary } from './local-config.mjs';

export async function observeClaude(payload, boundary) {
  const event = fromClaudeHook(payload);
  if (event.phase === 'before') await boundary.beforeClaudeHook(event.call);
  else await boundary.afterClaudeHook(event.call, event.status, event.evidence);
  // Empty output abstains. A model score must NEVER emit permissionDecision: allow.
  return {};
}
export async function main(input = process.stdin, output = process.stdout, errors = process.stderr, env = process.env) {
  let kernel;
  try {
    const payload = await oneJson(input);
    fromClaudeHook(payload); // Validate before opening any local storage.
    const opened = openLocalBoundary(env); kernel = opened.kernel;
    await observeClaude(payload, opened.boundary);
  } catch { errors.write('ReflexMesh shadow observation unavailable; host policy unchanged.\n'); }
  finally { kernel?.close(); }
  output.write('{}\n'); // Shadow failures do not change the host's existing permissions or tool result.
}
if (isDirectRun(import.meta.url)) await main();
