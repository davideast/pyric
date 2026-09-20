// One fake inference request to validate workload log export; no deployment,
// configuration mutation, real inference, or full experiment workload.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { captureDefinition } from '../capture-definition.mjs';
import { captureMeasurementLogs } from './capture-logs.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const [deploymentDirectory, credentials] = process.argv.slice(2);
if (!deploymentDirectory || !credentials) throw new Error('Usage: node deployment/run-log-smoke.mjs DEPLOYMENT_RECORD COLLECTOR_KEY');
const deployment = await json(join(resolve(deploymentDirectory), 'deployment-report.json'));
if (deployment.project !== 'digame-mas' || deployment.service !== 'allowance-overload' || deployment.workload !== 'execution' || deployment.database.name !== 'projects/digame-mas/databases/allowance-experiments' || deployment.url !== 'https://allowance-overload-77eiz5rbyq-uk.a.run.app') throw new Error('Unexpected smoke target');
const id = randomUUID(), traceId = randomUUID().replaceAll('-', '');
const out = join(here, 'measurements', id);
await mkdir(out, { recursive: true });
for (const path of captureDefinition().sourcePaths) {
    await mkdir(dirname(join(out, 'source', path)), { recursive: true });
    await cp(join(root, path), join(out, 'source', path));
}
await cp(join(resolve(deploymentDirectory), 'source'), join(out, 'server-source'), { recursive: true });
await save(join(out, 'deployment-report.json'), deployment);
const startedAt = new Date().toISOString();
const result = { schemaVersion: 2, run: { id, suite: 'workload-log-capture-smoke', startedAt, deploymentRunId: deployment.runId }, events: [], assertions: [] };
const persist = () => save(join(out, 'result.json'), result);
await persist();
console.log(JSON.stringify({ stage: 'smoke-starting', directory: out }));
try {
    const env = { ...process.env, CLOUDSDK_CONFIG: join(tmpdir(), 'allowance-cloudrun-gcloud'), CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: resolve(credentials) };
    const token = execFileSync('gcloud', ['auth', 'print-identity-token', `--audiences=${deployment.url}`, '--project=digame-mas'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    const headers = { Authorization: `Bearer ${token}` };
    const healthResponse = await fetch(deployment.url + '/health', { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!healthResponse.ok) throw new Error('Private health check failed');
    const health = await healthResponse.json();
    if (health.runId !== deployment.runId || health.revision !== deployment.revision || health.sourceHash !== deployment.sourceHash || health.inference !== 'fake-lifecycle' || health.requestsObserved >= health.requestCeilingPerInstance) throw new Error('Service provenance or request budget mismatch');
    await save(join(out, 'environment.json'), health);
    const provenance = await json(join(out, 'server-source/deployment-provenance.json'));
    for (const [path, hash] of Object.entries(provenance.files)) if (sha(await readFile(join(out, 'server-source', path))) !== hash) throw new Error('Deployed source mismatch');
    if (sha(JSON.stringify(provenance.files)) !== deployment.sourceHash) throw new Error('Deployed provenance mismatch');
    const requestPath = '/cases/execution-user-guard/infer/chat';
    const requestId = `log-smoke-${id}`;
    result.events.push({ kind: 'client-dispatch', caseId: 'execution-user-guard', requestId, traceId, requestPath, uid: 'eve', timestamp: new Date().toISOString() });
    await persist();
    const response = await fetch(deployment.url + requestPath, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Experiment-User': 'eve', 'X-Cloud-Trace-Context': traceId + '/1;o=1' },
        body: JSON.stringify({ requestId, model: 'test-model', prompt: 'synthetic log capture smoke' }), redirect: 'error', signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    result.events.push({ kind: 'client-response', caseId: 'execution-user-guard', requestId, httpStatus: response.status, status: body.status });
    result.assertions.push({ name: 'fake inference completes', passed: response.status === 200 && body.status === 'completed', actual: body.status, expected: 'completed' });
    // Wait for server work to settle, not merely for the HTTP response.
    const drain = await fetch(deployment.url + '/cases/execution-user-guard/drain', { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!drain.ok) throw new Error('Drain failed');
    if (!result.assertions.every(check => check.passed)) process.exitCode = 1;
} catch {
    Object.assign(result.run, { error: 'Smoke workload failed; inspect recorded response and deployment provenance' });
    process.exitCode = 1;
} finally {
    Object.assign(result.run, { finishedAt: new Date().toISOString() });
    await persist();
    await save(join(out, 'log-window.json'), { startedAt, endedAt: result.run.finishedAt });
    const capture = await captureMeasurementLogs(out, resolve(credentials));
    if (capture.collectionStatus !== 'collected' || capture.coverage.status !== 'observed') process.exitCode = 1;
    const files = [];
    async function visit(path, prefix = '') {
        for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const relative = prefix + entry.name;
            if (entry.isDirectory()) await visit(join(path, entry.name), relative + '/');
            else { const bytes = await readFile(join(path, entry.name)); files.push({ path: relative, sha256: sha(bytes), bytes: bytes.length }); }
        }
    }
    await visit(out);
    await save(join(out, 'manifest.json'), { formatVersion: 1, captureKind: 'workload-log-export-smoke', credentialsBundled: false,
        status: process.exitCode ? 'incomplete-or-failed' : 'complete', sourceCapture: 'client source copied before execution; deployed source hash verified against private health', files });
    console.log(JSON.stringify({ directory: out, collectionStatus: capture.collectionStatus, coverage: capture.coverage, assertions: result.assertions }));
}
