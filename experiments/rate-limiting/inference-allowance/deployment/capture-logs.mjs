import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureLogs } from '../../../shared/observability/log-capture.mjs';
import { googleApi } from '../../../shared/observability/google-api.mjs';
import { captureCollectorSource, sealLogExport, isSealedDestination } from '../../../shared/observability/log-artifacts.mjs';
const json = async path => JSON.parse(await readFile(path, 'utf8'));

// Separate from experiment assessments: missing logs must not rewrite a measured
// behavioural outcome into a success, or erase the outcome of a failed workload.
export async function captureMeasurementLogs(directory, credentials, options = {}) {
    const out = options.out ?? join(directory, 'logs');
    const skipped = { formatVersion: 1, collectionStatus: 'not-started', coverage: { status: 'unknown', universalCompletenessProven: false },
        failure: 'Existing or sealed evidence is preserved. Choose a new empty export directory.' };
    if (await isSealedDestination(directory, out)) return skipped;
    await mkdir(out, { recursive: true });
    if ((await readdir(out)).length) return skipped;
    let collectorSource;
    try {
        collectorSource = await captureCollectorSource(out, import.meta.url);
        const deployment = await json(join(directory, 'deployment-report.json'));
        const result = await json(join(directory, 'result.json'));
        const window = await json(join(directory, 'log-window.json'));
        const database = /^projects\/([^/]+)\/databases\/([^/]+)$/.exec(deployment.database.name);
        if (!database) throw new Error('Invalid deployment database');
        const dispatches = result.events.filter(event => event.kind === 'client-dispatch');
        const paths = dispatches.map(event => {
            if (event.requestPath) return event.requestPath;
            if (deployment.workload === 'execution') return `/cases/${event.caseId}/infer/chat`;
            return `/infer/${event.route ?? 'chat'}`;
        });
        let caseIds = ['cloudrun-combined-guard'];
        if (deployment.workload === 'execution') caseIds = dispatches.map(event => event.caseId);
        const input = { project: database[1], database: database[2], service: deployment.service, region: deployment.region,
            revision: deployment.revision, backendRunId: deployment.runId, measurementId: result.run.id,
            startedAt: window.startedAt, endedAt: window.endedAt, caseIds,
            requestIds: dispatches.map(event => event.requestId).filter(Boolean), traceIds: dispatches.map(event => event.traceId).filter(Boolean),
            requestPaths: paths, expectedRequests: dispatches.length };
        let observability;
        try { observability = await json(join(directory, 'observability-report.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const config = observability?.snapshot?.config ?? observability?.config;
        if (config) {
            if (config.project !== input.project || config.database !== input.database || config.service !== input.service || config.region !== input.region) throw new Error('Observability target mismatch');
            Object.assign(input, { logView: `projects/${input.project}/locations/${config.location}/buckets/${config.bucket}/views/_AllLogs` });
        }
        const api = options.api ?? await googleApi({ project: input.project, credentials });
        const report = await captureLogs(input, { ...options, out, api });
        Object.assign(report, { collectorSource, logViewSource: config ? 'observability-snapshot' : 'default-without-snapshot' });
        await writeFile(join(out, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        await sealLogExport(out);
        return report;
    } catch (error) {
        // Keep arbitrary SDK errors (which may embed credentials) out of artifacts.
        const report = { formatVersion: 1, collectionStatus: 'failed', coverage: { status: 'unknown', universalCompletenessProven: false },
            failure: 'Unable to initialise capture. Check measurement result, log window, deployment metadata and collector credentials.',
            httpStatus: Number.isInteger(error.status) ? error.status : null, finishedAt: new Date().toISOString() };
        Object.assign(report, { collectorSource });
        await writeFile(join(out, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        await sealLogExport(out);
        return report;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [directory, credentials, destination, wait] = process.argv.slice(2);
    if (!directory || !credentials || !destination) throw new Error('Usage: node deployment/capture-logs.mjs MEASUREMENT_DIRECTORY COLLECTOR_KEY NEW_EXPORT_DIRECTORY [WAIT_MS]');
    const options = { out: resolve(destination) };
    if (wait !== undefined) Object.assign(options, { waitMs: Number(wait) });
    const report = await captureMeasurementLogs(resolve(directory), resolve(credentials), options);
    console.log(JSON.stringify({ directory: resolve(destination), collectionStatus: report.collectionStatus, coverage: report.coverage }));
    if (report.collectionStatus !== 'collected' || report.coverage.status !== 'observed') process.exitCode = 1;
}
