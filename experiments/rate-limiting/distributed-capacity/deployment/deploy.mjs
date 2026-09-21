// Run only after explicit Cloud Run deployment approval. No automatic redeploys.
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCloudRun } from './prepare.mjs';

const [deployerFile = join(homedir(), 'Documents/digame-mas-65fca8fd3136.json'), runtimeFile = join(homedir(), 'Documents/digame-mas.json')] = process.argv.slice(2);
const identity = JSON.parse(await readFile(resolve(deployerFile), 'utf8'));
const runtime = JSON.parse(await readFile(resolve(runtimeFile), 'utf8'));
for (const account of [identity, runtime]) if (account.type !== 'service_account' || account.project_id !== 'digame-mas') throw new Error('Expected digame-mas service accounts');
const project = 'digame-mas', region = 'us-east4', service = 'capacity-recovery', databaseId = 'allowance-experiments';
const runId = `capacity-${randomUUID()}`;
const configuration = join(tmpdir(), 'capacity-cloudrun-gcloud');
await mkdir(configuration, { recursive: true, mode: 0o700 });
const env = { ...process.env, CLOUDSDK_CONFIG: configuration, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: resolve(deployerFile) };
const common = [`--project=${project}`, '--quiet'];
const command = args => execFileSync('gcloud', [...args, ...common], { env, stdio: 'inherit' });
const json = (args, credential = resolve(deployerFile)) => JSON.parse(execFileSync('gcloud', [...args, ...common, '--format=json'], {
    env: { ...env, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: credential }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
const publicBindings = policy => policy.bindings?.some(binding => binding.members?.some(member => ['allUsers', 'allAuthenticatedUsers'].includes(member)));
const database = json(['firestore', 'databases', 'describe', `--database=${databaseId}`], resolve(runtimeFile));
if (database.locationId !== region || database.type !== 'FIRESTORE_NATIVE' || database.databaseEdition !== 'STANDARD' || database.concurrencyMode !== 'PESSIMISTIC') throw new Error('Unexpected experiment database metadata');
const existing = json(['run', 'services', 'list', `--region=${region}`, `--filter=metadata.name=${service}`]);
if (existing.length) {
    if (existing[0].metadata?.labels?.purpose !== 'distributed-capacity-experiment') throw new Error('Refusing to replace an unrelated service');
    if (publicBindings(json(['run', 'services', 'get-iam-policy', service, `--region=${region}`]))) throw new Error('Refusing public service');
}
// Add a dedicated route to the existing evidence bucket; preserve prior sinks.
const sinkName = `pyric-${service}`;
const filter = `(resource.type="cloud_run_revision" AND resource.labels.service_name="${service}" AND resource.labels.location="${region}") OR (protoPayload.serviceName="firestore.googleapis.com")`;
const destination = `logging.googleapis.com/projects/${project}/locations/global/buckets/pyric-experiments`;
const sinks = json(['logging', 'sinks', 'list']);
const sink = sinks.find(row => row.name === sinkName);
if (sink && (sink.destination !== destination || sink.filter !== filter || sink.disabled)) throw new Error('Existing experiment log sink differs; review it before deployment');
if (!sink) command(['logging', 'sinks', 'create', sinkName, destination, `--log-filter=${filter}`, '--description=Pyric distributed capacity experiment evidence']);
const prepared = await prepareCloudRun();
const directory = fileURLToPath(new URL(`./records/${runId}/`, import.meta.url));
await mkdir(directory, { recursive: true });
await cp(prepared.directory, join(directory, 'source'), { recursive: true });
const report = { formatVersion: 1, status: 'prepared', project, region, service, runId,
    sourceHash: prepared.sourceHash, sourceFiles: prepared.files, deployerIdentity: identity.client_email, runtimeIdentity: runtime.client_email,
    database: { name: database.name, locationId: database.locationId, concurrencyMode: database.concurrencyMode },
    inference: 'durable fixture; no real model calls', authentication: 'IAM required',
    resources: { minInstances: 0, maxInstances: 3, concurrency: 8, cpu: 1, memory: '512Mi', timeoutSeconds: 30 },
    logSink: { name: sinkName, destination, filter }, workloadRun: 'not run', functionalSmoke: { status: 'pending' } };
const save = () => writeFile(join(directory, 'deployment-report.json'), JSON.stringify(report, null, 2) + '\n');
await save(); console.log(JSON.stringify({ stage: 'prepared', directory, service, runId }));
try {
    command(['run', 'deploy', service, `--region=${region}`, `--source=${join(directory, 'source')}`,
        `--service-account=${runtime.client_email}`, `--build-service-account=projects/${project}/serviceAccounts/${identity.client_email}`,
        '--invoker-iam-check', '--min=0', '--min-instances=0', '--scaling=auto', '--max=3', '--max-instances=3',
        '--cpu=1', '--memory=512Mi', '--concurrency=8', '--timeout=30s', '--cpu-throttling',
        '--labels=purpose=distributed-capacity-experiment',
        `--set-env-vars=GOOGLE_CLOUD_PROJECT=${project},CAPACITY_DATABASE=${databaseId},CAPACITY_RUN_ID=${runId}`]);
    const deployed = json(['run', 'services', 'describe', service, `--region=${region}`]);
    const iam = json(['run', 'services', 'get-iam-policy', service, `--region=${region}`]);
    if (publicBindings(iam) || deployed.metadata?.annotations?.['run.googleapis.com/invoker-iam-disabled'] === 'true') throw new Error('Private invocation verification failed');
    const revision = json(['run', 'revisions', 'describe', deployed.status.latestReadyRevisionName, `--region=${region}`]);
    Object.assign(report, { status: 'deployed', url: deployed.status.url, revision: deployed.status.latestReadyRevisionName,
        imageDigest: revision.status?.imageDigest ?? null, deployedAt: new Date().toISOString() });
    await save();
    const target = new URL(report.url);
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.run.app')) throw new Error('Unexpected Cloud Run URL');
    const unauthenticated = await fetch(`${report.url}/health`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (![401, 403].includes(unauthenticated.status)) throw new Error('Unauthenticated invocation was not denied');
    const token = execFileSync('gcloud', ['auth', 'print-identity-token', `--audiences=${report.url}`, ...common], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    const headers = { Authorization: `Bearer ${token}` };
    const health = await fetch(`${report.url}/health`, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!health.ok) throw new Error(`Authenticated health check failed: ${health.status}`);
    const metadata = await health.json();
    if (metadata.runId !== runId || metadata.sourceHash !== report.sourceHash || metadata.revision !== report.revision) throw new Error('Deployment provenance mismatch');
    await writeFile(join(directory, 'health.json'), JSON.stringify(metadata, null, 2) + '\n');
    const traceId = randomUUID().replaceAll('-', ''), requestId = 'deployment-smoke';
    const startedAt = new Date().toISOString(), path = '/cases/deployment-smoke/commands';
    const response = await fetch(report.url + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...headers, 'Content-Type': 'application/json', 'X-Cloud-Trace-Context': `${traceId}/1;o=1` },
        body: JSON.stringify({ operation: 'smoke', uid: 'alice', requestId }) });
    const outcome = await response.json();
    report.functionalSmoke = { status: response.status === 200 && outcome.result?.record?.state === 'completed' ? 'passed' : 'failed',
        unauthenticatedStatus: unauthenticated.status, healthStatus: health.status, commandStatus: response.status,
        startedAt, endedAt: new Date().toISOString(), traceId, requestId, path, outcome };
    await save();
    if (report.functionalSmoke.status !== 'passed') throw new Error('Firestore smoke failed; deployment retained for diagnosis');
    console.log(JSON.stringify({ directory, ...report }, null, 2));
} catch (error) {
    Object.assign(report, { failure: String(error.message).slice(0, 500), finishedAt: new Date().toISOString() });
    await save(); throw error;
}
