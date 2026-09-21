import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { resources } from './requirements.mjs';

// All writes occur through the experiment service, exercising its runtime identity.
export async function preflight(report, collectorApi, { identityToken = undefined, timeoutMs = 120000, fetchImpl = fetch, wait = sleep, persist = async (_value) => {} } = {}) {
    if (!report.projectConfigurationReady) throw new Error('Project configuration checks must pass before preflight');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('Preflight timeout must be 100–300000ms');
    const uri = new URL(report.observations.run.value.uri);
    if (uri.protocol !== 'https:' || !uri.hostname.endsWith('.run.app') || uri.username || uri.password) throw new Error('Expected the Cloud Run service HTTPS URI');
    const probeId = randomUUID();
    const startedAt = new Date().toISOString();
    const documentName = `projects/${report.config.project}/databases/${report.config.database}/documents/observabilityPreflight/${probeId}`;
    const result = { ...report, preflight: { probeId, startedAt, documentName, status: 'running', evidence: {}, entries: [] }, evidenceComplete: false };
    await persist(result);
    const target = new URL(report.manifest.preflightPath, uri);
    target.searchParams.set('probe', probeId);
    const traceId = probeId.replaceAll('-', '');
    try {
        const response = await fetchImpl(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)),
            headers: { 'Content-Type': 'application/json', 'X-Cloud-Trace-Context': `${traceId}/1;o=1`, ...(identityToken ? { Authorization: `Bearer ${identityToken.trim()}` } : {}) },
            body: JSON.stringify({ probeId, database: report.config.database }) });
        if (!response.ok) throw new Error(`Preflight endpoint returned HTTP ${response.status}; check deployment and invoker credentials`);
        const acknowledgement = await response.json();
        if (acknowledgement.probeId !== probeId || acknowledgement.documentName !== documentName || !acknowledgement.cleanedUp) throw new Error('Preflight acknowledgement does not match the target');
        result.preflight.acknowledgement = acknowledgement;
        const urls = resources(report.config);
        const base = `timestamp>="${startedAt}"`;
        const queries = {
            application: `${base} AND resource.type="cloud_run_revision" AND resource.labels.service_name="${report.config.service}" AND jsonPayload.probeId="${probeId}" AND jsonPayload.kind="observability-preflight-complete"`,
            'http-request': `${base} AND resource.type="cloud_run_revision" AND resource.labels.service_name="${report.config.service}" AND log_id("run.googleapis.com/requests") AND httpRequest.requestUrl:"${probeId}" AND httpRequest.status=200`,
            'firestore-read': `${base} AND protoPayload.serviceName="firestore.googleapis.com" AND log_id("cloudaudit.googleapis.com/data_access") AND SEARCH("${probeId}") AND protoPayload.methodName=~"(GetDocument|BatchGetDocuments)$"`,
            'firestore-write': `${base} AND protoPayload.serviceName="firestore.googleapis.com" AND log_id("cloudaudit.googleapis.com/data_access") AND SEARCH("${probeId}") AND protoPayload.methodName=~"(Commit|CreateDocument|DeleteDocument|BatchWrite)$"`,
        };
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            for (const kind of report.manifest.requiredEvidence) {
                if (Date.now() >= deadline) break;
                if (result.preflight.evidence[kind]) continue;
                if (!queries[kind]) throw new Error(`Unsupported required evidence: ${kind}`);
                const page = await collectorApi.request('POST', urls.logs, { resourceNames: [`${urls.bucketPath}/views/_AllLogs`], filter: queries[kind], pageSize: 20, orderBy: 'timestamp asc' }, { timeoutMs: Math.max(1, Math.min(20000, deadline - Date.now())) });
                // A bounded witness query, not an export or a claim of complete log delivery.
                const entries = (page.entries ?? []).filter(entry => {
                    if (!kind.startsWith('firestore-')) return true;
                    return !entry.protoPayload?.status?.code && JSON.stringify(entry).includes(documentName);
                });
                if (entries.length) {
                    result.preflight.evidence[kind] = { count: entries.length, insertIds: entries.map(e => e.insertId ?? null) };
                    result.preflight.entries.push(...entries);
                }
            }
            result.evidenceComplete = report.manifest.requiredEvidence.every(k => result.preflight.evidence[k]);
            await persist(result);
            if (result.evidenceComplete) break;
            await wait(Math.min(3000, Math.max(0, deadline - Date.now())));
        }
        result.preflight.status = result.evidenceComplete ? 'passed' : 'incomplete';
    } catch (error) {
        result.preflight.status = 'incomplete';
        result.preflight.error = error.message;
        result.preflight.cleanupNote = 'If the endpoint did not acknowledge cleanup, inspect this exact canary document; do not delete experiment data.';
    }
    result.preflight.finishedAt = new Date().toISOString();
    await persist(result);
    return result;
}
