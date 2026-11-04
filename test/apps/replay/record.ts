/**
 * Records a run against a real Firebase test project as a recorded-exchange
 * file. This is the one harness entry point that reaches Google, so no test
 * or scenario calls it: a person runs it by hand, once per recording, against
 * a test project that holds test data only.
 *
 *   bun test/apps/replay/record.ts --project <test-project> --out <file.json> <run.ts>
 *
 * `run.ts` default-exports `(sdk: Sdk) => Promise<void>`: the app code to
 * record, using the SDK `loadSdk` returns (Firestore's browser build). It
 * calls `initializeApp` with the test project's web config itself; the
 * recorder never sees or stores a credential beyond what that run sends, and
 * the file it writes holds placeholders in place of every token.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { startRecorder } from './recorder.ts';
import { routeFirebaseTo } from './seam.ts';
import { loadSdk, type Sdk } from './sdk.ts';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { project: { type: 'string' }, out: { type: 'string' } },
  allowPositionals: true,
});
const [runPath] = positionals;
if (!values.project || !values.out || !runPath) {
  console.error('usage: bun test/apps/replay/record.ts --project <test-project> --out <file.json> <run.ts>');
  process.exit(2);
}

const recorder = await startRecorder({ project: values.project, source: `recorded from test project ${values.project} by test/apps/replay/record.ts` });
console.log(`recording ${runPath} against the real Firebase project ${values.project}`);
routeFirebaseTo(recorder.origin);
const sdk = await loadSdk();
const run = (await import(pathToFileURL(resolve(runPath)).href) as { default: (sdk: Sdk) => Promise<void> }).default;
try {
  await run(sdk);
} finally {
  for (const app of sdk.app.getApps()) await sdk.app.deleteApp(app);
}
const recording = await recorder.stop();
writeFileSync(values.out, `${JSON.stringify(recording, null, 2)}\n`);
console.log(`wrote ${recording.exchanges.length} exchanges to ${values.out}`);
process.exit(0);
