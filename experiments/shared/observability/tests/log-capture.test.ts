import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { captureLogs } from '../log-capture.mjs';

const input = {
    logView: 'projects/test-project/locations/global/buckets/pyric-experiments/views/_AllLogs',
    project: 'test-project', database: 'test-db', service: 'test-service', region: 'us-east4', revision: 'test-service-00001',
    backendRunId: 'backend-one', measurementId: 'measurement-one',
    startedAt: '2026-09-20T01:00:00.000Z', endedAt: '2026-09-20T01:01:00.000Z',
    caseIds: ['case-one'], requestIds: ['request-one'], traceIds: ['a'.repeat(32)], requestPaths: ['/cases/case-one/infer/chat'], expectedRequests: 1,
};
const resource = { type: 'cloud_run_revision', labels: { project_id: input.project, service_name: input.service, location: input.region, revision_name: input.revision } };
const base = { timestamp: '2026-09-20T01:00:05Z', resource };
const app = (insertId: string, kind: string) => ({ ...base, insertId, logName: 'projects/test-project/logs/run.googleapis.com%2Fstdout',
    jsonPayload: { runId: input.backendRunId, caseId: 'case-one', requestId: 'request-one', attemptId: 'attempt-one', kind, prompt: 'PRIVATE PROMPT', apiKey: 'SECRET' } });
const http = { ...base, insertId: 'http', logName: 'projects/test-project/logs/run.googleapis.com%2Frequests', trace: `projects/test-project/traces/${input.traceIds[0]}`,
    httpRequest: { requestUrl: 'https://service.example/cases/case-one/infer/chat?secret=SECRET', requestMethod: 'POST', status: 200, remoteIp: 'PRIVATE IP' } };
const doc = 'projects/test-project/databases/test-db/documents/allowanceExperiments/backend-one/cases/case-one/quotas/alice';
const audit = { ...base, resource: { type: 'audited_resource', labels: { project_id: input.project } }, insertId: 'audit', logName: 'projects/test-project/logs/cloudaudit.googleapis.com%2Fdata_access',
    protoPayload: { serviceName: 'firestore.googleapis.com', methodName: 'google.firestore.v1.Firestore.Commit', resourceName: 'projects/test-project/databases/test-db',
        request: { writes: [{ update: { name: doc, fields: { prompt: 'PRIVATE DATA' } } }], transaction: 'SECRET' }, metadata: { keys: [doc] } } };
async function records(out: string, stream: string) { return gunzipSync(await readFile(join(out, `${stream}.ndjson.gz`))).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }

test('capacity experiment capture selects its own document namespace and excludes allowance records', async () => {
    const out = await mkdtemp(join(tmpdir(), 'capacity-logs-'));
    const capacityAudit = JSON.parse(JSON.stringify(audit).replaceAll('allowanceExperiments', 'capacityExperiments'));
    const filters: string[] = [];
    const api = { async request(_method, _url, body) {
        filters.push(body.filter);
        if (body.filter.includes('jsonPayload.runId')) return { entries: [app('start', 'request-start'), app('end', 'request-work-settled')] };
        if (body.filter.includes('run.googleapis.com/requests')) return { entries: [http] };
        return { entries: [capacityAudit, audit] };
    } };
    try {
        const report = await captureLogs({ ...input, documentCollection: 'capacityExperiments' }, { out, api, waitMs: 0 });
        expect(report.coverage.status).toBe('observed');
        expect(filters.some(filter => filter.includes('/documents/capacityExperiments/backend-one/cases/case-one'))).toBe(true);
        const rows = await records(out, 'firestore-audit');
        expect(rows).toHaveLength(1);
        expect(rows[0].correlation.paths.every(path => path.includes('/capacityExperiments/'))).toBe(true);
        await expect(captureLogs({ ...input, documentCollection: 'unrelated' }, { out, api, waitMs: 0 })).rejects.toThrow('Invalid capture document collection');
    } finally { await rm(out, { recursive: true, force: true }); }
});

test('provider contract experiment capture selects its own document namespace and excludes allowance records', async () => {
    const out = await mkdtemp(join(tmpdir(), 'provider-logs-'));
    const capacityAudit = JSON.parse(JSON.stringify(audit).replaceAll('allowanceExperiments', 'providerContractExperiments'));
    const filters: string[] = [];
    const api = { async request(_method, _url, body) {
        filters.push(body.filter);
        if (body.filter.includes('jsonPayload.runId')) return { entries: [app('start', 'request-start'), app('end', 'request-work-settled')] };
        if (body.filter.includes('run.googleapis.com/requests')) return { entries: [http] };
        return { entries: [capacityAudit, audit] };
    } };
    try {
        const report = await captureLogs({ ...input, documentCollection: 'providerContractExperiments' }, { out, api, waitMs: 0 });
        expect(report.coverage.status).toBe('observed');
        expect(filters.some(filter => filter.includes('/documents/providerContractExperiments/backend-one/cases/case-one'))).toBe(true);
        const rows = await records(out, 'firestore-audit');
        expect(rows).toHaveLength(1);
        expect(rows[0].correlation.paths.every(path => path.includes('/providerContractExperiments/'))).toBe(true);
        await expect(captureLogs({ ...input, documentCollection: 'unrelated' }, { out, api, waitMs: 0 })).rejects.toThrow('Invalid capture document collection');
    } finally { await rm(out, { recursive: true, force: true }); }
});

