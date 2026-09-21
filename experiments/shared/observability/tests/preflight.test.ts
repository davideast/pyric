import { test, expect } from 'bun:test';
import { configuration } from '../requirements.mjs';
import { inspect } from '../inspection.mjs';
import { plan, apply } from '../planning.mjs';
import { preflight } from '../preflight.mjs';
import { googleFixture } from './google-fixture.mjs';
import manifest from '../../../rate-limiting/inference-allowance/observability.json';

async function ready(inaccessibleAncestors = false) {
    const fixture = googleFixture();
    if (inaccessibleAncestors) {
        fixture.state.project.parent = { type: 'folder', id: '123' };
        fixture.state.denied.push('/folders/123', '/folders/123:getIamPolicy');
    }
    const config = configuration({ project: 'test-project', database: 'test-db', service: 'test-service', region: 'us-east4', collector: fixture.api.identity }, manifest);
    const report = await inspect(fixture.api, fixture.api, config, manifest);
    return { ...fixture, report: (await apply(fixture.api, fixture.api, plan(report), manifest)).report };
}

function service(state, { omitWrite = false, wrongDocument = false } = {}) {
    return async (url, options) => {
        const { probeId } = JSON.parse(options.body);
        expect(new URL(url).hostname).toBe('experiment-xyz-uc.a.run.app');
        const documentName = `projects/test-project/databases/test-db/documents/observabilityPreflight/${probeId}`;
        const doc = wrongDocument ? 'projects/other/databases/other/documents/unrelated/x' : documentName;
        state.logs = {
            'observability-preflight-complete': [{ insertId: 'app', jsonPayload: { kind: 'observability-preflight-complete', probeId } }],
            'httpRequest.requestUrl': [{ insertId: 'http', httpRequest: { status: 200, requestUrl: String(url) } }],
            '(GetDocument|BatchGetDocuments)': [{ insertId: 'read', protoPayload: { resourceName: doc } }],
            '(Commit|CreateDocument|DeleteDocument|BatchWrite)': omitWrite ? [] : [{ insertId: 'write', protoPayload: { resourceName: doc } }],
        };
        return Response.json({ probeId, documentName, cleanedUp: true });
    };
}

test('preflight requires independent application, HTTP, read and write witnesses', async () => {
    const { api, state, report } = await ready();
    const saved = [];
    const result = await preflight(report, api, { fetchImpl: service(state), timeoutMs: 100, persist: async r => { saved.push(structuredClone(r)); } });
    expect(result.evidenceComplete).toBe(true);
    expect(Object.keys(result.preflight.evidence)).toEqual(['application', 'http-request', 'firestore-read', 'firestore-write']);
    expect(saved[0].preflight.status).toBe('running');
    expect(saved.at(-1).preflight.status).toBe('passed');
    expect(state.calls.filter(c => c.url.endsWith('entries:list')).every(c => c.body.resourceNames[0].includes('/buckets/pyric-experiments/views/_AllLogs'))).toBe(true);
});

test('missing audit evidence never becomes a pass, even when the HTTP call succeeded', async () => {
    const { api, state, report } = await ready();
    const result = await preflight(report, api, { fetchImpl: service(state, { omitWrite: true }), timeoutMs: 100 });
    expect(result.evidenceComplete).toBe(false);
    expect(result.preflight.acknowledgement.cleanedUp).toBe(true);
    expect(result.preflight.status).toBe('incomplete');
});

test('audit evidence for another database does not satisfy this run', async () => {
    const { api, state, report } = await ready();
    const result = await preflight(report, api, { fetchImpl: service(state, { wrongDocument: true }), timeoutMs: 100 });
    expect(result.evidenceComplete).toBe(false);
    expect(result.preflight.evidence['firestore-read']).toBeUndefined();
});

test('preflight does not invoke the service when configuration is unknown', async () => {
    const { api, report } = await ready();
    report.configurationReady = false;
    report.projectConfigurationReady = false;
    let invoked = false;
    await expect(preflight(report, api, { fetchImpl: async () => { invoked = true; return Response.json({}); } })).rejects.toThrow('checks must pass');
    expect(invoked).toBe(false);
});

test('project-only setup requires real witnesses and preserves unknown inherited settings', async () => {
    const { api, state, report } = await ready(true);
    expect(report.projectConfigurationReady).toBe(true);
    expect(report.configurationReady).toBe(false);
    const incomplete = await preflight(report, api, { fetchImpl: service(state, { omitWrite: true }), timeoutMs: 100 });
    expect(incomplete.evidenceComplete).toBe(false);
    const verified = await preflight(report, api, { fetchImpl: service(state), timeoutMs: 100 });
    expect(verified.preflight.status).toBe('passed');
    expect(verified.evidenceComplete).toBe(true);
    expect(verified.configurationReady).toBe(false);
    expect(verified.checks.find(c => c.id === 'inherited-auditing').status).toBe('unknown');
});

test('legacy service without preflight support gives an actionable incomplete report', async () => {
    const { api, report } = await ready();
    const result = await preflight(report, api, { identityToken: 'secret-token', fetchImpl: async () => new Response('', { status: 404 }), timeoutMs: 100 });
    expect(result.evidenceComplete).toBe(false);
    expect(result.preflight.error).toContain('check deployment');
    expect(JSON.stringify(result)).not.toContain('secret-token');
});
