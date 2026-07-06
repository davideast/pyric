/** W1.2 — run_workspace_tests over the in-memory VFS (headless). */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getVFS, resetVFS } from '~/lib/vfs';
import { RULES_PATH } from '~/lib/store/files';
import { runWorkspaceTestsHandler, TESTS_DIR } from './runWorkspaceTests';
import type { TestRunReport } from '~/lib/workspace-tests/runner';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{d}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.owner;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
      allow list: if request.auth != null;
    }
  }
}`;

async function writeVfs(path: string, content: string): Promise<void> {
  const vfs = getVFS();
  const dir = path.slice(0, path.lastIndexOf('/'));
  await vfs.promises.mkdir(dir, { recursive: true });
  await vfs.promises.writeFile(path, content);
}

beforeEach(() => {
  resetVFS();
});

afterEach(() => {
  resetVFS();
});

describe('run_workspace_tests tool', () => {
  test('no ruleset → actionable refusal', async () => {
    const r = await runWorkspaceTestsHandler.execute({} as never, {} as never);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('no /workspace/firestore.rules');
  });

  test('runs the suite from the VFS and reports one compact result', async () => {
    await writeVfs(RULES_PATH, RULES);
    await writeVfs(
      `${TESTS_DIR}/notes.test.json`,
      JSON.stringify({
        seed: [{ path: 'notes/n1', data: { owner: 'alice', body: 'hi' } }],
        cases: [
          { as: { uid: 'alice' }, do: { method: 'get', path: 'notes/n1' }, expect: 'ALLOW' },
          { as: { uid: 'bob' }, do: { method: 'get', path: 'notes/n1' }, expect: 'DENY' },
          { as: { uid: 'alice' }, do: { method: 'list', path: 'notes' }, expect: 'ALLOW' },
          { as: null, do: { method: 'create', path: 'notes/n2', data: { owner: 'x' } }, expect: 'DENY' },
        ],
      }),
    );
    const r = await runWorkspaceTestsHandler.execute({} as never, {} as never);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('4/4 passed');
    const data = r.data as TestRunReport;
    expect(data.ok).toBe(true);
    expect(data.files[0]!.file).toBe('notes.test.json');
  });

  test('a failing case surfaces the file in the summary', async () => {
    await writeVfs(RULES_PATH, RULES);
    await writeVfs(
      `${TESTS_DIR}/broken.test.json`,
      JSON.stringify({
        cases: [{ as: null, do: { method: 'list', path: 'notes' }, expect: 'ALLOW' }],
      }),
    );
    const r = await runWorkspaceTestsHandler.execute({} as never, {} as never);
    expect(r.ok).toBe(true); // the RUN succeeded; the suite has failures
    const data = r.data as TestRunReport;
    expect(data.ok).toBe(false);
    expect(r.summary).toContain('broken.test.json');
  });
});
