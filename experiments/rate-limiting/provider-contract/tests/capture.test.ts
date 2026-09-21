import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRun, verifyCapture } from '../../../shared/evidence/capture.mjs';
import { captureDefinition } from '../capture-definition.mjs';
import { assess, compare } from '../analysis/assess.mjs';
import { preflight } from '../adapters/provider-contract.mjs';

test('captures and replays exact source while missing checks and interrupted execution remain incomplete', async () => {
    const out = await mkdtemp(join(tmpdir(), 'provider-contract-capture-'));
    try {
        const run = await captureRun(out, { definition: captureDefinition(), input: { cases: ['transport-loss', 'unsafe-transport-release'] } });
        expect(run.successfulExperiment).toBe(true);
        expect((await verifyCapture(run.directory)).valid).toBe(true);
        const replay = await captureRun(out, { sourceCapture: run.directory });
        const original = JSON.parse(await readFile(join(run.directory, 'result.json'), 'utf8'));
        const rerun = JSON.parse(await readFile(join(replay.directory, 'result.json'), 'utf8'));
        expect(compare(original, rerun).compatible).toBe(true);
        expect(assess({ ...original, assertions: [] }).successfulExperiment).toBe(false);
        expect(assess({ ...original, run: { ...original.run, interrupted: true } }).successfulExperiment).toBe(false);
        const changed = { ...rerun, run: { ...rerun.run, workloadHash: 'different' } };
        expect(compare(original, changed).compatible).toBe(false);
        await writeFile(join(run.directory, 'events.ndjson'), 'tampered');
        expect((await verifyCapture(run.directory)).valid).toBe(false);
    } finally { await rm(out, { recursive: true, force: true }); }
}, 20000);

test('preflight rejects unknown cases and insufficient budgets without enabling live inference', async () => {
    expect(preflight({ cases: ['unknown'] }).ready).toBe(false);
    expect(preflight({ cases: ['normal-response', 'normal-response'] }).ready).toBe(false);
    expect(preflight({ limits: { maxCommands: 1 } }).ready).toBe(false);
    expect(preflight({ provider: { kind: 'ai-logic' } }).ready).toBe(false);
    expect(preflight({ apiKey: 'must-not-be-captured' }).ready).toBe(false);
});

test('offline finalization preserves partial observations and does not turn a crash into passing evidence', async () => {
    const out = await mkdtemp(join(tmpdir(), 'provider-contract-partial-'));
    try {
        await writeFile(join(out, 'input.json'), JSON.stringify({ cases: ['transport-loss'] }));
        const event = { kind: 'provider-observation', source: 'provider-response', status: 'accepted', runId: 'partial-run' };
        await writeFile(join(out, 'events.ndjson'), JSON.stringify(event) + '\n');
        const proc = Bun.spawn([process.execPath, new URL('../execute.mjs', import.meta.url).pathname, out, '--recover'], {
            env: { ...process.env, PYRIC_EXPERIMENT_RUN_ID: 'partial-run' }, stdout: 'pipe', stderr: 'pipe',
        });
        expect(await proc.exited).toBe(0);
        const result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8'));
        expect(result.run.interrupted).toBe(true);
        expect(result.events).toEqual([event]);
        expect(result.cases).toHaveLength(0);
        expect(assess(result).successfulExperiment).toBe(false);
        expect(await readFile(join(out, 'provider-observations.ndjson'), 'utf8')).toContain('accepted');
    } finally { await rm(out, { recursive: true, force: true }); }
});
