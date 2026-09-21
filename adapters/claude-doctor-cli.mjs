#!/usr/bin/env node
import { CLAUDE_DOCTOR_USAGE, diagnoseClaudeDoctor, formatClaudeDoctor,
  internalClaudeDoctorFailure } from './claude-doctor.mjs';
import { isDirectRun } from './direct-run.mjs';

export async function claudeDoctorMain(argv = process.argv.slice(2), output = process.stdout) {
  let result;
  try { result = await diagnoseClaudeDoctor(argv); }
  catch { result = { exitCode: 1, report: internalClaudeDoctorFailure() }; }
  if (result.help) { output.write(CLAUDE_DOCTOR_USAGE); return 0; }
  output.write(argv.includes('--json') ? `${JSON.stringify(result.report)}\n` : formatClaudeDoctor(result.report));
  return result.exitCode;
}

if (isDirectRun(import.meta.url)) process.exitCode = await claudeDoctorMain();