test('explicit default-bucket recovery records both views without widening experiment filters', async () => {
    const out = await mkdtemp(join(tmpdir(), 'recover-logs-'));
    const defaultView = 'projects/test-project/locations/global/buckets/_Default/views/_AllLogs';
    const queries: any[] = [];
    const api = { async request(_method, _url, body) { queries.push(body); return { entries: [] }; } };
    try {
        await captureLogs({ ...input, additionalLogViews: [defaultView] }, { out, api, waitMs: 0 });
        expect(queries.every(query => query.resourceNames.includes(defaultView))).toBe(true);
        expect(queries.every(query => query.filter.includes('timestamp <=') && query.filter.includes('test-project'))).toBe(true);
        await expect(captureLogs({ ...input, additionalLogViews: [defaultView.replace('test-project', 'another-project')] }, { out, api, waitMs: 0 })).rejects.toThrow('Invalid additional capture log view');
    } finally { await rm(out, { recursive: true, force: true }); }
});

test('exports paginated, deduplicated, late-arriving scoped evidence with hashes and redaction', async () => {
    const out = await mkdtemp(join(tmpdir(), 'capture-'));
    let time = 0, appRounds = 0;
    const queries: any[] = [];
    const api = { async request(_method, _url, body) {
        queries.push(body);
        if (body.filter.includes('jsonPayload.runId')) {
            if (!body.pageToken) { appRounds++; return { entries: [app('start', 'request-start')], nextPageToken: 'second' }; }
            return { entries: [app('start', 'request-start'), ...(appRounds > 1 ? [app('settled', 'request-work-settled')] : [])] };
        }
        if (body.filter.includes('run.googleapis.com/requests')) return { entries: [http] };
        return { entries: [audit] };
    } };
    try {
        const report = await captureLogs(input, { out, api, waitMs: 30, pollMs: 10, settleMs: 10, now: () => time, sleep: async ms => { time += ms; } });
        expect(report.collectionStatus).toBe('collected');
        expect(report.coverage.status).toBe('observed');
        expect(report.coverage.universalCompletenessProven).toBe(false);
        expect(report.streams.application.entries).toBe(2);
        expect(report.streams.application.pages).toBeGreaterThanOrEqual(4);
        expect(queries.every(q => q.resourceNames[0].endsWith('/buckets/pyric-experiments/views/_AllLogs'))).toBe(true);
        expect(queries.every(q => q.filter.includes('timestamp <=') && q.filter.includes('timestamp >='))).toBe(true);
        expect((await records(out, 'http-request'))[0].correlation.level).toBe('request');
        expect((await records(out, 'firestore-audit'))[0].correlation.level).toBe('case-scope');
        for (const artifact of report.artifacts) {
            const bytes = await readFile(join(out, artifact.path));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
            const text = gunzipSync(bytes).toString();
            expect(text).not.toContain('PRIVATE'); expect(text).not.toContain('SECRET');
        }
        expect(JSON.parse(await readFile(join(out, 'capture-report.json'), 'utf8')).input).toEqual(input);
    } finally { await rm(out, { recursive: true, force: true }); }
});

test('keeps partial evidence and reports API failures, pagination caps and ambiguous HTTP separately', async () => {
    const out = await mkdtemp(join(tmpdir(), 'capture-partial-'));
    let time = 0;
    const api = { async request(_method, _url, body) {
        if (body.filter.includes('jsonPayload.runId')) return { entries: [app('start', 'request-start')], nextPageToken: 'never-finishes' };
        if (body.filter.includes('run.googleapis.com/requests')) return { entries: [{ ...http, trace: undefined }] };
        throw Object.assign(new Error('TOKEN MUST NOT LEAK'), { status: 403 });
    } };
    try {
        const report = await captureLogs(input, { out, api, maxPages: 1, waitMs: 10, pollMs: 10, now: () => time, sleep: async ms => { time += ms; } });
        expect(report.collectionStatus).toBe('partial');
        expect(report.coverage.status).toBe('gaps');
        expect(report.streams.application.truncated).toBe(true);
        expect(report.streams['firestore-audit'].errors).toEqual([{ category: 'logging-api-failure', httpStatus: 403 }]);
        expect((await records(out, 'http-request'))[0].correlation.level).toBe('candidate');
        expect(await readFile(join(out, 'capture-report.json'), 'utf8')).not.toContain('TOKEN');
        expect(report.coverage.gaps).toContain('Not every dispatched attempt has a trace-correlated HTTP entry');
    } finally { await rm(out, { recursive: true, force: true }); }
});

