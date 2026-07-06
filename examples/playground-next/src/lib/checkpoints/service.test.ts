/**
 * W3.1 — checkpoint service + workspace_checkpoints tool + auto-commit on
 * green, headless over the in-memory VFS (the same adapter the real file
 * tools and the W1 runner use outside a browser).
 *
 * Includes the wave gate from workstation-benchmarks.md §3d: the
 * LOSSLESS-ROLLBACK PROPERTY — post-revert, every file tracked at the
 * target checkpoint is byte-identical to that checkpoint's tree, files
 * tracked since are gone, and untracked files are left alone.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import * as git from 'isomorphic-git';

import { RULES_PATH, WORKSPACE_ROOT } from '~/lib/store/files';
import { runWorkspaceTestsHandler, TESTS_DIR } from '~/lib/tools/core/runWorkspaceTests';
import type { RunWorkspaceTestsData } from '~/lib/tools/core/runWorkspaceTests';
import { getVFS, resetVFS } from '~/lib/vfs';
import {
  commitCheckpoint,
  ensureRepo,
  listCheckpoints,
  revertToCheckpoint,
} from './service';
import { workspaceCheckpointsHandler } from './tool';

const DIR = WORKSPACE_ROOT;

async function writeText(path: string, content: string): Promise<void> {
  const vfs = getVFS();
  await vfs.promises.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await vfs.promises.writeFile(path, content);
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  const vfs = getVFS();
  await vfs.promises.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await vfs.promises.writeFile(path, bytes);
}

async function readBytes(path: string): Promise<Uint8Array> {
  const v = await getVFS().promises.readFile(path);
  return typeof v === 'string' ? new TextEncoder().encode(v) : v;
}

async function exists(path: string): Promise<boolean> {
  try {
    await getVFS().promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under /workspace except the .git tree. */
async function walkWorkspaceFiles(dir = DIR): Promise<string[]> {
  const vfs = getVFS();
  const out: string[] = [];
  const entries = (await vfs.promises.readdir(dir)) as string[];
  for (const name of entries) {
    if (dir === DIR && name === '.git') continue;
    const full = `${dir}/${name}`;
    const st = await vfs.promises.stat(full);
    if (st.isDirectory()) out.push(...(await walkWorkspaceFiles(full)));
    else out.push(full);
  }
  return out.sort();
}

const fsArg = () => ({ promises: getVFS().promises });

beforeEach(() => {
  resetVFS(); // fresh in-memory workspace per test
});

describe('ensureRepo', () => {
  test('initializes once and is idempotent — re-running never clobbers history', async () => {
    await ensureRepo();
    expect(await exists(`${DIR}/.git/HEAD`)).toBe(true);
    await writeText(`${DIR}/a.txt`, 'one');
    const sha = await commitCheckpoint('first');
    expect(sha).toBeTruthy();
    await ensureRepo(); // must be a no-op on an existing repo
    const after = await listCheckpoints();
    expect(after.map((c) => c.sha)).toEqual([sha!]);
  });
});

describe('commitCheckpoint', () => {
  test('commits staged-all changes with the checkpoint prefix and returns the sha', async () => {
    await writeText(`${DIR}/a.txt`, 'hello');
    const sha = await commitCheckpoint('tests green: 2/2');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const { commit } = await git.readCommit({ fs: fsArg(), dir: DIR, oid: sha! });
    expect(commit.message.trim()).toBe('checkpoint: tests green: 2/2');
    expect(commit.author.name).toBe('pyric-playground');
    expect(commit.author.email).toBe('playground@pyric.dev');
  });

  test('returns null when nothing changed (no empty checkpoints)', async () => {
    await writeText(`${DIR}/a.txt`, 'hello');
    expect(await commitCheckpoint('one')).toBeTruthy();
    expect(await commitCheckpoint('two')).toBeNull();
    // and on a brand-new empty repo
    resetVFS();
    expect(await commitCheckpoint('empty')).toBeNull();
  });
});

describe('listCheckpoints', () => {
  test('newest first, filters non-checkpoint commits, respects limit', async () => {
    await writeText(`${DIR}/a.txt`, 'v1');
    const c1 = await commitCheckpoint('first');
    // a user commit through plain isomorphic-git plumbing — not a checkpoint
    await writeText(`${DIR}/a.txt`, 'v2');
    await git.add({ fs: fsArg(), dir: DIR, filepath: 'a.txt' });
    await git.commit({
      fs: fsArg(),
      dir: DIR,
      message: 'user: manual save',
      author: { name: 'u', email: 'u@x' },
    });
    await writeText(`${DIR}/a.txt`, 'v3');
    const c2 = await commitCheckpoint('second');

    const all = await listCheckpoints();
    expect(all.map((c) => c.sha)).toEqual([c2!, c1!]);
    expect(all.map((c) => c.label)).toEqual(['second', 'first']);
    expect(all[0]!.when).toBeGreaterThan(0);

    const limited = await listCheckpoints(1);
    expect(limited.map((c) => c.label)).toEqual(['second']);
  });

  test('empty repo → empty list (no throw)', async () => {
    expect(await listCheckpoints()).toEqual([]);
  });
});

