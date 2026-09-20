import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runHttpExperiment } from './harness/http-runner.mjs';
import { runExperiment } from './harness/runner.mjs';
import { writeArtifacts, recoverArtifacts } from './harness/artifacts.mjs';
import { environment } from './adapters/pyric-store.mjs';
import { recordRunObservability } from '../../shared/observability/run-report.mjs';
import observabilityManifest from './observability.json' with { type: 'json' };
const output = process.argv[2];
let input = {};
try {
    input = JSON.parse(await readFile(join(output, 'input.json'), 'utf8'));
}
catch (e) {
    if (e.code !== 'ENOENT')
        throw e;
}
if (process.argv.includes('--recover')) {
    await recoverArtifacts(output, input);
    process.exit(0);
}
await writeFile(join(output, 'events.ndjson'), '');
await recordRunObservability(output, {
    backend: input.profile === 'firestore-comparison' ? 'firestore' : 'local',
    project: input.projectId, database: input.databaseId,
    reportFile: process.env.PYRIC_OBSERVABILITY_REPORT,
    requirePreflight: process.env.PYRIC_REQUIRE_OBSERVABILITY_PREFLIGHT === '1', manifest: observabilityManifest,
});
await writeFile(join(output, 'environment.json'), JSON.stringify(input.profile === 'firestore-comparison' ? { backend: 'firestore-admin', verified: false } : environment));
if (input.suite && !['http-overload', 'provider-lifecycle'].includes(input.suite))
    throw new Error('Unknown suite');
if (input.suite && input.profile !== 'local')
    throw new Error('HTTP overload currently supports local Pyric only');
let driver;
if (input.profile && input.profile !== 'local') {
    if (input.profile !== 'firestore-comparison' || process.env.PYRIC_ALLOWANCE_PRODUCTION !== 'explicit')
        throw new Error('Production execution requires explicit opt-in; production replay is disabled');
    const { firestoreFactory } = await import('./adapters/firestore-admin.mjs');
    driver = await firestoreFactory(input);
}
if (driver)
    await writeFile(join(output, 'environment.json'), JSON.stringify(driver.environment));
let pending = Promise.resolve();
const result = await (input.suite ? runHttpExperiment : runExperiment)({ suite: input.suite, storeFactory: driver?.createStore, backendEnvironment: driver?.environment, cases: input.cases, limits: input.limits, runId: process.env.PYRIC_EXPERIMENT_RUN_ID, onEvent: event => { pending = pending.then(() => appendFile(join(output, 'events.ndjson'), JSON.stringify(event) + '\n')); } });
await pending;
if (driver)
    await driver.close();
await writeArtifacts(output, result);
