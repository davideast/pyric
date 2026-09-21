import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { captureScope, captureQueries, correlate } from './log-scope.mjs';
import { redactEntry, redactionVersion } from './log-redaction.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const save = (out, name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

// Bounded ingestion polling, complete pagination per pass, and a union across
// passes: a late or temporarily absent entry never erases previous evidence.
export async function captureLogs(value, { out, api, waitMs = 90000, pollMs = 5000, settleMs = 15000,
    maxPages = 100, maxEntries = 50000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const input = captureScope(value);
    for (const [key, number, min, max] of [['waitMs', waitMs, 0, 300000], ['pollMs', pollMs, 1, 30000], ['settleMs', settleMs, 0, 300000], ['maxPages', maxPages, 1, 1000], ['maxEntries', maxEntries, 1, 200000]]) {
        if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${key}`);
    }
    await mkdir(out, { recursive: true });
    const queries = captureQueries(input);
    const resourceNames = [...new Set([input.logView, ...(input.additionalLogViews ?? [])])];
    const streams = Object.fromEntries(Object.entries(queries).map(([name, filter]) => [name, {
        filter, resourceNames, pages: 0, fetched: 0, duplicates: 0, excluded: 0, rounds: 0, entries: 0,
        paginationComplete: false, errors: [], truncated: false, correlation: { request: 0, 'case-scope': 0, candidate: 0 },
    }]));
    const entries = Object.fromEntries(Object.keys(queries).map(name => [name, new Map()]));
    const begun = now(), deadline = begun + waitMs;
    let lastAddition = begun, stopReason = 'ingestion-deadline', round = 0;
    const report = { formatVersion: 1, input, startedAt: new Date().toISOString(), collectionStatus: 'collecting', streams,
        redaction: { version: redactionVersion, description: 'Allowlisted telemetry in provider entry structure; document bodies, query strings, IPs, arbitrary payloads and credentials omitted' },
        limits: { waitMs, pollMs, settleMs, maxPages, maxEntries }, artifacts: [], coverage: {}, stopReason,
        limitations: ['Successful export is not proof of universal log completeness; entries can arrive after the bounded ingestion wait.',
            'Firestore audit entries without experiment document paths are excluded; audit entries do not map one-to-one to SDK calls or inference requests.',
            'HTTP matches without a client trace are candidates only. Case-scoped events can include concurrent activity in the same experiment namespace.'] };
    await save(out, 'capture-report.json', report);
    do {
        round++;
        for (const [stream, state] of Object.entries(streams)) {
            if (state.truncated || state.errors.length) continue;
            let pageToken, pages = 0;
            const tokens = new Set();
            state.rounds++; state.paginationComplete = false;
            try {
                do {
                    if ((round > 1 || pages > 0) && now() >= deadline) break;
                    const body = { resourceNames, filter: state.filter, pageSize: 1000, orderBy: 'timestamp asc', ...(pageToken ? { pageToken } : {}) };
                    const page = await api.request('POST', 'https://logging.googleapis.com/v2/entries:list', body, { timeoutMs: Math.max(1, Math.min(20000, deadline - now())) });
                    pages++; state.pages++;
                    for (const entry of page.entries ?? []) {
                        state.fetched++;
                        const correlation = correlate(entry, stream, input);
                        if (!correlation) { state.excluded++; continue; }
                        const safeEntry = redactEntry(entry, stream, correlation);
                        let identity = safeEntry;
                        if (entry.insertId) identity = [entry.logName, entry.insertId, entry.timestamp, entry.resource];
                        const key = sha(JSON.stringify(canonical(identity)));
                        if (entries[stream].has(key)) { state.duplicates++; continue; }
                        if (entries[stream].size >= maxEntries) { state.truncated = true; break; }
                        entries[stream].set(key, { correlation, entry: safeEntry });
                        state.correlation[correlation.level]++; lastAddition = now();
                    }
                    pageToken = page.nextPageToken;
                    if (pageToken && (tokens.has(pageToken) || pages >= maxPages)) state.truncated = true;
                    tokens.add(pageToken);
                    if (!pageToken) state.paginationComplete = true;
                } while (pageToken && !state.truncated);
            } catch (error) {
                // API messages and tokens can carry secrets; record only a stable category/status.
                state.errors.push({ category: 'logging-api-failure', httpStatus: Number.isInteger(error.status) ? error.status : null });
            }
            state.entries = entries[stream].size;
        }
        const coverage = captureCoverage(input, entries);
        if (coverage.status === 'observed' && now() - lastAddition >= settleMs) { stopReason = 'observed-and-quiet'; break; }
        if (Object.values(streams).every(s => s.errors.length || s.truncated)) { stopReason = 'collection-blocked'; break; }
        if (now() >= deadline) break;
        await sleep(Math.min(pollMs, deadline - now()));
    } while (now() < deadline);
    for (const [stream, records] of Object.entries(entries)) {
        const rows = [...records.values()].sort((a, b) => a.entry.timestamp.localeCompare(b.entry.timestamp));
        const bytes = gzipSync(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
        const path = `${stream}.ndjson.gz`;
        await writeFile(join(out, path), bytes, { mode: 0o600 });
        report.artifacts.push({ path, sha256: sha(bytes), bytes: bytes.length, entries: rows.length });
    }
    report.collectionStatus = Object.values(streams).some(s => s.errors.length || s.truncated || !s.paginationComplete) ? 'partial' : 'collected';
    report.coverage = captureCoverage(input, entries);
    report.stopReason = stopReason;
    Object.assign(report, { finishedAt: new Date().toISOString(), rounds: round, elapsedMs: now() - begun });
    await save(out, 'capture-report.json', report);
    return report;
}
function captureCoverage(input, entries) {
    const payloads = [...entries.application.values()].map(row => row.entry.jsonPayload);
    const starts = payloads.filter(p => p.kind === 'request-start');
    const started = new Set(starts.map(p => p.attemptId).filter(Boolean));
    const settled = new Set(payloads.filter(p => p.kind === 'request-work-settled' && started.has(p.attemptId)).map(p => p.attemptId));
    const missingRequests = input.requestIds.filter(id => !starts.some(p => p.requestId === id));
    const gaps = [];
    for (const [stream, rows] of Object.entries(entries)) if (!rows.size) gaps.push(`No retained ${stream} entries`);
    if (missingRequests.length) gaps.push('Some dispatched request IDs have no application start entry');
    if (started.size !== input.expectedRequests || settled.size !== input.expectedRequests) gaps.push('Application start/settlement counts differ from dispatched attempts');
    const observedTraces = new Set([...entries['http-request'].values()].filter(row => row.correlation.level === 'request').map(row => row.entry.trace.split('/').at(-1)));
    const missingTraceIds = input.traceIds.filter(id => !observedTraces.has(id));
    const exactHttp = observedTraces.size;
    if (missingTraceIds.length || exactHttp !== input.expectedRequests) gaps.push('Not every dispatched attempt has a trace-correlated HTTP entry');
    return { status: gaps.length ? 'gaps' : 'observed', universalCompletenessProven: false, expectedRequests: input.expectedRequests,
        starts: started.size, settled: settled.size, traceMatchedHttp: exactHttp, missingTraceIds, missingRequests, gaps };
}
