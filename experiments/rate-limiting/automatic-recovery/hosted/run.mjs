// Run a bounded workload, never deploy. Use --local for the paired HTTP/Pyric run.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, cp, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runHostedWorkload } from './workload.mjs';
import { verifyDeployedSource, compareSources } from './evidence.mjs';
import { captureLogs } from '../../../shared/observability/log-capture.mjs';
import { googleApi } from '../../../shared/observability/google-api.mjs';

const args = process.argv.slice(2), local = args[0] === '--local';
if (!local && args.length !== 2) throw new Error('Usage: run.mjs DEPLOYMENT_RECORD CREDENTIALS | --local');

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const measurementId = randomUUID();
const out = join(repo, 'experiments/rate-limiting/automatic-recovery/hosted/results', measurementId);
await mkdir(out, { recursive: true });
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');

const paths = [
    'hosted/run.mjs',
    'hosted/workload.mjs',
    'hosted/evidence.mjs',
    'hosted/http-app.mjs',
    'hosted/provider.mjs',
    'architecture/recovery-claim.mjs',
    'architecture/reconcile.mjs',
    'fixtures/contracts.mjs',
].map(name => `experiments/rate-limiting/automatic-recovery/${name}`);
paths.push('experiments/rate-limiting/integrated-admission/architecture/admission.mjs');
paths.push('experiments/rate-limiting/integrated-admission/architecture/transitions.mjs');
paths.push('experiments/rate-limiting/integrated-admission/fixtures/policy.mjs');
paths.push('experiments/rate-limiting/inference-allowance/architecture/bucket.mjs');
paths.push('experiments/rate-limiting/inference-allowance/adapters/store.mjs');
paths.push(...['log-capture', 'log-scope', 'log-redaction', 'google-api'].map(name => `experiments/shared/observability/${name}.mjs`));

for (const path of paths) {
    await mkdir(dirname(join(out, 'source', path)), { recursive: true });
    await cp(join(repo, path), join(out, 'source', path));
}

const attempts = [], serverEvents = [];
/** @type {Record<string, string>} */
let headers = {};
let report, url, close = async () => {}, health;

