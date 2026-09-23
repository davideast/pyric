import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostedPersistence, hostedStateDirectory, loadHostedSnapshot } from '../../../src/serve/hosted/persistence.js';
import { createSandboxSession } from '../../../src/serve/sandbox-session.js';
import { runSnapshot } from '../../../src/cli/snapshot.js';

const root = process.argv[2];
const MiB = 1024 * 1024;
const bucket = 'pyric-default';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const metadata = (fullPath: string, size: number, contentType = 'audio/wav') => ({
  bucket, fullPath, name: fullPath.slice(fullPath.lastIndexOf('/') + 1), size, generation: '1', metageneration: '1',
  timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType,
});

/** A state document's Storage entry: a reference to bytes beside the document. */
interface Reference { path: string; sha256: string; size: number; blobType: string; metadata: { fullPath: string; size: number } }

function snapshot(project: string, out: string): { code: Promise<number>; messages: string[] } {
  const messages: string[] = [];
  const write = (value: string) => { messages.push(value); };
  const code = runSnapshot({ subcommand: 'snapshot', positional: [], flags: new Map([['out', out]]) }, {
    cwd: project, stdout: { write }, stderr: { write }, fetchLive: async () => null,
  });
  return { code, messages };
}

// A store whose objects total more than one JSON string could carry exports
// every object as a reference, reading none of their bytes.
{
  const project = mkdtempSync(join(root, 'large-'));
  (await createHostedPersistence(project)).close();
  const each = 200 * MiB;
  const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'));
  const insert = database.prepare('INSERT INTO storage_objects (bucket, path, metadata, mime, sha256, size) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [name, hash] of [['a.wav', 'a'.repeat(64)], ['b.wav', 'b'.repeat(64)]]) {
    const shard = join(hostedStateDirectory(project), 'objects', hash.slice(0, 2));
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, hash), '');
    truncateSync(join(shard, hash), each);
    insert.run(bucket, `narrations/${name}`, JSON.stringify(metadata(`narrations/${name}`, each)), 'audio/wav', hash, each);
  }
  database.close();
  const rssBefore = process.memoryUsage().rss;
  const state = await loadHostedSnapshot(project);
  const growth = process.memoryUsage().rss - rssBefore;
  assert.ok(growth < 64 * MiB, `the export read no object bytes (rss grew ${(growth / MiB).toFixed(1)} MiB)`);
  const storage = state!.storage as unknown as Reference[];
  assert.deepEqual(storage.map(entry => ({ path: entry.path, sha256: entry.sha256, size: entry.size, blobType: entry.blobType })), [
    { path: 'narrations/a.wav', sha256: 'a'.repeat(64), size: each, blobType: 'audio/wav' },
    { path: 'narrations/b.wav', sha256: 'b'.repeat(64), size: each, blobType: 'audio/wav' },
  ]);
  assert.equal(JSON.stringify(state).includes('dataBase64'), false);
  const persistence = await createHostedPersistence(project);
  try {
    assert.deepEqual(persistence.state.readSection('storage'), state!.storage);
  } finally { persistence.close(); }
}

// `pyric snapshot` writes a directory: state.json with references, and objects/.
const source = mkdtempSync(join(root, 'source-'));
const take = new Uint8Array(3 * MiB).map((_, index) => index % 251);
const note = new TextEncoder().encode('a short note');
{
  const persistence = await createHostedPersistence(source);
  await persistence.storage.put('media/take.wav', new Blob([take], { type: 'audio/wav' }), metadata('media/take.wav', take.byteLength));
  await persistence.storage.put('notes/note.txt', new Blob([note], { type: 'text/plain' }), metadata('notes/note.txt', note.byteLength, 'text/plain'));
  persistence.close();
}
const out = join(source, 'fixture');
{
  const run = snapshot(source, out);
  assert.equal(await run.code, 0, run.messages.join(''));
  const document = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8'));
  const storage = document.storage as Reference[];
  assert.deepEqual(storage.map(entry => [entry.path, entry.sha256, entry.size]), [
    ['media/take.wav', sha256(take), take.byteLength],
    ['notes/note.txt', sha256(note), note.byteLength],
  ]);
  for (const [entry, bytes] of [[storage[0], take], [storage[1], note]] as const) {
    const file = join(out, 'objects', entry.sha256.slice(0, 2), entry.sha256);
    assert.ok(Buffer.from(readFileSync(file)).equals(Buffer.from(bytes)), entry.path);
  }
  assert.match(run.messages.join(''), /pyric sandbox --seed/);
}

// A hosted session seeded from that directory holds the same objects, in its own files.
{
  const project = mkdtempSync(join(root, 'seeded-'));
  const sdk = join(project, 'sdk');
  mkdirSync(sdk, { recursive: true });
  const session = await createSandboxSession({ projectDir: project, firebaseConfig: null, sdk: { dir: sdk }, hosted: true, capture: false, seedFile: out });
  await session.close();
  const persistence = await createHostedPersistence(project);
  try {
    const blob = await persistence.storage.getBlob('media/take.wav', bucket);
    assert.ok(Buffer.from(await blob!.arrayBuffer()).equals(Buffer.from(take)));
    assert.equal(blob!.type, 'audio/wav');
    assert.equal(await (await persistence.storage.getBlob('notes/note.txt', bucket))?.text(), 'a short note');
    assert.ok(existsSync(join(hostedStateDirectory(project), 'objects', sha256(take).slice(0, 2), sha256(take))));
  } finally { persistence.close(); }
}

// A seed whose referenced file does not hash to its name is refused, and nothing is written.
{
  const damaged = mkdtempSync(join(root, 'damaged-seed-'));
  const copy = join(damaged, 'fixture');
  mkdirSync(copy);
  writeFileSync(join(copy, 'state.json'), readFileSync(join(out, 'state.json')));
  const takeHash = sha256(take);
  mkdirSync(join(copy, 'objects', takeHash.slice(0, 2)), { recursive: true });
  writeFileSync(join(copy, 'objects', takeHash.slice(0, 2), takeHash), take);
  const hash = sha256(note);
  mkdirSync(join(copy, 'objects', hash.slice(0, 2)), { recursive: true });
  writeFileSync(join(copy, 'objects', hash.slice(0, 2), hash), 'not the note');
  const project = mkdtempSync(join(root, 'refused-'));
  const sdk = join(project, 'sdk');
  mkdirSync(sdk, { recursive: true });
  await assert.rejects(
    createSandboxSession({ projectDir: project, firebaseConfig: null, sdk: { dir: sdk }, hosted: true, capture: false, seedFile: copy }),
    /does not match|hash/,
  );
  const persistence = await createHostedPersistence(project);
  try {
    assert.equal(await persistence.storage.getMetadata('media/take.wav', bucket), undefined);
  } finally { persistence.close(); }
}

console.log('State references passed');
