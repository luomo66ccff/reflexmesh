#!/usr/bin/env node
import { CODEX_DOCTOR_USAGE, diagnoseCodexDoctor, formatCodexDoctor,
  internalCodexDoctorFailure } from './codex-doctor.mjs';
import { isDirectRun } from './direct-run.mjs';

export async function codexDoctorMain(argv = process.argv.slice(2), output = process.stdout) {
  let result;
  try { result = await diagnoseCodexDoctor(argv); }
  catch { result = { exitCode: 1, report: internalCodexDoctorFailure() }; }
  if (result.help) { output.write(CODEX_DOCTOR_USAGE); return 0; }
  output.write(Array.isArray(argv) && argv.includes('--json')
    ? `${JSON.stringify(result.report)}\n` : formatCodexDoctor(result.report));
  return result.exitCode;
}

if (isDirectRun(import.meta.url)) process.exitCode = await codexDoctorMain();
