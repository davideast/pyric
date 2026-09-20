// Queries and attribution are deliberately separate: a query match is not proof
// that an audit entry or HTTP request belongs to a particular inference attempt.
export function captureScope(value) {
    const input = {};
    for (const key of ['project', 'database', 'service', 'region', 'revision', 'backendRunId', 'measurementId']) {
        if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value[key])) {
            if (key !== 'database' || value[key] !== '(default)') throw new Error(`Invalid capture ${key}`);
        }
        input[key] = value[key];
    }
    for (const key of ['startedAt', 'endedAt']) {
        if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))) throw new Error(`Invalid capture ${key}`);
        input[key] = new Date(value[key]).toISOString();
    }
    const duration = Date.parse(input.endedAt) - Date.parse(input.startedAt);
    if (duration < 0 || duration > 3600000) throw new Error('Capture window must be ordered and at most one hour');
    for (const key of ['caseIds', 'requestIds', 'traceIds', 'requestPaths']) {
        if (!Array.isArray(value[key]) || value[key].length > 1000) throw new Error(`Invalid capture ${key}`);
        input[key] = [...new Set(value[key])];
        for (const item of input[key]) {
            const pattern = key === 'requestPaths' ? /^\/[a-zA-Z0-9/_-]{0,199}$/ : /^[a-zA-Z0-9_-]{1,200}$/;
            if (typeof item !== 'string' || !pattern.test(item)) throw new Error(`Invalid capture ${key} item`);
            if (key === 'traceIds' && !/^[a-f0-9]{32}$/.test(item)) throw new Error('Invalid trace ID');
        }
    }
    if (!input.caseIds.length || !input.requestPaths.length) throw new Error('Capture needs cases and request paths');
    if (!Number.isInteger(value.expectedRequests) || value.expectedRequests < 0 || value.expectedRequests > 10000) throw new Error('Invalid expected request count');
    input.expectedRequests = value.expectedRequests;
    if (value.documentCollection !== undefined) {
        if (!['allowanceExperiments', 'capacityExperiments'].includes(value.documentCollection)) throw new Error('Invalid capture document collection');
        input.documentCollection = value.documentCollection;
    }
    input.logView = value.logView ?? `projects/${input.project}/locations/global/buckets/pyric-experiments/views/_AllLogs`;
    const view = /^projects\/([^/]+)\/locations\/([a-z0-9-]+)\/buckets\/pyric-experiments\/views\/_AllLogs$/.exec(input.logView);
    if (!view || view[1] !== input.project) throw new Error('Invalid capture log view');
    if (value.additionalLogViews !== undefined) {
        if (!Array.isArray(value.additionalLogViews) || value.additionalLogViews.length > 2) throw new Error('Invalid additional capture log view');
        for (const name of value.additionalLogViews) {
            const match = typeof name === 'string' && /^projects\/([^/]+)\/locations\/([a-z0-9-]+)\/buckets\/(_Default|pyric-experiments)\/views\/_AllLogs$/.exec(name);
            if (!match || match[1] !== input.project) throw new Error('Invalid additional capture log view');
        }
        input.additionalLogViews = [...new Set(value.additionalLogViews)];
    }
    return input;
}
const quoted = value => JSON.stringify(value);
export function captureQueries(input) {
    const window = `timestamp >= ${quoted(input.startedAt)} AND timestamp <= ${quoted(input.endedAt)}`;
    const run = `resource.type="cloud_run_revision" AND resource.labels.project_id=${quoted(input.project)} AND resource.labels.service_name=${quoted(input.service)} AND resource.labels.location=${quoted(input.region)} AND resource.labels.revision_name=${quoted(input.revision)}`;
    return {
        application: `${window} AND ${run} AND jsonPayload.runId=${quoted(input.backendRunId)} AND (${input.caseIds.map(id => `jsonPayload.caseId=${quoted(id)}`).join(' OR ')})`,
        'http-request': `${window} AND ${run} AND log_id("run.googleapis.com/requests") AND (${input.requestPaths.map(path => `httpRequest.requestUrl:${quoted(path)}`).join(' OR ')})`,
        'firestore-audit': `${window} AND protoPayload.serviceName="firestore.googleapis.com" AND log_id("cloudaudit.googleapis.com/data_access") AND (${caseRoots(input).map(path => `SEARCH(${quoted(path)})`).join(' OR ')})`,
    };
}
function caseRoots(input) {
    return input.caseIds.map(id => `projects/${input.project}/databases/${input.database}/documents/${input.documentCollection ?? 'allowanceExperiments'}/${input.backendRunId}/cases/${id}`);
}
export function auditPaths(entry) {
    const p = entry.protoPayload ?? {};
    const request = p.request ?? {};
    return [...new Set([p.resourceName, ...(p.metadata?.keys ?? []), ...(request.documents ?? []), request.name,
        request.parent, request.document?.name, ...(request.writes ?? []).flatMap(write => [write.update?.name, write.delete, write.transform?.document])]
        .filter(path => typeof path === 'string' && path.includes('/documents/')))];
}
export function correlate(entry, stream, input) {
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < Date.parse(input.startedAt) || timestamp > Date.parse(input.endedAt)) return null;
    if (stream === 'firestore-audit') {
        if (entry.protoPayload?.serviceName !== 'firestore.googleapis.com' || !entry.logName?.endsWith('cloudaudit.googleapis.com%2Fdata_access')) return null;
        const roots = caseRoots(input), paths = auditPaths(entry);
        if (!paths.length || paths.some(path => !roots.some(root => path === root || path.startsWith(root + '/')))) return null;
        return { level: 'case-scope', reason: 'Exact experiment case document paths; not attributed to an inference request', paths };
    }
    const labels = entry.resource?.labels ?? {};
    if (entry.resource?.type !== 'cloud_run_revision' || labels.project_id !== input.project || labels.service_name !== input.service || labels.location !== input.region || labels.revision_name !== input.revision) return null;
    if (stream === 'application') {
        const payload = entry.jsonPayload;
        if (payload?.runId !== input.backendRunId || !input.caseIds.includes(payload.caseId)) return null;
        if (payload.requestId && !input.requestIds.includes(payload.requestId)) return null;
        if (payload.requestId) return { level: 'request', reason: 'Exact backend run, case and request ID' };
        return { level: 'case-scope', reason: 'Run and case match; no request ID' };
    }
    if (!entry.logName?.endsWith('run.googleapis.com%2Frequests')) return null;
    let path;
    try { path = new URL(entry.httpRequest?.requestUrl).pathname; } catch { return null; }
    if (!input.requestPaths.includes(path)) return null;
    if (input.traceIds.some(id => entry.trace === `projects/${input.project}/traces/${id}`)) return { level: 'request', reason: 'Exact client trace ID' };
    return { level: 'candidate', reason: 'Revision, time and path only; concurrent requests may be unrelated' };
}
