import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureMeasurementLogs } from '../deployment/capture-logs.mjs';

test('captures a failed measurement without changing its outcome and preserves missing-evidence state', async () => {
    const out = await mkdtemp(join(tmpdir(), 'measurement-logs-'));
    const result = { run: { id: 'measurement-one', error: 'workload failed' }, events: [{ kind: 'client-dispatch', caseId: 'case-one', requestId: 'one', traceId: 'a'.repeat(32), requestPath: '/cases/case-one/infer/chat' }] };
    try {
        await writeFile(join(out, 'result.json'), JSON.stringify(result));
        await writeFile(join(out, 'deployment-report.json'), JSON.stringify({ database: { name: 'projects/test-project/databases/test-db' }, service: 'service-one', region: 'us-east4', revision: 'service-one-001', runId: 'backend-one', workload: 'execution' }));
        await writeFile(join(out, 'log-window.json'), JSON.stringify({ startedAt: '2026-09-20T01:00:00Z', endedAt: '2026-09-20T01:01:00Z' }));
        await writeFile(join(out, 'observability-report.json'), JSON.stringify({ snapshot: { config: { project: 'test-project', database: 'test-db', service: 'service-one', region: 'us-east4', location: 'us-east4', bucket: 'pyric-experiments' } } }));
        const report = await captureMeasurementLogs(out, undefined, { api: { request: async () => ({ entries: [] }) }, waitMs: 1, pollMs: 1 });
        expect(report.collectionStatus).toBe('collected');
        expect(report.coverage.status).toBe('gaps');
        expect(report.input.logView).toBe('projects/test-project/locations/us-east4/buckets/pyric-experiments/views/_AllLogs');
        expect(Object.keys(report.collectorSource.files)).toContain('experiments/rate-limiting/inference-allowance/deployment/capture-logs.mjs');
        expect(report.input.caseIds).toEqual(['case-one']);
        expect(report.input.traceIds).toEqual(['a'.repeat(32)]);
        expect(JSON.parse(await readFile(join(out, 'result.json'), 'utf8'))).toEqual(result);
        const original = await readFile(join(out, 'logs/capture-report.json'), 'utf8');
        const retry = await captureMeasurementLogs(out, undefined, { api: {}, waitMs: 1 });
        expect(retry.collectionStatus).toBe('not-started');
        expect(await readFile(join(out, 'logs/capture-report.json'), 'utf8')).toBe(original);
        await rm(join(out, 'result.json'));
        const failed = await captureMeasurementLogs(out, '/does-not-exist', { waitMs: 1, out: join(out, 'failed-export') });
        expect(failed.collectionStatus).toBe('failed');
        expect(failed.coverage.status).toBe('unknown');
        expect(await readFile(join(out, 'logs/capture-report.json'), 'utf8')).not.toContain('/does-not-exist');
    } finally { await rm(out, { recursive: true, force: true }); }
});

test('explicit and symlinked output paths cannot add files to a sealed measurement', async () => {
    const { mkdir, symlink, readdir } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'sealed-logs-'));
    const measurement = join(root, 'measurement');
    await mkdir(measurement);
    await writeFile(join(measurement, 'manifest.json'), '{"files":[]}');
    await symlink(measurement, join(root, 'alias'));
    try {
        for (const out of [join(measurement, 'another-export'), join(root, 'alias/nested/export')]) {
            expect((await captureMeasurementLogs(measurement, undefined, { out })).collectionStatus).toBe('not-started');
            expect(await readdir(measurement)).toEqual(['manifest.json']);
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});
