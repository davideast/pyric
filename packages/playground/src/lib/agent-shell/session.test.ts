/** W2.1 — agent shell over the in-memory VFS (headless): builtin
 *  routing, cwd persistence, the /workspace jail, and man pages. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { RULES_PATH } from '~/lib/store/files';
import { TESTS_DIR } from '~/lib/tools/core/runWorkspaceTests';
import { getVFS, resetVFS } from '~/lib/vfs';

import { MAN_PAGES, MAN_TOPICS } from './man-pages';
import { createAgentShell, resetAgentShell, rewriteLeadingTest, type AgentShell } from './session';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{d}/documents {
    match /notes/{id} {
      allow get: if request.auth != null && request.auth.uid == resource.data.owner;
      allow list: if request.auth != null;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
    }
  }
}`;

const NOTES_SUITE = JSON.stringify({
  seed: [{ path: 'notes/n1', data: { owner: 'alice', body: 'hi' } }],
  cases: [
    { as: { uid: 'alice' }, do: { method: 'get', path: 'notes/n1' }, expect: 'ALLOW' },
    { as: { uid: 'bob' }, do: { method: 'get', path: 'notes/n1' }, expect: 'DENY' },
  ],
});

async function writeVfs(path: string, content: string): Promise<void> {
  const vfs = getVFS();
  const dir = path.slice(0, path.lastIndexOf('/'));
  await vfs.promises.mkdir(dir, { recursive: true });
  await vfs.promises.writeFile(path, content);
}

let shell: AgentShell;

beforeAll(async () => {
  resetVFS();
  resetAgentShell();
  await writeVfs(RULES_PATH, RULES);
  await writeVfs(`${TESTS_DIR}/notes.test.json`, NOTES_SUITE);
});

afterAll(() => {
  // Leave no state behind for whichever test file runs next — the VFS
  // and shell are module singletons shared across the bun test process.
  resetVFS();
  resetAgentShell();
});

beforeEach(() => {
  shell = createAgentShell();
});

describe('builtin routing', () => {
  test('`test` routes to the W1 runner and reports per-case results', async () => {
    const r = await shell.exec('test');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('✓ notes.test.json 2/2');
    expect(r.stdout).toContain('2/2 passed across 1 file(s) · PASS');
  });

  test('`test <pattern>` filters files; no match is an actionable error', async () => {
    await writeVfs(
      `${TESTS_DIR}/failing.test.json`,
      JSON.stringify({
        cases: [{ as: null, do: { method: 'list', path: 'notes' }, expect: 'ALLOW' }],
      }),
    );
    const filtered = await shell.exec('test notes');
    expect(filtered.exitCode).toBe(0);
    expect(filtered.stdout).toContain('notes.test.json');
    expect(filtered.stdout).not.toContain('failing.test.json');

    const failing = await shell.exec('test failing');
    expect(failing.exitCode).toBe(1);
    expect(failing.stdout).toContain('expected ALLOW, got DENY');

    const none = await shell.exec('test nope');
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain('no test files matching "nope"');

    await getVFS().promises.unlink(`${TESTS_DIR}/failing.test.json`);
  });

  test('leading `test` composes with && (rewrite, not interception)', async () => {
    const r = await shell.exec('test && echo green');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('green');
  });

  test('`[ ... ]` conditionals keep working (test/[ stays interpreter-owned)', async () => {
    const r = await shell.exec(`[ -f ${RULES_PATH} ] && echo yes`);
    expect(r.stdout.trim()).toBe('yes');
  });

  test('rewriteLeadingTest only touches the leading token', () => {
    expect(rewriteLeadingTest('test')).toBe('run-tests');
    expect(rewriteLeadingTest('test notes && echo ok')).toBe('run-tests notes && echo ok');
    expect(rewriteLeadingTest('  test; echo ok')).toBe('  run-tests; echo ok');
    expect(rewriteLeadingTest('tester')).toBe('tester');
    expect(rewriteLeadingTest('echo test')).toBe('echo test');
    expect(rewriteLeadingTest('ls && test')).toBe('ls && test');
  });

  test('`lint-rules` lints the workspace ruleset by default', async () => {
    const r = await shell.exec('lint-rules');
    expect(r.exitCode).toBe(0); // warnings allowed; errors would exit 1
    expect(r.stderr).toBe('');
  });

  test('`lint-rules` reports parse errors with location, exit 1', async () => {
    await writeVfs('/workspace/broken.rules', 'rules_version = ; nope');
    const r = await shell.exec('lint-rules broken.rules');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('parse error');
  });

  test('`lint-rules` on a missing file is an actionable error', async () => {
    const r = await shell.exec('lint-rules nope.rules');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('no such file');
  });
});

describe('cwd persistence + jail', () => {
  test('cwd persists across exec calls', async () => {
    await shell.exec('mkdir -p sub && cd sub');
    expect(shell.cwd()).toBe('/workspace/sub');
    const r = await shell.exec('pwd');
    expect(r.stdout.trim()).toBe('/workspace/sub');
    expect(r.cwd).toBe('/workspace/sub');
  });

  test('`cd /; ls` cannot escape /workspace', async () => {
    const r = await shell.exec('cd /; ls');
    // The mount root contains ONLY the workspace — no host fs exists.
    expect(r.stdout.trim()).toBe('workspace');
    // The session cwd is clamped back inside the jail.
    expect(r.cwd).toBe('/workspace');
    const pwd = await shell.exec('pwd');
    expect(pwd.stdout.trim()).toBe('/workspace');
  });

  test('host paths do not exist inside the shell', async () => {
    const r = await shell.exec('cat /etc/passwd');
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe('');
  });

  test('relative paths resolve against the persisted cwd', async () => {
    await shell.exec('cd tests');
    const r = await shell.exec('cat notes.test.json');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('notes/n1');
  });
});

describe('man', () => {
  test('every page renders and stays under 80 lines', async () => {
    for (const topic of MAN_TOPICS) {
      const r = await shell.exec(`man ${topic}`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(0);
      expect(MAN_PAGES[topic].split('\n').length).toBeLessThan(80);
    }
  });

  test('pages carry their contracts', async () => {
    const t = await shell.exec('man test');
    expect(t.stdout).toContain('tests/<name>.test.json');
    expect(t.stdout).toContain('"expect"');
    const rules = await shell.exec('man rules');
    expect(rules.stdout).toContain('request.resource.data');
    const sh = await shell.exec('man shell');
    expect(sh.stdout).toContain('lint-rules');
  });

  test('no topic lists topics; unknown topic exits 1', async () => {
    const bare = await shell.exec('man');
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toContain('test, rules, shell, workflow, diagnostics');
    const unknown = await shell.exec('man bogus');
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('topics: test, rules, shell, workflow, diagnostics');
  });

  test('W2.2 pages carry the moved prompt guidance', async () => {
    // The orchestration detail collapsed out of the system prompt must be
    // reachable here — these pins keep the pull-side honest.
    const wf = await shell.exec('man workflow');
    expect(wf.stdout).toContain('firestore_rules_stdlib_list');
    expect(wf.stdout).toContain("rules_version = '2+modules';");
    expect(wf.stdout).toContain("import { isAuthenticated, isOwner } from 'auth';");
    expect(wf.stdout).toContain('firestore_extract_indexes');
    expect(wf.stdout).not.toContain('firestore_discover_paths');
    expect(wf.stdout).not.toContain('firestore_find_collection_group');
    expect(wf.stdout).not.toContain('firestore_get_rules');
    const dg = await shell.exec('man diagnostics');
    expect(dg.stdout).toContain('simulate_firestore_write');
    expect(dg.stdout).toContain('expressionTrace');
    expect(dg.stdout).toContain('regression.nowDenied');
    expect(dg.stdout).toContain('TOO_MANY_OPERATIONS');
    expect(dg.stdout).toContain('generate_fixture_from_session');
  });

  test('man -k renders the apropos index, optionally filtered', async () => {
    const all = await shell.exec('man -k');
    expect(all.exitCode).toBe(0);
    for (const topic of MAN_TOPICS) expect(all.stdout).toContain(topic);
    const filtered = await shell.exec('man -k orchestration');
    expect(filtered.exitCode).toBe(0);
    expect(filtered.stdout).toContain('workflow');
    expect(filtered.stdout).not.toContain('diagnostics');
    const none = await shell.exec('man -k zebra');
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain('nothing matches');
  });
});
