#!/usr/bin/env node
import { diagnoseDoctor, DOCTOR_USAGE, formatDoctor, internalDoctorFailure } from './doctor.mjs';
import { isDirectRun } from './direct-run.mjs';

export async function doctorMain(argv = process.argv.slice(2), output = process.stdout) {
  let result;
  try { result = await diagnoseDoctor(argv); }
  catch { result = { exitCode: 1, report: internalDoctorFailure() }; }
  if (result.help) { output.write(DOCTOR_USAGE); return 0; }
  output.write(argv.includes('--json') ? `${JSON.stringify(result.report)}\n` : formatDoctor(result.report));
  return result.exitCode;
}

if (isDirectRun(import.meta.url)) process.exitCode = await doctorMain();
