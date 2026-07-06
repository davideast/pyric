/** W1.4 — checkpoint-on-green parity for the `run-tests` builtin: a green
 *  full-suite run commits a checkpoint exactly like the
 *  run_workspace_tests tool (best-effort, one stdout note, no-op silent);
 *  red and pattern-filtered runs never checkpoint. Headless over the
 *  in-memory VFS. */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { listCheckpoints } from '~/lib/checkpoints/service';
import { RULES_PATH } from '~/lib/store/files';
import { TESTS_DIR } from '~/lib/tools/core/runWorkspaceTests';
import { getVFS, resetVFS } from '~/lib/vfs';

import { createAgentShell, resetAgentShell, type AgentShell } from './session';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{d}/documents {
    match /notes/{id} {
      allow get: if request.auth != null && request.auth.uid == resource.data.owner;
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
  cases: [{ as: null, do: { method: 'get', path: 'notes/n1' }, expect: 'ALLOW' }],
});

async function writeVfs(path: string, content: string): Promise<void> {
  const vfs = getVFS();
  await vfs.promises.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await vfs.promises.writeFile(path, content);
}

let shell: AgentShell;

beforeEach(async () => {
  resetVFS();
  resetAgentShell();
  await writeVfs(RULES_PATH, RULES);
  shell = createAgentShell();
});

afterAll(() => {
  resetVFS();
  resetAgentShell();
});

describe('run-tests builtin — checkpoint on green (W1.4)', () => {
  test('green full-suite run → checkpoint committed + one-line stdout note', async () => {
    await writeVfs(`${TESTS_DIR}/notes.test.json`, GREEN_SUITE);
    const r = await shell.exec('test');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/checkpoint [0-9a-f]{7}\n$/);
    const cps = await listCheckpoints();
    expect(cps.length).toBe(1);
    expect(cps[0]!.label).toBe('tests green: 2/2 (run-tests)');
    // The stdout short sha is the committed checkpoint.
    expect(r.stdout).toContain(`checkpoint ${cps[0]!.sha.slice(0, 7)}`);
  });

  test('red run → no checkpoint, no note', async () => {
    await writeVfs(`${TESTS_DIR}/red.test.json`, RED_SUITE);
    const r = await shell.exec('test');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain('checkpoint');
    expect(await listCheckpoints()).toEqual([]);
  });

  test('pattern-filtered green run → no checkpoint (partial green is not known-good)', async () => {
    await writeVfs(`${TESTS_DIR}/notes.test.json`, GREEN_SUITE);
    await writeVfs(`${TESTS_DIR}/red.test.json`, RED_SUITE);
    const r = await shell.exec('test notes');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('checkpoint');
    expect(await listCheckpoints()).toEqual([]);
  });

  test('second green run with an unchanged tree → no-op, no note', async () => {
    await writeVfs(`${TESTS_DIR}/notes.test.json`, GREEN_SUITE);
    const first = await shell.exec('test');
    expect(first.stdout).toContain('checkpoint');
    const second = await shell.exec('test');
    expect(second.exitCode).toBe(0);
    expect(second.stdout).not.toContain('checkpoint');
    expect((await listCheckpoints()).length).toBe(1);
  });

  test('checkpoint note composes with && chains', async () => {
    await writeVfs(`${TESTS_DIR}/notes.test.json`, GREEN_SUITE);
    const r = await shell.exec('test && echo green');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/checkpoint [0-9a-f]{7}/);
    expect(r.stdout).toContain('green');
  });
});
