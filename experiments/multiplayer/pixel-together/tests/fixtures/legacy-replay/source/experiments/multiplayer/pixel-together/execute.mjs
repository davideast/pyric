// Executes the saved experiment graph. Dependencies are supplied by the capture runner.
import { writeFile } from 'node:fs/promises';
import { runExperiment, assessRun, workload, rules } from './scenarios/harness.mjs';
const directory = process.argv[2];
if (!directory) throw new Error('An evidence output directory is required');
const result = await runExperiment();
const assessment = assessRun(result);
for (const [name, value] of Object.entries({ 'result.json': result, 'assessment.json': assessment, 'workload.json': workload })) {
  await writeFile(`${directory}/${name}`, JSON.stringify(value, null, 2) + '\n');
}
await writeFile(`${directory}/firestore.rules`, rules);
const findings = result.assertions.map(a => {
  const expectedFailure = assessment.expectedNegativeControls.includes(`${a.caseId}: ${a.name}`);
  const outcome = a.passed ? (expectedFailure ? 'UNEXPECTED PASS' : 'PASS') : (expectedFailure ? 'EXPECTED FAILURE' : 'FAIL');
  return `| ${a.caseId} | ${a.name} | ${outcome} |`;
}).join('\n');
await writeFile(`${directory}/findings.md`, `# Captured outcomes\n\nEvidence about this synthetic architecture, not the Kin UI or production.\n\n| Case | Invariant | Outcome |\n| --- | --- | --- |\n${findings}\n\nExpected negative controls: ${assessment.expectedNegativeControls.join('; ')}.\n\n${result.run.limits.map(limit => `- ${limit}`).join('\n')}\n`);
