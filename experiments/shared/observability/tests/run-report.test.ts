import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordRunObservability } from '../run-report.mjs';
import { setupVersion, digest } from '../requirements.mjs';
import manifest from '../../../rate-limiting/inference-allowance/observability.json';

test('captures honest local/missing coverage and rejects stale or mismatched hosted evidence', async () => {
    const out = await mkdtemp(join(tmpdir(), 'obs-report-'));
    try {
        const options = { backend: 'cloud-run', project: 'test-project', database: 'test-db', service: 'test-service', region: 'us-east4', manifest };
        expect((await recordRunObservability(out, options)).status).toBe('not-checked');
        await expect(recordRunObservability(out, { ...options, requirePreflight: true })).rejects.toThrow('preflight');
        expect(JSON.parse(await readFile(join(out, 'observability-report.json'), 'utf8')).evidenceComplete).toBe(false);
        expect((await recordRunObservability(out, { ...options, backend: 'local', requirePreflight: true })).status).toBe('not-applicable');
        const reportFile = join(out, 'input-report.json');
        const snapshot = { setupVersion, manifestHash: digest(manifest), config: { project: 'test-project', database: 'test-db', service: 'test-service', region: 'us-east4' },
            evidenceComplete: true, preflight: { status: 'passed', finishedAt: new Date().toISOString() } };
        await writeFile(reportFile, JSON.stringify(snapshot));
        expect((await recordRunObservability(out, { ...options, reportFile, requirePreflight: true })).status).toBe('preflight-passed');
        await expect(recordRunObservability(out, { ...options, project: 'other-project', reportFile })).rejects.toThrow('mismatch');
        await expect(recordRunObservability(out, { ...options, region: 'us-west1', reportFile })).rejects.toThrow('mismatch');
        snapshot.preflight.finishedAt = '2020-01-01T00:00:00Z';
        await writeFile(reportFile, JSON.stringify(snapshot));
        await expect(recordRunObservability(out, { ...options, reportFile, requirePreflight: true })).rejects.toThrow('last hour');
    } finally { await rm(out, { recursive: true, force: true }); }
});
