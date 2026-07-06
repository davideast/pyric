/** write_file auto-resolves `2+modules` rulesets so the deployed/evaluated
 *  ruleset is inlined while the VFS file keeps the authored modular source,
 *  and (C1) runs host-side validation gates post-write — report, never block. */
import { describe, test, expect, afterEach } from 'bun:test';
import { writeFileHandler } from './writeFile';
import { getVFS, resetVFS } from '~/lib/vfs';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { RULES_PATH } from '~/lib/store/files';
import { disposeRunner } from '~/lib/sandbox/runner';

const MODULAR = `rules_version = '2+modules';
import { isAuthenticated, isOwner } from 'auth';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tasks/{id} {
      allow read: if isAuthenticated();
      allow write: if isOwner(resource.data.ownerId);
    }
  }
}`;

const PLAIN = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /pub/{id} { allow read: if true; }
  }
}`;

afterEach(() => {
  resetVFS();
  useWorkspaceStore.getState().setRules('');
  disposeRunner();
});

const ctx = {} as never;

describe('write_file — 2+modules resolution', () => {
  test('modular rules: VFS keeps authored source, store gets resolved', async () => {
    const res = await writeFileHandler.execute({ path: RULES_PATH, content: MODULAR }, ctx);
    expect(res.ok).toBe(true);
    expect(res.summary).toContain('inlined');
    // VFS file = authored modular source (so the agent re-reads what it wrote)
    const onDisk = (await getVFS().promises.readFile(RULES_PATH, 'utf8')) as string;
    expect(onDisk).toContain("'2+modules'");
    expect(onDisk).toContain('import {');
    // workspace store (→ deploy + oracle) = resolved plain-v2, no imports
    const deployed = useWorkspaceStore.getState().rules;
    expect(deployed).toContain("rules_version = '2'");
    expect(deployed).not.toContain("'2+modules'");
    expect(/^\s*import /m.test(deployed)).toBe(false);
  });

  test('a bad module import → ok:false; the store keeps the last-good ruleset', async () => {
    // Establish a known-good deployed ruleset first.
    await writeFileHandler.execute({ path: RULES_PATH, content: PLAIN }, ctx);
    expect(useWorkspaceStore.getState().rules).toBe(PLAIN);

    const broken = `rules_version = '2+modules';\nimport { nope } from 'does_not_exist';\nservice cloud.firestore { match /databases/{db}/documents { match /x/{i} { allow read: if nope(); } } }`;
    const res = await writeFileHandler.execute({ path: RULES_PATH, content: broken }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('module resolution failed');
    // The VFS file holds the broken source for the agent to re-read and fix…
    const onDisk = (await getVFS().promises.readFile(RULES_PATH, 'utf8')) as string;
    expect(onDisk).toContain('does_not_exist');
    // …but the deployed/evaluated ruleset is NOT replaced by un-evaluatable
    // source — the last-good rules stay live while the agent repairs the import.
    expect(useWorkspaceStore.getState().rules).toBe(PLAIN);
  });

  test('plain v2 rules pass through unchanged', async () => {
    const res = await writeFileHandler.execute({ path: RULES_PATH, content: PLAIN }, ctx);
    expect(res.ok).toBe(true);
    expect(res.summary).not.toContain('inlined');
    expect(useWorkspaceStore.getState().rules).toBe(PLAIN);
  });

  test('non-rules files are never touched by the resolver', async () => {
    const src = `rules_version = '2+modules';\n// not actually a rules file path`;
    const res = await writeFileHandler.execute({ path: '/workspace/src/notes.txt', content: src }, ctx);
    expect(res.ok).toBe(true);
    expect(res.summary).not.toContain('inlined');
  });
});

// ─── C1 — host-side validation gates on write_file ───────────────────

