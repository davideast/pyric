// Export logs for an already completed deployment smoke. Never deploys or sends
// another gateway request. Credentials are used only by the Google API boundary.
import { readFile, writeFile, mkdir, readdir, cp } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureLogs } from '../../../shared/observability/log-capture.mjs';
import { googleApi } from '../../../shared/observability/google-api.mjs';
const [recordDirectory, credentials] = process.argv.slice(2);
if (!recordDirectory || !credentials) throw new Error('Usage: capture-smoke.mjs DEPLOYMENT_RECORD COLLECTOR_KEY');
const report = JSON.parse(await readFile(join(resolve(recordDirectory), 'deployment-report.json'), 'utf8'));
if (report.project !== 'digame-mas' || report.service !== 'capacity-recovery' || report.region !== 'us-east4'
    || report.database?.name !== 'projects/digame-mas/databases/allowance-experiments' || report.functionalSmoke?.status !== 'passed') throw new Error('A completed capacity deployment smoke is required');
const smoke = report.functionalSmoke;
const recoverDefault = process.argv.includes('--include-default-logs');
const windowPaddingMs = recoverDefault ? 2000 : 0;
const out = resolve(recordDirectory, `logs-${randomUUID()}`);
await mkdir(out, { recursive: false });
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const sources = ['experiments/rate-limiting/distributed-capacity/deployment/capture-smoke.mjs',
    ...['log-capture.mjs', 'log-scope.mjs', 'log-redaction.mjs', 'google-api.mjs'].map(name => `experiments/shared/observability/${name}`)];
for (const path of sources) {
    await mkdir(dirname(join(out, 'collector-source', path)), { recursive: true });
    await cp(join(repo, path), join(out, 'collector-source', path));
}
await cp(join(resolve(recordDirectory), 'deployment-report.json'), join(out, 'deployment-report.json'));
const window = { startedAt: new Date(Date.parse(smoke.startedAt) - windowPaddingMs).toISOString(),
    endedAt: new Date(Date.parse(smoke.endedAt) + windowPaddingMs).toISOString(), windowPaddingMs,
    reason: recoverDefault ? 'Explicit recovery from default bucket; bounded clock/HTTP settlement margin, original window retained in deployment report' : 'Original client smoke window' };
await writeFile(join(out, 'capture-window.json'), JSON.stringify(window, null, 2) + '\n');
console.log(JSON.stringify({ stage: 'collecting-smoke-logs', directory: out }));
const capture = await captureLogs({ project: report.project, database: 'allowance-experiments', service: report.service,
    region: report.region, revision: report.revision, backendRunId: report.runId, measurementId: `smoke-${report.runId}`,
    documentCollection: 'capacityExperiments', startedAt: window.startedAt, endedAt: window.endedAt,
    ...(recoverDefault ? { additionalLogViews: [`projects/${report.project}/locations/global/buckets/_Default/views/_AllLogs`] } : {}),
    caseIds: ['deployment-smoke'], requestIds: [smoke.requestId], traceIds: [smoke.traceId], requestPaths: [smoke.path], expectedRequests: 1,
}, { out, api: await googleApi({ project: report.project, credentials: resolve(credentials) }), waitMs: 90000 });
const files = [];
async function visit(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) await visit(join(path, entry.name), relative + '/');
        else { const bytes = await readFile(join(path, entry.name)); files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }); }
    }
}
await visit(out);
await writeFile(join(out, 'manifest.json'), JSON.stringify({ formatVersion: 1, captureKind: 'capacity-deployment-smoke-logs',
    credentialsBundled: false, files, coverage: capture.coverage }, null, 2) + '\n');
console.log(JSON.stringify({ directory: out, collectionStatus: capture.collectionStatus, coverage: capture.coverage,
    streams: Object.fromEntries(Object.entries(capture.streams).map(([key, stream]) => [key, stream.entries])) }, null, 2));
if (capture.collectionStatus !== 'collected' || capture.coverage.status !== 'observed') process.exitCode = 1;