describe('revertToCheckpoint', () => {
  test('LOSSLESS ROLLBACK PROPERTY — post-revert tracked tree is byte-identical to the checkpoint', async () => {
    // 1. Build a green state: multi-byte UTF-8, nested paths, raw binary bytes.
    await writeText(RULES_PATH, "rules_version = '2'; // héllo — ✓\n");
    await writeText(`${DIR}/src/App.tsx`, 'export default function App() { return <p>v1</p>; }\n');
    const binary = new Uint8Array([0, 1, 2, 3, 255, 254, 128, 64, 10, 13, 0, 42]);
    await writeBytes(`${DIR}/data.bin`, binary);
    const c1 = await commitCheckpoint('tests green: 3/3');
    expect(c1).toBeTruthy();

    // 2. Wreck it: mutate, delete, add — and checkpoint the wreckage so the
    //    added file is TRACKED (the hard case for revert).
    await writeText(`${DIR}/src/App.tsx`, 'export default function App() { return <p>BROKEN</p>; }\n');
    await getVFS().promises.unlink(`${DIR}/data.bin`);
    await writeText(`${DIR}/extra.txt`, 'added after the green state');
    const c2 = await commitCheckpoint('tests green: 1/1');
    expect(c2).toBeTruthy();

    // 3. Revert to the green checkpoint.
    const result = await revertToCheckpoint(c1!);
    expect(result.restored).toBe(c1!);

    // 4. Property: every file tracked at c1 is byte-identical in the workdir.
    const tracked = await git.listFiles({ fs: fsArg(), dir: DIR, ref: c1! });
    expect(tracked.length).toBe(3);
    for (const filepath of tracked) {
      const { blob } = await git.readBlob({ fs: fsArg(), dir: DIR, oid: c1!, filepath });
      const onDisk = await readBytes(`${DIR}/${filepath}`);
      expect(Buffer.from(onDisk).equals(Buffer.from(blob))).toBe(true);
    }
    // Tracked-then-added file is gone; no stray files remain at all.
    expect(await exists(`${DIR}/extra.txt`)).toBe(false);
    const onDiskFiles = await walkWorkspaceFiles();
    expect(onDiskFiles).toEqual(tracked.map((f) => `${DIR}/${f}`).sort());

    // 5. Append-only history: the revert is itself a new checkpoint…
    expect(result.commit).toBeTruthy();
    const latest = await listCheckpoints();
    expect(latest[0]!.sha).toBe(result.commit!);
    expect(latest[0]!.label).toBe(`revert to ${c1!.slice(0, 7)}`);
    // …so the wreckage is still reachable and the revert can be reverted.
    const back = await revertToCheckpoint(c2!);
    expect(await exists(`${DIR}/extra.txt`)).toBe(true);
    expect(await exists(`${DIR}/data.bin`)).toBe(false);
    expect(back.commit).toBeTruthy();
  });

  test('reverting to the current state is a no-op (no marker commit)', async () => {
    await writeText(`${DIR}/a.txt`, 'stable');
    const c1 = await commitCheckpoint('green');
    const result = await revertToCheckpoint(c1!);
    expect(result.restored).toBe(c1!);
    expect(result.commit).toBeNull();
  });

  test('leaves untracked files alone', async () => {
    await writeText(`${DIR}/a.txt`, 'v1');
    const c1 = await commitCheckpoint('green');
    await writeText(`${DIR}/a.txt`, 'v2');
    await commitCheckpoint('second green');
    // Never committed before the revert — must survive it untouched.
    await writeText(`${DIR}/notes.txt`, 'scratch work in flight');
    await revertToCheckpoint(c1!);
    expect(new TextDecoder().decode(await readBytes(`${DIR}/a.txt`))).toBe('v1');
    expect(new TextDecoder().decode(await readBytes(`${DIR}/notes.txt`))).toBe(
      'scratch work in flight',
    );
  });

  test('unknown sha → actionable error', async () => {
    await writeText(`${DIR}/a.txt`, 'x');
    await commitCheckpoint('green');
    expect(revertToCheckpoint('deadbeef')).rejects.toThrow(/No commit found for "deadbeef"/);
  });

  test('accepts abbreviated shas', async () => {
    await writeText(`${DIR}/a.txt`, 'v1');
    const c1 = await commitCheckpoint('green');
    await writeText(`${DIR}/a.txt`, 'v2');
    await commitCheckpoint('second');
    const result = await revertToCheckpoint(c1!.slice(0, 7));
    expect(result.restored).toBe(c1!);
    expect(new TextDecoder().decode(await readBytes(`${DIR}/a.txt`))).toBe('v1');
  });
});

