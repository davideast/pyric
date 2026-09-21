import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRun, verifyCapture } from '../../../shared/evidence/capture.mjs';

test('retains executed source with evidence and detects snapshot tampering', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pixel-capture-'));
  try {
    const { directory } = await captureRun(output);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    expect(manifest.execution).toBe('copied-source');
    expect(manifest.runId).toBe(result.run.id);
    expect(manifest.files.some((f: any) => f.path.endsWith('architecture/pixels.mjs'))).toBe(true);
    expect((await verifyCapture(directory)).valid).toBe(true);
    const replay = await captureRun(output, { sourceCapture: directory });
    const replayManifest = JSON.parse(await readFile(join(replay.directory, 'manifest.json'), 'utf8'));
    expect(replay.successfulExperiment).toBe(true);
    expect(replayManifest.parentRunId).toBe(manifest.runId);
    expect(replayManifest.sourceSnapshotHash).toBe(manifest.sourceSnapshotHash);
    const source = manifest.files.find((f: any) => f.path.endsWith('architecture/pixels.mjs'));
    await writeFile(join(directory, source.path), '// changed after execution\n');
    expect((await verifyCapture(directory)).valid).toBe(false);
    await expect(captureRun(output, { sourceCapture: directory })).rejects.toThrow('Snapshot verification failed');
  } finally { await rm(output, { recursive: true, force: true }); }
}, 20000);


test('replay executes archived architecture rather than current working code', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pixel-source-proof-'));
  const sha = value => createHash('sha256').update(value).digest('hex');
  try {
    const original = await captureRun(output);
    const path = join(original.directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const file = manifest.files.find((file: any) => file.path.endsWith('architecture/pixels.mjs'));
    const sourcePath = join(original.directory, file.path);
    const changed = (await readFile(sourcePath, 'utf8')).replace('data.grid[index] = color;', "data.grid[index] = 'purple';");
    // Deliberately build a different test snapshot with matching integrity hashes.
    // This is fixture authoring, not a claim that hashes authenticate a publisher.
    await writeFile(sourcePath, changed);
    file.sha256 = sha(changed); file.bytes = Buffer.byteLength(changed);
    manifest.sourceSnapshotHash = sha(JSON.stringify(manifest.files.filter((file: any) => file.path.startsWith('source/'))));
    await writeFile(path, JSON.stringify(manifest));
    const replay = await captureRun(output, { sourceCapture: original.directory });
    expect(replay.successfulExperiment).toBe(false);
    const result = JSON.parse(await readFile(join(replay.directory, 'result.json'), 'utf8'));
    expect(result.assertions.find((a: any) => a.caseId === 'transaction-grid' && a.name === 'distinct edits survive').actual).toEqual(['purple', 'purple']);
  } finally { await rm(output, { recursive: true, force: true }); }
}, 20000);

test('older saved source remains replayable after adding scenarios to the current harness', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pixel-legacy-replay-'));
  try {
    const old = join(output, 'synthetic-legacy-capture');
    await mkdir(old);
    await cp(fileURLToPath(new URL('./fixtures/legacy-replay/source/', import.meta.url)), join(old, 'source'), { recursive: true });
    // Author a synthetic capture around the old source; retain no historical
    // execution data or environment metadata in the public repository.
    const artifacts = {
      'result.json': JSON.stringify({ run: { id: 'synthetic-legacy-replay' } }),
      'assessment.json': '{}', 'workload.json': '{}',
      'firestore.rules': await readFile(join(old, 'source/experiments/multiplayer/pixel-together/architecture/firestore.rules'), 'utf8'),
      'findings.md': 'Synthetic compatibility fixture, not experiment evidence.\n',
    };
    for (const [name, text] of Object.entries(artifacts)) await writeFile(join(old, name), text);
    const files: { path: string; sha256: string; bytes: number }[] = [];
    async function collect(relative = '') {
      for (const entry of (await readdir(join(old, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(path);
        else { const bytes = await readFile(join(old, path)); files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
      }
    }
    await collect();
    await writeFile(join(old, 'manifest.json'), JSON.stringify({
      formatVersion: 1, execution: 'copied-source', runId: 'synthetic-legacy-replay',
      gitRevision: 'synthetic-compatibility-fixture', files,
      sourceSnapshotHash: createHash('sha256').update(JSON.stringify(files.filter(file => file.path.startsWith('source/')))).digest('hex'),
    }));
    expect((await verifyCapture(old)).valid).toBe(true);
    const replay = await captureRun(output, { sourceCapture: old });
    expect(replay.successfulExperiment).toBe(true);
    const result = JSON.parse(await readFile(join(replay.directory, 'result.json'), 'utf8'));
    expect(result.cases.length).toBe(8);
  } finally { await rm(output, { recursive: true, force: true }); }
}, 20000);
