import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareCloudRun } from './prepare-cloudrun.mjs';

const credentialPath = resolve(process.argv[2] ?? join(homedir(), 'Documents/digame-mas.json'));
const runtimeCredentialPath = resolve(process.argv[3] ?? credentialPath);
const runtimeIdentity = JSON.parse(await readFile(runtimeCredentialPath, 'utf8'));
if (runtimeIdentity.type !== 'service_account' || runtimeIdentity.project_id !== 'digame-mas') throw new Error('Expected a digame-mas runtime identity');
const identity = JSON.parse(await readFile(credentialPath, 'utf8'));
if (identity.type !== 'service_account' || identity.project_id !== 'digame-mas') throw new Error('Expected the digame-mas service account');
const execution = process.argv.includes('--execution');
const project = 'digame-mas', region = 'us-east4', service = 'allowance-overload';
const prepared = await prepareCloudRun();
const runId = `cloudrun-${randomUUID()}`;
const configuration = join(tmpdir(), 'allowance-cloudrun-gcloud');
await mkdir(configuration, { recursive: true, mode: 0o700 });
const env = { ...process.env, CLOUDSDK_CONFIG: configuration, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: credentialPath };
const common = [`--project=${project}`, '--quiet'];
const gcloudJson = (args, targetEnv = env) => JSON.parse(execFileSync('gcloud', [...args, ...common, '--format=json'], { env: targetEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
console.log(JSON.stringify({ stage: 'prepared', ...prepared, project, region, service, runId, deployerIdentity: identity.client_email, runtimeIdentity: runtimeIdentity.client_email }, null, 2));
const database = gcloudJson(['firestore', 'databases', 'describe', '--database=allowance-experiments'], { ...env, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: runtimeCredentialPath });
if (database.locationId !== region || database.type !== 'FIRESTORE_NATIVE' || database.databaseEdition !== 'STANDARD' || database.concurrencyMode !== 'PESSIMISTIC') throw new Error('Unexpected experiment database metadata');
const existing = gcloudJson(['run', 'services', 'list', `--region=${region}`, `--filter=metadata.name=${service}`]);
if (existing.length) {
    const iam = gcloudJson(['run', 'services', 'get-iam-policy', service, `--region=${region}`]);
    if (iam.bindings?.some(binding => binding.members?.some(member => ['allUsers', 'allAuthenticatedUsers'].includes(member)))) throw new Error('Refusing to reuse a publicly accessible service');
}
execFileSync('gcloud', ['run', 'deploy', service, ...common, `--region=${region}`, `--source=${prepared.directory}`,
    `--service-account=${runtimeIdentity.client_email}`,
    `--build-service-account=projects/${project}/serviceAccounts/${identity.client_email}`,
    '--invoker-iam-check', '--min=0', '--min-instances=0', '--scaling=auto', '--max=1', '--max-instances=1',
    '--cpu=1', '--memory=512Mi', '--concurrency=80', '--timeout=10s', '--no-cpu-throttling',
    '--labels=purpose=allowance-experiment',
    `--set-env-vars=GOOGLE_CLOUD_PROJECT=${project},ALLOWANCE_DATABASE=allowance-experiments,ALLOWANCE_RUN_ID=${runId},ALLOWANCE_WORKLOAD=${execution ? 'execution' : 'admission'}`,
], { env, stdio: 'inherit' });
execFileSync('gcloud', ['run', 'services', 'update-traffic', service, ...common, `--region=${region}`, '--to-latest'], { env, stdio: 'inherit' });
const deployed = gcloudJson(['run', 'services', 'describe', service, `--region=${region}`]);
const iam = gcloudJson(['run', 'services', 'get-iam-policy', service, `--region=${region}`]);
if (iam.bindings?.some(binding => binding.members?.some(member => ['allUsers', 'allAuthenticatedUsers'].includes(member)))) throw new Error('Deployment access verification failed');
const revision = gcloudJson(['run', 'revisions', 'describe', deployed.status.latestReadyRevisionName, `--region=${region}`]);
const report = { ...prepared, runId, project, region, service, url: deployed.status?.url,
    revision: deployed.status?.latestReadyRevisionName, sourceHash: prepared.sourceHash,
    database: { name: database.name, locationId: database.locationId, concurrencyMode: database.concurrencyMode },
    workload: execution ? 'execution' : 'admission', inference: 'fake', authentication: 'IAM required', functionalSmoke: 'pending', imageDigest: revision.status?.imageDigest ?? null };
await writeFile(join(prepared.directory, 'deployment-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

const unauthenticated = await fetch(`${report.url}/health`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
if (![401, 403].includes(unauthenticated.status)) throw new Error('Unauthenticated invocation was not denied');
const identityToken = execFileSync('gcloud', ['auth', 'print-identity-token', `--audiences=${report.url}`, ...common], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const health = await fetch(`${report.url}/health`, { headers: { Authorization: `Bearer ${identityToken}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
if (!health.ok) throw new Error(`Authenticated health check failed: ${health.status}`);
const metadata = await health.json();
if (metadata.runId !== runId || metadata.sourceHash !== report.sourceHash || metadata.revision !== report.revision) throw new Error('Service URL does not serve the expected deployment');
let inferencePath = '/infer/chat';
let smokeActor = 'alice';
if (execution) { inferencePath = '/cases/execution-user-guard/infer/chat'; smokeActor = 'dave'; }
const inference = await fetch(`${report.url}${inferencePath}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${identityToken}`, 'Content-Type': 'application/json', 'X-Experiment-User': smokeActor },
    body: JSON.stringify({ requestId: 'deployment-smoke', model: 'test-model', prompt: 'synthetic deployment smoke' }) });
const outcome = await inference.json();
report.functionalSmoke = { unauthenticatedStatus: unauthenticated.status, healthStatus: health.status, inferenceStatus: inference.status, inferenceOutcome: outcome.status };
await writeFile(join(prepared.directory, 'deployment-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (inference.status !== 200 || outcome.status !== 'completed') throw new Error('Deployment exists but Firestore admission smoke did not complete; inspect its structured logs');
