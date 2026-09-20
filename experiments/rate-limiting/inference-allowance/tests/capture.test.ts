import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureRun, verifyCapture } from '../../../shared/evidence/capture.mjs';
import { captureDefinition } from '../capture-definition.mjs';
import { assessRun, compareRuns } from '../analysis/assess.mjs';
test('executes captured source, retains normalized evidence and rejects incomplete comparisons', async () => {
    const output = await mkdtemp(join(tmpdir(), 'allowance-capture-'));
    try {
        const saved = await captureRun(output, { definition: captureDefinition() });
        expect(saved.successfulExperiment).toBe(true);
        expect((await verifyCapture(saved.directory)).valid).toBe(true);
        const result = JSON.parse(await readFile(join(saved.directory, 'result.json'), 'utf8'));
        expect(result.run.environment.backend).toBe('pyric');
        expect(assessRun(result).successfulExperiment).toBe(true);
        expect(compareRuns(result, result).compatible).toBe(true);
        const incomplete = structuredClone(result);
        incomplete.assertions = [];
        expect(assessRun(incomplete).successfulExperiment).toBe(false);
        expect(compareRuns(incomplete, incomplete).compatible).toBe(false);
        const noCases = structuredClone(result);
        noCases.cases = [];
        expect(compareRuns(noCases, noCases).compatible).toBe(false);
        const replay = await captureRun(output, { sourceCapture: saved.directory });
        expect(replay.successfulExperiment).toBe(true);
        await writeFile(join(saved.directory, 'source/experiments/rate-limiting/inference-allowance/architecture/bucket.mjs'), '// changed');
        expect((await verifyCapture(saved.directory)).valid).toBe(false);
    }
    finally {
        await rm(output, { recursive: true, force: true });
    }
}, 20000);
test('replay executes archived Rules and fingerprints adapter changes', async () => {
    const output = await mkdtemp(join(tmpdir(), 'allowance-rules-proof-'));
    const sha = value => createHash('sha256').update(value).digest('hex');
    try {
        const saved = await captureRun(output, { definition: captureDefinition(), input: { profile: 'local', cases: ['authorization'] } });
        const original = JSON.parse(await readFile(join(saved.directory, 'result.json'), 'utf8'));
        const manifestPath = join(saved.directory, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        // Author a deliberately different test snapshot, updating its integrity hashes.
        // Integrity checks detect changes; they do not authenticate an author.
        for (const suffix of ['deployment/firestore.rules', 'adapters/pyric-store.mjs']) {
            const file = manifest.files.find(file => file.path.endsWith(suffix));
            const path = join(saved.directory, file.path);
            const previous = await readFile(path, 'utf8');
            const changed = suffix.endsWith('.rules') ? previous.replace('if false;', 'if true;') : previous + '\n// Adapter mutation fixture\n';
            await writeFile(path, changed);
            file.sha256 = sha(changed);
            file.bytes = Buffer.byteLength(changed);
        }
        manifest.sourceSnapshotHash = sha(JSON.stringify(manifest.files.filter(file => file.path.startsWith('source/'))));
        await writeFile(manifestPath, JSON.stringify(manifest));
        const replay = await captureRun(output, { sourceCapture: saved.directory });
        expect(replay.successfulExperiment).toBe(false);
        const result = JSON.parse(await readFile(join(replay.directory, 'result.json'), 'utf8'));
        expect(result.assertions.find(a => a.name === 'client quota edits denied').actual).toBe(false);
        expect(compareRuns(original, result).compatible).toBe(false);
    }
    finally {
        await rm(output, { recursive: true, force: true });
    }
}, 20000);
test('a baseline runs the same archived source with explicit local input and preserves parent evidence', async () => {
    const output = await mkdtemp(join(tmpdir(), 'allowance-baseline-'));
    try {
        const saved = await captureRun(output, { definition: captureDefinition(), input: { profile: 'local', cases: ['portable-burst'], limits: { maxRequests: 60 } } });
        const baseline = await captureRun(output, { sourceCapture: saved.directory, input: { profile: 'local', cases: ['portable-burst'], limits: { maxRequests: 3 } } });
        expect(baseline.successfulExperiment).toBe(false);
        const parentInput = JSON.parse(await readFile(join(saved.directory, 'input.json'), 'utf8'));
        const baselineInput = JSON.parse(await readFile(join(baseline.directory, 'input.json'), 'utf8'));
        expect(parentInput.limits.maxRequests).toBe(60);
        expect(baselineInput.limits.maxRequests).toBe(3);
        const parentManifest = JSON.parse(await readFile(join(saved.directory, 'manifest.json'), 'utf8'));
        const manifest = JSON.parse(await readFile(join(baseline.directory, 'manifest.json'), 'utf8'));
        expect(manifest.sourceSnapshotHash).toBe(parentManifest.sourceSnapshotHash);
        expect(manifest.parentRunId).toBe(parentManifest.runId);
        expect(manifest.inputOverridden).toBe(true);
    }
    finally {
        await rm(output, { recursive: true, force: true });
    }
}, 20000);
test('comparison retains measured outcomes and environment differences without claiming performance parity', async () => {
    const output = await mkdtemp(join(tmpdir(), 'allowance-comparison-'));
    try {
        const saved = await captureRun(output, { definition: captureDefinition(), input: { profile: 'local', cases: ['portable-burst'] } });
        const result = JSON.parse(await readFile(join(saved.directory, 'result.json'), 'utf8'));
        const report = compareRuns(result, result);
        expect(report.cohorts.left.environment.backend).toBe('pyric');
        expect(report.cohorts.left.contention[0].users.alice.charged).toBe(5);
        expect(report.cohorts.left.contention[0].users.bob.completed).toBe(5);
        expect(report.performanceComparable).toBe(false);
        expect(report.decisions.every(d => 'leftActual' in d && 'rightActual' in d)).toBe(true);
    }
    finally {
        await rm(output, { recursive: true, force: true });
    }
}, 20000);
test('interrupted execution retains a verifiable incomplete capture and cannot pass comparison', async () => {
    const output = await mkdtemp(join(tmpdir(), 'allowance-interrupted-'));
    try {
        const saved = await captureRun(output, { definition: captureDefinition(), input: { profile: 'local', cases: ['portable-burst'] } });
        const manifestPath = join(saved.directory, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const file = manifest.files.find(f => f.path.endsWith('/execute.mjs'));
        const path = join(saved.directory, file.path);
        const previous = await readFile(path, 'utf8');
        const changed = `if (!process.argv.includes('--recover')) process.exit(7);\n` + previous;
        const sha = value => createHash('sha256').update(value).digest('hex');
        await writeFile(path, changed);
        file.sha256 = sha(changed);
        file.bytes = Buffer.byteLength(changed);
        manifest.sourceSnapshotHash = sha(JSON.stringify(manifest.files.filter(f => f.path.startsWith('source/'))));
        await writeFile(manifestPath, JSON.stringify(manifest));
        const interrupted = await captureRun(output, { sourceCapture: saved.directory });
        expect(interrupted.successfulExperiment).toBe(false);
        expect((await verifyCapture(interrupted.directory)).valid).toBe(true);
        const result = JSON.parse(await readFile(join(interrupted.directory, 'result.json'), 'utf8'));
        expect(result.execution.status).toBe('incomplete');
        expect(compareRuns(result, result).compatible).toBe(false);
    }
    finally {
        await rm(output, { recursive: true, force: true });
    }
}, 20000);
