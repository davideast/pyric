/** W2.1 — `bash` tool over the in-memory VFS (headless). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { resetAgentShell } from '~/lib/agent-shell';
import { RULES_PATH } from '~/lib/store/files';
import { getVFS, resetVFS } from '~/lib/vfs';

import { bashHandler, type BashToolData } from './bash';
import { TESTS_DIR } from './runWorkspaceTests';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{d}/documents {
    match /notes/{id} {
      allow read, create: if request.auth != null;
    }
  }
}`;

async function writeVfs(path: string, content: string): Promise<void> {
  const vfs = getVFS();
  const dir = path.slice(0, path.lastIndexOf('/'));
  await vfs.promises.mkdir(dir, { recursive: true });
  await vfs.promises.writeFile(path, content);
}

function run(command: string) {
  return bashHandler.execute({ command }, {} as never);
}

beforeAll(async () => {
  resetVFS();
  resetAgentShell();
  await writeVfs(RULES_PATH, RULES);
  await writeVfs(
    `${TESTS_DIR}/notes.test.json`,
    JSON.stringify({
      cases: [
        { as: { uid: 'alice' }, do: { method: 'get', path: 'notes/n1' }, expect: 'ALLOW' },
        { as: null, do: { method: 'get', path: 'notes/n1' }, expect: 'DENY' },
      ],
    }),
  );
});

afterAll(() => {
  resetVFS();
  resetAgentShell();
});

describe('bash tool', () => {
  test('runs a command and returns stdout/exitCode/cwd', async () => {
    const r = await run('echo hi');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('exit 0');
    const data = r.data as BashToolData;
    expect(data.stdout).toBe('hi\n');
    expect(data.exitCode).toBe(0);
    expect(data.cwd).toBe('/workspace');
  });

  test('non-zero exit is evidence, not a tool failure', async () => {
    const r = await run('false');
    expect(r.ok).toBe(true);
    expect((r.data as BashToolData).exitCode).toBe(1);
    expect(r.summary).toContain('exit 1');
  });

  test('empty command is rejected', async () => {
    const r = await run('  ');
    expect(r.ok).toBe(false);
    expect((r.data as BashToolData).exitCode).toBe(2);
  });

  test('cwd persists across tool calls (one shared session)', async () => {
    await run('mkdir -p deep/dir && cd deep/dir');
    const r = await run('pwd');
    expect((r.data as BashToolData).stdout.trim()).toBe('/workspace/deep/dir');
    expect((r.data as BashToolData).cwd).toBe('/workspace/deep/dir');
    await run('cd /workspace');
  });

  test('builtins are reachable through the tool', async () => {
    const man = await run('man shell');
    expect((man.data as BashToolData).stdout).toContain('Workspace-jailed');
    const tests = await run('test');
    const data = tests.data as BashToolData;
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain('2/2 passed');
  });

  test('large output is capped with a truncation note', async () => {
    const r = await run('seq 1 10000');
    const data = r.data as BashToolData;
    expect(data.truncated).toBe(true);
    expect(data.stdout).toContain('truncated');
    expect(data.stdout.length).toBeLessThan(17_000);
    expect(r.summary).toContain('output truncated');
  });
});