try {
    if (local) {
        const { initializeSandbox } = await import('pyric/sandbox');
        const { getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
        const { createHostedRecoveryApp } = await import('./http-app.mjs');
        const service = createHostedRecoveryApp({
            db: getAdminFirestore(initializeSandbox().withAuth(null)),
            runId: measurementId,
            instanceId: 'local-http-a',
            record: (kind, data) => serverEvents.push({ kind, ...data }),
            environment: { backend: 'pyric', revision: 'local', sourceHash: 'working-tree' },
        });
        const server = service.app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No listener');
        url = `http://127.0.0.1:${address.port}`;
        close = async () => { service.stopAdmission(); await new Promise(resolve => server.close(resolve)); await service.drain(); };
    } else {
        report = JSON.parse(await readFile(join(resolve(args[0]), 'deployment-report.json'), 'utf8'));
        if (report.project !== 'digame-mas' || report.service !== 'automatic-recovery' || report.region !== 'us-east4'
            || report.database?.name !== 'projects/digame-mas/databases/allowance-experiments'
            || !report.url?.endsWith('.run.app') || report.status !== 'deployed')
            throw new Error('Unexpected deployment target');
        await cp(join(resolve(args[0]), 'deployment-report.json'), join(out, 'deployment-report.json'));
        await cp(join(resolve(args[0]), 'source'), join(out, 'deployed-source'), { recursive: true });
        await save('source-verification.json', await verifyDeployedSource(join(out, 'deployed-source'), report.sourceHash));
        const parity = await compareSources(join(out, 'source'), join(out, 'deployed-source'));
        await save('source-parity.json', parity);
        if (!parity.identical) throw new Error('Local and deployed architecture differ; cannot pair these runs');
        const identity = JSON.parse(await readFile(resolve(args[1]), 'utf8'));
        if (identity.type !== 'service_account' || identity.project_id !== report.project)
            throw new Error('Wrong credential project');
        const token = execFileSync(process.env.GCLOUD_BIN || 'gcloud', [
            'auth', 'print-identity-token', `--audiences=${report.url}`, '--project=digame-mas', '--quiet',
        ], {
            env: { ...process.env, CLOUDSDK_CONFIG: join(tmpdir(), 'recovery-cloudrun-gcloud'), CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: resolve(args[1]) },
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
        }).trim();
        headers = { Authorization: `Bearer ${token}` };
        url = report.url;
    }

    const response = await fetch(`${url}/health`, { headers, redirect: 'error', signal: AbortSignal.timeout(40000) });
    if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
    health = await response.json();
    if (!local && (health.runId !== report.runId || health.revision !== report.revision || health.sourceHash !== report.sourceHash
        || health.requestsObserved > 40))
        throw new Error('Wrong revision/provenance or insufficient observed process request budget');

    await save('environment.json', {
        backend: local ? 'pyric-http' : 'cloud-run-firestore',
        health,
        target: url,
        inference: 'durable fixture; no real model calls',
        deploymentPerformed: false,
        controllerRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
        controllerSnapshot: 'source/',
        deployedSnapshot: local ? 'source/' : 'deployed-source/',
    });

    const startedAt = new Date().toISOString();
    console.log(JSON.stringify({ stage: 'running', out, measurementId, backend: health.backend }));

    const command = async (caseId, body) => {
        const traceId = randomUUID().replaceAll('-', ''), path = `/cases/${caseId}/commands`;
        const attempt = { index: attempts.length, caseId, path, traceId, request: body, startedAt: new Date().toISOString() };
        attempts.push(attempt);
        await appendFile(join(out, 'dispatch.ndjson'), JSON.stringify(attempt) + '\n');
        const begin = performance.now();
        try {
            const response = await fetch(url + path, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(40000),
                headers: { ...headers, 'Content-Type': 'application/json', 'X-Cloud-Trace-Context': `${traceId}/1;o=1` },
                body: JSON.stringify(body),
            });
            const value = await response.json();
            Object.assign(attempt, { status: response.status, body: value });
            if (!local && response.ok && value.runId !== report.runId)
                throw new Error('Command reached unexpected backend run');
            return { status: response.status, body: value };
        } catch (error) {
            attempt.transportError = String(error.name);
            throw new Error(`Uncertain command transport outcome (${error.name}); no automatic retry`);
        } finally {
            Object.assign(attempt, { endedAt: new Date().toISOString(), elapsedMs: performance.now() - begin });
            await appendFile(join(out, 'attempts.ndjson'), JSON.stringify(attempt) + '\n');
        }
    };

    const result = await runHostedWorkload({
        measurementId,
        command,
        onCase: row => console.log(JSON.stringify({ stage: 'case', ...row })),
    });
    const endedAt = new Date().toISOString();
    Object.assign(result, {
        run: { id: measurementId, backendRunId: health.runId, backend: health.backend, startedAt, endedAt },
        observedInstances: [...new Set(attempts.map(row => row.body?.instanceId).filter(Boolean))],
    });
    await save('result.json', result);

    if (local) {
        await save('server-events.json', serverEvents);
    } else {
        const caseIds = [...new Set(attempts.map(row => row.caseId))];
        const requestPaths = [...new Set(attempts.map(row => row.path))];
        const capture = await captureLogs({
            project: report.project,
            database: 'allowance-experiments',
            service: report.service,
            region: report.region,
            revision: report.revision,
            backendRunId: report.runId,
            measurementId,
            documentCollection: 'automaticRecoveryExperiments',
            startedAt: new Date(Date.parse(startedAt) - 2000).toISOString(),
            endedAt: new Date(Date.parse(endedAt) + 2000).toISOString(),
            caseIds,
            requestIds: attempts.map(row => row.request.requestId).filter(Boolean),
            traceIds: attempts.map(row => row.traceId),
            requestPaths,
            expectedRequests: attempts.length,
        }, {
            out: join(out, 'logs'),
            api: await googleApi({ project: report.project, credentials: resolve(args[1]) }),
            waitMs: 90000,
        });
        console.log(JSON.stringify({
            stage: 'logs',
            status: capture.collectionStatus,
            coverage: capture.coverage,
            streams: Object.fromEntries(Object.entries(capture.streams).map(([key, value]) => [key, value.entries])),
        }));
    }

    console.log(JSON.stringify({
        stage: 'complete',
        out,
        successful: result.successful,
        cases: result.cases.length,
        assertions: result.assertions.length,
        commands: result.commands,
        instances: result.observedInstances,
        failure: result.failure,
    }));
    if (!result.successful) process.exitCode = 1;
} catch (error) {
    await save('failure.json', { error: String(error.message), at: new Date().toISOString() });
    throw error;
} finally {
    await close();
    const files = [];
    async function visit(path, prefix = '') {
        for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const relative = prefix + item.name;
            if (item.isDirectory()) await visit(join(path, item.name), relative + '/');
            else {
                const bytes = await readFile(join(path, item.name));
                files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
            }
        }
    }
    await visit(out);
    await save('manifest.json', { formatVersion: 1, captureKind: 'automatic-recovery-hosted-workload', measurementId, local, credentialsBundled: false, files });
}