// ── auto-commit on green (runWorkspaceTests integration) ───────────────────

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{d}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.owner;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
    }
  }
}`;

const GREEN_SUITE = JSON.stringify({
  seed: [{ path: 'notes/n1', data: { owner: 'alice' } }],
  cases: [
    { as: { uid: 'alice' }, do: { method: 'get', path: 'notes/n1' }, expect: 'ALLOW' },
    { as: { uid: 'bob' }, do: { method: 'get', path: 'notes/n1' }, expect: 'DENY' },
  ],
});

const RED_SUITE = JSON.stringify({
  seed: [{ path: 'notes/n1', data: { owner: 'alice' } }],
  cases: [{ as: null, do: { method: 'get', path: 'notes/n1' }, expect: 'ALLOW' }],
});

describe('auto-commit on green test runs', () => {
  test('a green suite checkpoints the workspace; an unchanged re-run does not', async () => {
    await writeText(RULES_PATH, RULES);
    await writeText(`${TESTS_DIR}/notes.test.json`, GREEN_SUITE);
    const r = await runWorkspaceTestsHandler.execute({} as never, {} as never);
    expect(r.ok).toBe(true);
    const data = r.data as RunWorkspaceTestsData;
    expect(data.ok).toBe(true);
    expect(data.checkpoint).toBeDefined();
    expect((data.checkpoint as { sha: string }).sha).toMatch(/^[0-9a-f]{40}$/);

    const list = await listCheckpoints();
    expect(list[0]!.label).toBe('tests green: 2/2');
    expect(list[0]!.sha).toBe((data.checkpoint as { sha: string }).sha);

    // Re-run with no workspace change → green again, but no new checkpoint.
    const r2 = await runWorkspaceTestsHandler.execute({} as never, {} as never);
    const data2 = r2.data as RunWorkspaceTestsData;
    expect(data2.ok).toBe(true);
    expect(data2.checkpoint).toBeUndefined();
    expect((await listCheckpoints()).length).toBe(1);
  });

  test('a red suite never checkpoints', async () => {
    await writeText(RULES_PATH, RULES);
    await writeText(`${TESTS_DIR}/notes.test.json`, RED_SUITE);
    const r = await runWorkspaceTestsHandler.execute({} as never, {} as never);
    const data = r.data as RunWorkspaceTestsData;
    expect(data.ok).toBe(false);
    expect(data.checkpoint).toBeUndefined();
    expect(await listCheckpoints()).toEqual([]);
  });
});

// ── workspace_checkpoints tool ──────────────────────────────────────────────

describe('workspace_checkpoints tool', () => {
  test('list: empty → teaches how checkpoints appear', async () => {
    const r = await workspaceCheckpointsHandler.execute({ action: 'list' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('none yet');
  });

  test('list: returns recent checkpoints newest first', async () => {
    await writeText(`${DIR}/a.txt`, 'v1');
    await commitCheckpoint('tests green: 1/1');
    await writeText(`${DIR}/a.txt`, 'v2');
    const c2 = await commitCheckpoint('tests green: 2/2');
    const r = await workspaceCheckpointsHandler.execute({ action: 'list' }, {} as never);
    expect(r.ok).toBe(true);
    const data = r.data as { checkpoints: Array<{ sha: string; label: string }> };
    expect(data.checkpoints.length).toBe(2);
    expect(data.checkpoints[0]).toMatchObject({ sha: c2!, label: 'tests green: 2/2' });
    expect(r.summary).toContain('tests green: 2/2');
  });

  test('revert: restores the checkpoint and reports both shas', async () => {
    await writeText(`${DIR}/a.txt`, 'good');
    const c1 = await commitCheckpoint('green');
    await writeText(`${DIR}/a.txt`, 'bad');
    await commitCheckpoint('broken');
    const r = await workspaceCheckpointsHandler.execute({ action: 'revert', sha: c1! }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain(c1!.slice(0, 7));
    expect(new TextDecoder().decode(await readBytes(`${DIR}/a.txt`))).toBe('good');
  });

  test('revert: missing sha → actionable refusal', async () => {
    const r = await workspaceCheckpointsHandler.execute({ action: 'revert' }, {} as never);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('requires `sha`');
  });

  test('revert: unknown sha → ok:false with the service error', async () => {
    await writeText(`${DIR}/a.txt`, 'x');
    await commitCheckpoint('green');
    const r = await workspaceCheckpointsHandler.execute(
      { action: 'revert', sha: 'ffffffff' },
      {} as never,
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('No commit found');
  });
});
