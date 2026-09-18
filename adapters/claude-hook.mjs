#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromClaudeHook } from '../dist/index.js';
import { oneJson } from './stdio.mjs';
import { openLocalBoundary } from './local-config.mjs';

export async function observeClaude(payload, boundary) {
  const event = fromClaudeHook(payload);
  if (event.phase === 'before') await boundary.before(event.call);
  else await boundary.after(event.call, event.status, event.evidence, 'harness-reported');
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
