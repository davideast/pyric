import { httpSuite } from '../scenarios/http-suites.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessRun } from '../analysis/assess.mjs';
import { summarize, findings } from '../analysis/summarize.mjs';
import { implementationHash, digest } from '../capture-definition.mjs';
import { scenarios } from './runner.mjs';
import policies from '../fixtures/policies.json' with { type: 'json' };
import workload from '../fixtures/workloads.json' with { type: 'json' };
import { recordRunObservability } from '../../../shared/observability/run-report.mjs';
import observabilityManifest from '../observability.json' with { type: 'json' };
export async function writeArtifacts(output, result) {
    try { await readFile(join(output, 'observability-report.json')); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await recordRunObservability(output, { backend: result.run.environment.backend,
            project: result.run.environment.projectId, database: result.run.environment.databaseId, manifest: observabilityManifest });
    }
    const rules = readFileSync(new URL('../deployment/firestore.rules', import.meta.url), 'utf8');
    Object.assign(result.run, { implementationHash: implementationHash(), workloadHash: digest(JSON.stringify({ workload: result.run.workload, policies: result.run.policies, cases: result.run.selectedCases })), rulesHash: digest(rules), gitRevision: process.env.PYRIC_EXPERIMENT_REVISION ?? null });
    const json = (file, value) => writeFile(join(output, file), JSON.stringify(value, null, 2) + '\n');
    await Promise.all([json('result.json', result), json('assessment.json', assessRun(result)), json('summary.json', summarize(result)), json('environment.json', result.run.environment), json('workload.json', { workload: result.run.workload, policies: result.run.policies, cases: result.run.selectedCases }), writeFile(join(output, 'firestore.rules'), rules), writeFile(join(output, 'findings.md'), findings(result))]);
}
export async function recoverArtifacts(output, input) {
    const limits = input.limits ?? { maxRequests: 500 };
    const isHttp = ['http-overload', 'provider-lifecycle'].includes(input.suite);
    let registry = scenarios, httpDefinition;
    if (isHttp) ({ scenarios: registry, workload: httpDefinition } = httpSuite(input.suite));
    const selectedCases = input.cases ?? Object.keys(registry);
    let environment = { backend: input.profile === 'firestore-comparison' ? 'firestore-admin' : 'pyric', verified: false };
    try {
        environment = JSON.parse(await readFile(join(output, 'environment.json'), 'utf8'));
    }
    catch { }
    let raw = '';
    try {
        raw = await readFile(join(output, 'events.ndjson'), 'utf8');
    }
    catch {
        await writeFile(join(output, 'events.ndjson'), '');
    }
    const events = [];
    let unreadableLines = 0;
    for (const line of raw.split('\n').filter(Boolean)) {
        try {
            events.push(JSON.parse(line));
        }
        catch {
            unreadableLines++;
        }
    }
    const result = { schemaVersion: 2, run: { id: process.env.PYRIC_EXPERIMENT_RUN_ID, startedAt: null, finishedAt: new Date().toISOString(), environment, ...(isHttp ? { suite: input.suite } : {}), workload: isHttp ? { ...httpDefinition, limits, scenarios: Object.fromEntries(selectedCases.map(id => [id, registry[id]])) } : { ...workload, limits }, limits, policies, selectedCases },
        execution: { status: 'incomplete', reason: 'Child process failed or exceeded execution deadline; native commits may have completed without acknowledgement.', unreadableEventLines: unreadableLines },
        cases: selectedCases.map(id => ({ id, status: 'incomplete' })), assertions: [], events,
        requests: events.filter(e => ['request-start', 'request-response'].includes(e.kind)), transactions: events.filter(e => e.kind.startsWith('transaction-')),
        admissions: events.filter(e => e.kind === 'admission-decision'), inferences: events.filter(e => e.kind === 'inference-dispatch'), observations: events.filter(e => ['outstanding', 'arrival', 'contention-observation', 'request-budget-exhausted'].includes(e.kind)) };
    await writeArtifacts(output, result);
}
