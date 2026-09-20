import { readFile } from 'node:fs/promises';
import { captureRun, verifyCapture } from '../../shared/evidence/capture.mjs';
import { compareRuns } from './scenarios/harness.mjs';

const [command, first, second] = process.argv.slice(2);
if (command === 'compare' && first && second) {
  const [left, right] = await Promise.all([first, second].map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const comparison = compareRuns(left, right);
  console.log(JSON.stringify(comparison, null, 2));
  if (!comparison.compatible) process.exitCode = 2;
} else if ((command === 'run' && first) || (command === 'replay' && first && second)) {
  const summary = await captureRun(command === 'run' ? first : second, command === 'replay' ? { sourceCapture: first } : {});
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.successfulExperiment) process.exitCode = 1;
} else if (command === 'verify' && first) {
  const verification = await verifyCapture(first);
  console.log(JSON.stringify(verification, null, 2));
  if (!verification.valid) process.exitCode = 1;
} else {
  console.error('Usage: bun experiments/multiplayer/pixel-together/run.mjs run <output-directory> | compare <left-result.json> <right-result.json> | verify <capture> | replay <capture> <output-directory>');
  process.exitCode = 2;
}