describe('write_file — host validation gates (C1)', () => {
  test('clean rules write → validation block present with empty arrays + clean summary', async () => {
    const res = await writeFileHandler.execute({ path: RULES_PATH, content: PLAIN }, ctx);
    expect(res.ok).toBe(true);
    const v = res.data?.validation;
    expect(v).toBeDefined();
    expect(v?.gateError).toBeUndefined();
    expect(v?.lint).toEqual([]);
    expect(v?.regressions).toEqual([]);
    expect(v?.stillDenied).toEqual([]);
    expect(res.summary).toContain('validation clean');
  });

  test('broken rules (parse error) → reported in validation.lint, write STILL lands (report, never block)', async () => {
    const res = await writeFileHandler.execute(
      { path: RULES_PATH, content: 'service cloud.firestore { broken {{' },
      ctx,
    );
    // The write itself succeeded — gates report, they don't block.
    expect(res.ok).toBe(true);
    const v = res.data?.validation;
    expect((v?.lint?.length ?? 0) > 0).toBe(true);
    expect(v?.lint?.[0]).toContain('parse error');
    expect(res.summary).toContain('lint');
    // The VFS file holds what the agent wrote, so it can re-read + fix.
    const onDisk = (await getVFS().promises.readFile(RULES_PATH, 'utf8')) as string;
    expect(onDisk).toContain('broken');
  });

  test('lint-warning rules → warnings surfaced, ok stays true', async () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /docs/{id} {
      allow read: if resource.data.title.toLowerCase() == 'x';
    }
  }
}`;
    const res = await writeFileHandler.execute({ path: RULES_PATH, content: src }, ctx);
    expect(res.ok).toBe(true);
    expect((res.data?.validation?.lint?.length ?? 0) > 0).toBe(true);
  });

  test('clean TSX write → empty compile array', async () => {
    const res = await writeFileHandler.execute(
      {
        path: '/workspace/src/components/Hello.tsx',
        content: 'export function Hello() { return <p>hi</p>; }',
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.data?.validation?.compile).toEqual([]);
    expect(res.summary).toContain('validation clean');
  });

  test('broken TSX write → compile error in validation, write still lands', async () => {
    const res = await writeFileHandler.execute(
      {
        path: '/workspace/src/components/Broken.tsx',
        content: 'export function Broken() { return <p>{x</p>; }',
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect((res.data?.validation?.compile?.length ?? 0) > 0).toBe(true);
    expect(res.summary).toContain('compile error');
    const onDisk = (await getVFS().promises.readFile(
      '/workspace/src/components/Broken.tsx',
      'utf8',
    )) as string;
    expect(onDisk).toContain('Broken');
  });

  test('non-gated paths (.txt/.css) carry no validation block', async () => {
    const res = await writeFileHandler.execute(
      { path: '/workspace/notes.txt', content: 'plain text' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.data?.validation).toBeUndefined();
    expect(res.summary).not.toContain('validation');
  });

  test('module-resolution failure path is unchanged: ok:false, no gate runs on undeployable source', async () => {
    const broken = `rules_version = '2+modules';\nimport { nope } from 'does_not_exist';\nservice cloud.firestore { match /databases/{db}/documents { match /x/{i} { allow read: if nope(); } } }`;
    const res = await writeFileHandler.execute({ path: RULES_PATH, content: broken }, ctx);
    expect(res.ok).toBe(false);
    expect(res.data?.validation).toBeUndefined();
  });
});

// ─── W1.4 — ambient workspace tests on suite-affecting writes ─────────

const OWNER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow get: if request.auth != null && request.auth.uid == resource.data.owner;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
    }
  }
}`;

const NOTES_SUITE = JSON.stringify({
  seed: [{ path: 'notes/n1', data: { owner: 'alice' } }],
  cases: [
    { as: { uid: 'alice' }, do: { method: 'get', path: 'notes/n1' }, expect: 'ALLOW' },
    { as: { uid: 'bob' }, do: { method: 'get', path: 'notes/n1' }, expect: 'DENY' },
  ],
});

const TESTS_DIR = '/workspace/tests';

async function writeVfs(path: string, content: string): Promise<void> {
  const vfs = getVFS();
  await vfs.promises.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await vfs.promises.writeFile(path, content);
}

describe('write_file — ambient workspace tests (W1.4)', () => {
  test('rules write with a passing suite → tests block present, summary notes it', async () => {
    await writeVfs(`${TESTS_DIR}/notes.test.json`, NOTES_SUITE);
    const res = await writeFileHandler.execute({ path: RULES_PATH, content: OWNER_RULES }, ctx);
    expect(res.ok).toBe(true);
    const t = res.data?.validation?.tests;
    expect(t).toEqual({ total: 2, passed: 2, failed: 0, failures: [] });
    expect(res.summary).toContain('tests 2/2');
  });

  test('rules write with a failing suite → failures capped at 10, true count kept, write still ok', async () => {
    // 12 cases that can never pass under deny-all rules.
    const cases = Array.from({ length: 12 }, (_, i) => ({
      as: { uid: 'alice' },
      do: { method: 'get', path: `notes/n${i}` },
      expect: 'ALLOW',
      name: `case ${i}`,
    }));
    await writeVfs(`${TESTS_DIR}/big.test.json`, JSON.stringify({ cases }));
    const denyAll = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read: if false; }
  }
}`;
    const res = await writeFileHandler.execute({ path: RULES_PATH, content: denyAll }, ctx);
    expect(res.ok).toBe(true); // report, never block
    const t = res.data?.validation?.tests;
    expect(t?.total).toBe(12);
    expect(t?.failed).toBe(12);
    expect(t?.failures?.length).toBe(10); // capped
    expect(t?.failures?.[0]).toMatchObject({
      method: 'get',
      expect: 'ALLOW',
      got: 'DENY',
      source: 'authored',
    });
    expect(res.summary).toContain('tests 0/12');
  });

  test('test-file write that fails to PARSE → parse error reported in the block', async () => {
    await writeVfs(RULES_PATH, OWNER_RULES);
    const res = await writeFileHandler.execute(
      { path: `${TESTS_DIR}/broken.test.json`, content: '{ not json' },
      ctx,
    );
    expect(res.ok).toBe(true);
    const t = res.data?.validation?.tests;
    expect(t?.errors?.length).toBe(1);
    expect(t?.errors?.[0]).toContain('broken.test.json');
    expect(t?.errors?.[0]).toContain('not valid JSON');
    expect(res.summary).toContain('1 file error');
  });

  test('test-file write runs the whole suite (other files included)', async () => {
    await writeVfs(RULES_PATH, OWNER_RULES);
    await writeVfs(`${TESTS_DIR}/notes.test.json`, NOTES_SUITE);
    const res = await writeFileHandler.execute(
      {
        path: `${TESTS_DIR}/create.test.json`,
        content: JSON.stringify({
          cases: [
            {
              as: { uid: 'carol' },
              do: { method: 'create', path: 'notes/c1', data: { owner: 'carol' } },
              expect: 'ALLOW',
            },
          ],
        }),
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.data?.validation?.tests).toEqual({ total: 3, passed: 3, failed: 0, failures: [] });
  });

  test('rules write with NO test files → no tests block (silent pre-suite)', async () => {
    const res = await writeFileHandler.execute({ path: RULES_PATH, content: OWNER_RULES }, ctx);
    expect(res.ok).toBe(true);
    expect(res.data?.validation).toBeDefined(); // C1 gates still ran
    expect(res.data?.validation?.tests).toBeUndefined();
    expect(res.summary).not.toContain('tests');
  });

  test('test-file write with no ruleset → skipped is reported (signal, not noise)', async () => {
    const res = await writeFileHandler.execute(
      { path: `${TESTS_DIR}/orphan.test.json`, content: NOTES_SUITE },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.data?.validation?.tests).toEqual({ skipped: 'no ruleset' });
    expect(res.summary).toContain('tests skipped (no ruleset)');
  });

  test('un-parseable rules write skips the suite (lint already carries the evidence)', async () => {
    await writeVfs(`${TESTS_DIR}/notes.test.json`, NOTES_SUITE);
    const res = await writeFileHandler.execute(
      { path: RULES_PATH, content: 'service cloud.firestore { broken {{' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.data?.validation?.lint?.[0]).toContain('parse error');
    expect(res.data?.validation?.tests).toEqual({ skipped: 'rules parse error' });
  });

  test('non-suite paths in /workspace/tests (e.g. fixtures.json) do not trigger the gate', async () => {
    await writeVfs(RULES_PATH, OWNER_RULES);
    const res = await writeFileHandler.execute(
      { path: `${TESTS_DIR}/fixtures.json`, content: '{}' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.data?.validation).toBeUndefined();
  });
});
