import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyCapture } from '../../../shared/evidence/capture.mjs';
import { googleApi } from '../../../shared/observability/google-api.mjs';
import { auditPaths } from '../../../shared/observability/log-scope.mjs';
import { redactEntry } from '../../../shared/observability/log-redaction.mjs';

// A separate immutable supplement: collection never changes the executed capture.
export async function collectAudit(capture, out, api, { waitMs = 30000 } = {}) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 90000) throw new Error('Invalid bounded log wait');
    if (!(await verifyCapture(capture)).valid) throw new Error('Invalid source capture');
    const result = JSON.parse(await readFile(join(capture, 'result.json'), 'utf8'));
    const environment = result.run.environment;
    if (!/^[a-zA-Z0-9_-]+$/.test(environment.projectId) || !/^[a-zA-Z0-9_-]+$/.test(environment.databaseId) || !/^[a-zA-Z0-9_-]+$/.test(result.run.id)) throw new Error('Invalid audit scope');
    const times = result.events.map(e => Date.parse(e.timestamp)).filter(Number.isFinite);
    if (!times.length) throw new Error('No run observation window');
    const start = new Date(Math.min(...times) - 30000).toISOString(), end = new Date(Math.max(...times) + 30000).toISOString();
    const root = `projects/${environment.projectId}/databases/${environment.databaseId}/documents/providerContractExperiments/${result.run.id}`;
    const filter = `timestamp >= ${JSON.stringify(start)} AND timestamp <= ${JSON.stringify(end)} AND protoPayload.serviceName="firestore.googleapis.com" AND log_id("cloudaudit.googleapis.com/data_access") AND SEARCH(${JSON.stringify(root)})`;
    await mkdir(out, { recursive: false });
    const entries = new Map(), errors = []; const until = Date.now() + waitMs; let pages = 0, excluded = 0, truncated = false;
    do {
        let pageToken;
        for (let page = 0; page < 10; page++) {
            let response;
            try { response = await api.request('POST', 'https://logging.googleapis.com/v2/entries:list', { resourceNames: [`projects/${environment.projectId}`], filter, orderBy: 'timestamp asc', pageSize: 1000, ...(pageToken ? { pageToken } : {}) }); }
            catch (error) { errors.push({ httpStatus: error.status ?? null }); break; }
            pages++;
            for (const entry of response.entries ?? []) {
                const paths = auditPaths(entry);
                if (!paths.length || paths.some(p => !(p === root || p.startsWith(root + '/')))
                    || entry.protoPayload?.serviceName !== 'firestore.googleapis.com'
                    || !entry.logName?.endsWith('cloudaudit.googleapis.com%2Fdata_access')
                    || !Number.isFinite(Date.parse(entry.timestamp))
                    || Date.parse(entry.timestamp) < Date.parse(start) || Date.parse(entry.timestamp) > Date.parse(end)) { excluded++; continue; }
                const row = redactEntry(entry, 'firestore-audit', { paths });
                entries.set(entry.insertId ?? createHash('sha256').update(JSON.stringify(row)).digest('hex'), row);
            }
            pageToken = response.nextPageToken; if (!pageToken) break;
            if (page === 9) truncated = true;
        }
        if (errors.length || Date.now() >= until) break;
        await new Promise(r => setTimeout(r, Math.min(10000, until - Date.now())));
    } while (true);
    const body = [...entries.values()].map(e => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(join(out, 'firestore-audit.ndjson'), body, { flag: 'wx' });
    const report = { schemaVersion: 1, runId: result.run.id, sourceCaptureVerified: true, correlation: 'exact-run-document-paths; not inference-attempt attribution',
        status: errors.length ? 'partial' : entries.size ? 'observed' : 'not-observed', completeCoverageProven: false, pages, excluded, truncated, errors, entries: entries.size,
        window: { start, end }, artifact: { path: 'firestore-audit.ndjson', sha256: createHash('sha256').update(body).digest('hex') } };
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return report;
}
if (import.meta.main) {
    const [capture, out, credentials] = process.argv.slice(2);
    try {
        const result = JSON.parse(await readFile(join(capture, 'result.json'), 'utf8'));
        console.log(JSON.stringify(await collectAudit(capture, out, await googleApi({ project: result.run.environment.projectId, credentials })), null, 2));
    } catch { console.error('Audit collection failed; no broader log scope was attempted'); process.exitCode = 1; }
}
