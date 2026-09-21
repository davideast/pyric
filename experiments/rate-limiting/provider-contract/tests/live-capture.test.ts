import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRun } from '../../../shared/evidence/capture.mjs';
import { captureDefinition } from '../capture-definition.mjs';

test('captures can prohibit replay so recorded live inputs cannot dispatch again', async () => {
    const out = await mkdtemp(join(tmpdir(), 'provider-live-capture-'));
    try {
        const run = await captureRun(out, { definition: { ...captureDefinition(), replayAllowed: false, executionTimeoutMs: 120000 }, input: { cases: ['abort-before-dispatch'] } });
        expect(run.successfulExperiment).toBe(true);
        await expect(captureRun(out, { sourceCapture: run.directory })).rejects.toThrow('Replay is disabled');
    } finally { await rm(out, { recursive: true, force: true }); }
}, 15000);

test('live audit supplements exclude mixed namespaces and redact document contents and caller identity', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { collectAudit } = await import('../live/logs.mjs');
    const out = await mkdtemp(join(tmpdir(), 'provider-audit-fixture-'));
    try {
        const captured = await captureRun(out, { definition: captureDefinition(), input: { cases: ['abort-before-dispatch'] } });
        const resultPath = join(captured.directory, 'result.json');
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        result.run.environment.projectId = 'fixture-project'; result.run.environment.databaseId = 'fixture-db';
        const bytes = JSON.stringify(result); await writeFile(resultPath, bytes);
        const manifestPath = join(captured.directory, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        Object.assign(manifest.files.find(f => f.path === 'result.json'), { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) });
        await writeFile(manifestPath, JSON.stringify(manifest));
        const path = `projects/fixture-project/databases/fixture-db/documents/providerContractExperiments/${result.run.id}/state/budget`;
        const entry = { timestamp: result.events[0].timestamp, insertId: 'in-scope', logName: 'projects/fixture-project/logs/cloudaudit.googleapis.com%2Fdata_access',
            protoPayload: { serviceName: 'firestore.googleapis.com', authenticationInfo: { principalEmail: 'PRIVATE EMAIL' }, request: { writes: [{ update: { name: path, fields: { secret: 'PRIVATE DATA' } } }] } } };
        const mixed = { ...entry, insertId: 'mixed', protoPayload: { ...entry.protoPayload, metadata: { keys: ['projects/fixture-project/databases/fixture-db/documents/unrelated/document'] } } };
        const malformed = { ...entry, insertId: 'malformed', timestamp: 'not-a-time' };
        const report = await collectAudit(captured.directory, join(out, 'audit'), { request: async () => ({ entries: [entry, mixed, malformed] }) }, { waitMs: 0 });
        expect(report.entries).toBe(1); expect(report.excluded).toBe(2);
        expect(await readFile(join(out, 'audit/firestore-audit.ndjson'), 'utf8')).not.toContain('PRIVATE');
        expect(report.completeCoverageProven).toBe(false);
    } finally { await rm(out, { recursive: true, force: true }); }
}, 15000);
