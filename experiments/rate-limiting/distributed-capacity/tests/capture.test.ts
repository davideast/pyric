import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRun, verifyCapture } from '../../../shared/evidence/capture.mjs';
import { captureDefinition } from '../capture-definition.mjs';
import { assess, compare } from '../analysis/assess.mjs';

test('retains executed source, normalized observations, expected control failures and replayable evidence', async () => {
    const out = await mkdtemp(join(tmpdir(), 'capacity-capture-'));
    try {
        const run = await captureRun(out, { definition: captureDefinition(), input: { profile: 'local' } });
        expect(run.successfulExperiment).toBe(true);
        expect((await verifyCapture(run.directory)).valid).toBe(true);
        const result = JSON.parse(await readFile(join(run.directory, 'result.json'), 'utf8'));
        expect(result.cases).toHaveLength(14);
        expect(result.run.environment.production).toBe(false);
        expect(result.assertions.filter(row => !row.passed)).toHaveLength(2);
        const replay = await captureRun(out, { sourceCapture: run.directory });
        expect(replay.successfulExperiment).toBe(true);
        const repeated = JSON.parse(await readFile(join(replay.directory, 'result.json'), 'utf8'));
        expect(compare(result, repeated).compatible).toBe(true);
        const missing = structuredClone(result); missing.assertions = [];
        expect(assess(missing).successfulExperiment).toBe(false);
        expect(compare(result, missing).compatible).toBe(false);
        const capturedDefinition = await import(pathToFileURL(join(run.directory, 'source/experiments/rate-limiting/distributed-capacity/capture-definition.mjs')).href);
        const originalHash = capturedDefinition.implementationHash();
        await appendFile(join(run.directory, 'source/experiments/rate-limiting/distributed-capacity/adapters/pyric-cluster.mjs'), '\n// adapter-only change\n');
        const adapterHash = capturedDefinition.implementationHash();
        expect(adapterHash).not.toBe(originalHash);
        await appendFile(join(run.directory, 'source/experiments/rate-limiting/inference-allowance/adapters/store.mjs'), '\n// transaction instrumentation change\n');
        const storeHash = capturedDefinition.implementationHash();
        expect(storeHash).not.toBe(adapterHash);
        const changed = structuredClone(result); changed.run.implementationHash = storeHash;
        expect(compare(result, changed).compatible).toBe(false);
        await writeFile(join(run.directory, 'source/experiments/rate-limiting/distributed-capacity/architecture/capacity.mjs'), '// tampered');
        expect((await verifyCapture(run.directory)).valid).toBe(false);
    } finally { await rm(out, { recursive: true, force: true }); }
}, 15000);
