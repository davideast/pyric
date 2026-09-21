import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { validateConfig, caseIds } from './config.mjs';
import { connectTarget, prepareIdentity } from './target.mjs';
import { runLiveCases } from './workload.mjs';
import { assessLive } from './assess.mjs';
import { digest, implementationHash } from './capture-definition.mjs';
import { providerCapabilities } from '../fixtures/capabilities.mjs';
import { contractProfile } from '../fixtures/contract-profile.mjs';
const [out, mode] = process.argv.slice(2);
const config = validateConfig(JSON.parse(await readFile(join(out, 'input.json'), 'utf8')));
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
const rules = await readFile(new URL('../architecture/firestore.rules', import.meta.url), 'utf8');
const workload = { schemaVersion: 1, cases: caseIds, config, repetitions: 1, retries: 0, oracle: null,
    prompt: { kind: 'synthetic-integer-list', revision: 1 }, clock: 'controller process monotonic; no cross-process subtraction' };
const environment = { backend: 'firestore-admin', production: true, projectId: config.projectId, databaseId: config.databaseId,
    model: config.model, provider: 'Firebase AI Logic GoogleAI v1beta', transport: 'local-controller-direct-http', runtime: process.versions.node,
    sdkVersion: createRequire(import.meta.url)('firebase-admin').SDK_VERSION, clientRulesEnforced: false, remoteOracleAvailable: false, cloudRun: false };
const metadata = { id: process.env.PYRIC_EXPERIMENT_RUN_ID, selectedCases: caseIds, workloadVersion: 1, fixtureVersion: 'no-provider-oracle-live-v1', workloadHash: digest(JSON.stringify(workload)),
    implementationHash: implementationHash(), policyHash: digest(await readFile(new URL('./budget.mjs', import.meta.url))), rulesHash: digest(rules), environment };
let result = { schemaVersion: 1, run: metadata, cases: [], events: [], finalBudget: null };
if (mode === '--recover') {
    try { result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8')); } catch {}
    try { result.events = (await readFile(join(out, 'events.ndjson'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
    result.run = { ...metadata, interrupted: true };
} else {
    await save('result.json', result); await writeFile(join(out, 'events.ndjson'), '');
    let target, identity; let phase = 'authorization';
    try {
        if (process.env.PYRIC_PROVIDER_REAL_RUN !== '1' || process.env.PYRIC_EXPERIMENT_REPLAY === '1') throw new Error('live-execution-not-authorized');
        phase = 'target-preflight'; target = await connectTarget(config, { credentials: process.env.PYRIC_PROVIDER_CREDENTIALS, firebaseConfigPath: process.env.PYRIC_PROVIDER_FIREBASE_CONFIG });
        environment.locationId = target.environment.locationId; environment.concurrencyMode = target.environment.concurrencyMode;
        phase = 'identity'; identity = await prepareIdentity(config, { authCredentials: process.env.PYRIC_PROVIDER_AUTH_CREDENTIALS, apiKey: target.apiKey, runId: metadata.id });
        phase = 'workload'; const completed = await runLiveCases({ config, db: target.db, runId: metadata.id, apiKey: target.apiKey, credentials: identity.credentials, allowRealInference: true,
            journal: event => appendFileSync(join(out, 'events.ndjson'), JSON.stringify(event) + '\n'),
            checkpoint: partial => { result = { ...result, ...partial }; writeFileSync(join(out, 'result.json'), JSON.stringify(result)); } });
        result = { ...completed, run: { ...completed.run, ...metadata } };
    } catch (error) {
        try { result.events = (await readFile(join(out, 'events.ndjson'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
        result.failureDetail = { phase, httpStatus: error.status ?? null, code: /^[a-zA-Z0-9/_-]{1,100}$/.test(error.code ?? '') ? error.code : 'request-failed' };
        result.run = { ...metadata, interrupted: true }; result.failure = 'Live execution did not complete; inspect retained observations and prerequisites without retrying dispatch';
    } finally {
        try { await identity?.close(); result.identityCleanup = identity ? 'deleted' : 'not-created-or-cleaned-on-error'; } catch { result.identityCleanup = 'failed'; }
        try { await target?.close(); } catch { result.connectionCleanup = 'failed'; }
    }
}
await save('result.json', result); await save('assessment.json', assessLive(result)); await save('workload.json', workload); await save('environment.json', environment);
await save('snapshots.json', result.cases.map(c => ({ caseId: c.caseId, snapshots: c.snapshots ?? null })));
await save('capabilities.json', { ...providerCapabilities, model: config.model, liveTested: (result.cases ?? []).some(c => c.dispatches > 0), observationScope: environment.transport });
await save('contract-profile.json', { ...contractProfile, liveValidated: assessLive(result).successfulExperiment, sourceRunId: metadata.id });
await writeFile(join(out, 'firestore.rules'), rules);
await writeFile(join(out, 'attempts.ndjson'), result.events.filter(e => ['provider-observation', 'case-failure', 'case-settled'].includes(e.kind)).map(e => JSON.stringify(e)).join('\n') + '\n');
await writeFile(join(out, 'findings.md'), '# Live provider contract\n\n' + (assessLive(result).successfulExperiment ? 'All selected observations matched the bounded workload.' : 'Incomplete or inconclusive observations; see assessment.json.') + '\n\nNo provider-side oracle exists in this run. Local abort is not proof of remote termination. Unknown reservations remain in the dedicated Firestore database. This used direct HTTP from a local controller, not Cloud Run or a browser. Live replay is disabled.\n');