test('rejects unrelated scopes and mixed Firestore operations instead of saving other project data', async () => {
    const out = await mkdtemp(join(tmpdir(), 'capture-scope-'));
    let time = 0;
    const unrelated = [
        { ...app('other-request', 'request-start'), jsonPayload: { ...app('x', 'x').jsonPayload, requestId: 'unrelated' } },
        { ...app('other-revision', 'request-start'), resource: { ...resource, labels: { ...resource.labels, revision_name: 'unrelated' } } },
        { ...app('other-time', 'request-start'), timestamp: '2026-09-19T01:00:00Z' },
        { ...http, httpRequest: { ...http.httpRequest, requestUrl: 'https://service.example/admin' } },
        { ...audit, protoPayload: { ...audit.protoPayload, metadata: { keys: [doc, 'projects/test-project/databases/test-db/documents/private/user'] } } },
    ];
    try {
        const report = await captureLogs(input, { out, api: { request: async () => ({ entries: unrelated }) }, waitMs: 1, pollMs: 1, now: () => time, sleep: async ms => { time += ms; } });
        expect(report.collectionStatus).toBe('collected');
        expect(report.coverage.status).toBe('gaps');
        expect(report.artifacts.every(file => file.entries === 0)).toBe(true);
        expect(report.streams.application.excluded).toBe(5);
    } finally { await rm(out, { recursive: true, force: true }); }
});

test('unions pages across ingestion polls, reports entry limits, and rejects unsafe capture filters', async () => {
    const out = await mkdtemp(join(tmpdir(), 'capture-limit-'));
    let time = 0;
    try {
        const report = await captureLogs(input, { out, api: { request: async (_m, _u, body) => ({ entries: body.filter.includes('jsonPayload.runId') ? [app('start', 'request-start'), app('end', 'request-work-settled')] : [] }) },
            maxEntries: 1, waitMs: 1, pollMs: 1, now: () => time, sleep: async ms => { time += ms; } });
        expect(report.streams.application.entries).toBe(1);
        expect(report.streams.application.truncated).toBe(true);
        await expect(captureLogs({ ...input, backendRunId: 'bad" OR true' }, { out, api: {} })).rejects.toThrow('Invalid capture');
        await expect(captureLogs({ ...input, endedAt: '2026-09-20T03:00:00Z' }, { out, api: {} })).rejects.toThrow('one hour');
    } finally { await rm(out, { recursive: true, force: true }); }
});

test('duplicate HTTP entries for one trace cannot conceal a missing request trace', async () => {
    const out = await mkdtemp(join(tmpdir(), 'capture-traces-'));
    let time = 0;
    const scope = { ...input, expectedRequests: 2, traceIds: ['a'.repeat(32), 'b'.repeat(32)], logView: 'projects/test-project/locations/us-east4/buckets/pyric-experiments/views/_AllLogs' };
    const queries: any[] = [];
    try {
        const report = await captureLogs(scope, { out, waitMs: 1, pollMs: 1, now: () => time, sleep: async ms => { time += ms; }, api: { async request(_m, _u, body) {
            queries.push(body);
            if (body.filter.includes('jsonPayload.runId')) return { entries: [app('start', 'request-start'), app('end', 'request-work-settled'),
                { ...app('start-two', 'request-start'), jsonPayload: { ...app('x', 'request-start').jsonPayload, attemptId: 'attempt-two' } },
                { ...app('end-two', 'request-work-settled'), jsonPayload: { ...app('x', 'request-work-settled').jsonPayload, attemptId: 'attempt-two' } }] };
            if (body.filter.includes('run.googleapis.com/requests')) return { entries: [http, { ...http, insertId: 'duplicate-trace' }] };
            return { entries: [audit] };
        } } });
        expect(report.coverage.status).toBe('gaps');
        expect(report.coverage.missingTraceIds).toEqual(['b'.repeat(32)]);
        expect(report.coverage.traceMatchedHttp).toBe(1);
        expect(queries.every(q => q.resourceNames[0] === scope.logView)).toBe(true);
    } finally { await rm(out, { recursive: true, force: true }); }
});

test('Google JSON field-order changes do not inflate entry counts across polls', async () => {
    const out = await mkdtemp(join(tmpdir(), 'capture-order-'));
    let time = 0, round = 0;
    try {
        const report = await captureLogs(input, { out, waitMs: 30, pollMs: 10, settleMs: 10, now: () => time, sleep: async ms => { time += ms; }, api: { async request(_m, _u, body) {
            if (body.filter.includes('jsonPayload.runId')) { round++; return { entries: [app('start', 'request-start'), app('end', 'request-work-settled')] }; }
            if (body.filter.includes('run.googleapis.com/requests')) {
                const labels = Object.fromEntries(Object.entries(resource.labels).sort(([a], [b]) => round % 2 ? a.localeCompare(b) : b.localeCompare(a)));
                return { entries: [{ ...http, resource: { type: resource.type, labels } }] };
            }
            return { entries: [audit] };
        } } });
        expect(report.streams['http-request'].entries).toBe(1);
        expect(report.streams['http-request'].duplicates).toBeGreaterThan(0);
        expect(report.stopReason).toBe('observed-and-quiet');
    } finally { await rm(out, { recursive: true, force: true }); }
});
