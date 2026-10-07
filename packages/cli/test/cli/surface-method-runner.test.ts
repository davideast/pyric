/**
 * `runSurfaceMethod` against a scratch project directory: the flags become
 * the record's arguments, the call runs the record's handler, and the state it
 * writes is the state the in-process MCP server reads back.
 *
 * `surface-method-command.test.ts` covers the thin registry wrapper this
 * runner sits behind; every case here calls `runSurfaceMethod` directly with
 * an injected `stdout`/`stderr` so the runner's own behaviour is pinned
 * independent of that wrapper.
 */
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IN_PROCESS_STATE_RELATIVE } from '../../src/bridge/server/in-process.js';
import { runDatabaseRulesValidate } from '../../src/cli/database-rules.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runSurfaceMethod } from '../../src/cli/surface-method-runner.js';
import { setInlineStorageLimitForTesting } from 'pyric/sandbox/internal';

const workDir = mkdtempSync(join(tmpdir(), 'pyric-surface-cli-'));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A serve discovery answer: nothing running, or one at this display URL, found
 * through the project's own pointer file or through the port scan.
 */
type Discovery = null | { url: string; source?: 'pointer' | 'scan' };

async function run(key: string, argv: string[], serve: Discovery = null): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const source = serve?.source === 'scan' ? 'scan port 5174' : 'pointer .pyric/serve.json';
  const found =
    serve === null
      ? null
      : { url: serve.url, mcpUrl: `${serve.url}/__pyric/mcp`, base: serve.url, instanceId: null, source };
  const code = await runSurfaceMethod(key, parseArgs(argv), {
    cwd: workDir,
    stdout: { write: (text) => void (stdout += text) },
    stderr: { write: (text) => void (stderr += text) },
    discover: async () => found,
  });
  return { code, stdout, stderr };
}

/** `pyric database rules validate <file>`, which reads the same rules files as `rules lint`. */
async function validate(file: string): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const parsed = parseArgs(['database', 'rules', 'validate', file]);
  const code = await runDatabaseRulesValidate({ ...parsed, positional: parsed.positional.slice(2) }, {
    cwd: workDir,
    stdout: { write: (text) => void (stdout += text) },
    stderr: { write: (text) => void (stdout += text) },
  });
  return { code, stdout };
}

describe('which sandbox a command acts on', () => {
  it('says it acts on the in-process sandbox before the result', async () => {
    const shown = await run('sandbox.inspect', ['sandbox', 'inspect']);
    expect(shown.code).toBe(0);
    expect(shown.stderr.split('\n')[0]).toBe('pyric: in-process sandbox, .pyric/state/in-process.json');
  });

  it('refuses when a running serve owns the sandbox, naming both ways forward', async () => {
    const refused = await run('sandbox.inspect', ['sandbox', 'inspect'], {
      url: 'http://localhost:3473',
    });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('http://localhost:3473');
    expect(refused.stderr).toContain('--in-process');
    expect(refused.stderr).toContain('pyric mcp');
  });

  it('ignores a serve the port scan found, which may belong to another project', async () => {
    const scanned = await run('sandbox.inspect', ['sandbox', 'inspect'], {
      url: 'http://localhost:5174',
      source: 'scan',
    });
    expect(scanned.code).toBe(0);
    expect(scanned.stderr).not.toContain('owns this project');
  });

  it('acts on the in-process sandbox with --in-process even while a serve runs', async () => {
    const forced = await run('sandbox.inspect', ['sandbox', 'inspect', '--in-process'], {
      url: 'http://localhost:3473',
    });
    expect(forced.code).toBe(0);
    expect(forced.stderr).not.toContain('owns this project');
  });
});

describe('pyric <tool> <method>', () => {
  it('writes a document from flags, with the object argument as a JSON string', async () => {
    const written = await run('firestore.setDoc', [
      'firestore',
      'setDoc',
      '--path',
      'posts/p1',
      '--data',
      '{"a":1}',
    ]);
    expect(written.stderr).toBe('pyric: in-process sandbox, .pyric/state/in-process.json\n');
    expect(written.code).toBe(0);
    expect(existsSync(join(workDir, IN_PROCESS_STATE_RELATIVE))).toBe(true);

    const read = await run('firestore.getDoc', ['firestore', 'getDoc', '--path', 'posts/p1']);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain('"a": 1');
  });

  it('holds an impersonated identity in the state the next command reads', async () => {
    const switched = await run('auth.createUser', [
      'auth',
      'createUser',
      '--uid',
      'alice',
      '--email',
      'alice@example.com',
    ]);
    expect(switched.code).toBe(0);

    const impersonated = await run('auth.impersonate', [
      'auth',
      'impersonate',
      '--uid',
      'alice',
    ]);
    expect(impersonated.code).toBe(0);
    expect(impersonated.stdout).toContain('Acting as alice');
  });

  it('prints the whole result as JSON on request', async () => {
    const inspected = await run('sandbox.inspect', ['sandbox', 'inspect', '--json']);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toHaveProperty('ok', true);
  });

  it('refuses a flag the record does not declare, naming the ones it does', async () => {
    const rejected = await run('firestore.getDoc', ['firestore', 'getDoc', '--document', 'x']);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('has no --document');
    expect(rejected.stderr).toContain('--path');
  });

  it('runs the record validator before the handler', async () => {
    const rejected = await run('firestore.getDoc', ['firestore', 'getDoc', '--path', 'posts']);
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain('firestore.getDoc');
    expect(rejected.stderr).toContain('even number of segments');
  });

  it('takes an enum argument as the word it is, not as JSON', async () => {
    const linted = await run('rules.lint', [
      'rules',
      'lint',
      '--service',
      'firestore',
      '--rules',
      "rules_version = '2';\nservice cloud.firestore {\n}",
    ]);
    // Exit 1 is a usage error, which is what a word read as JSON would be.
    expect(linted.stderr).not.toContain('JSON');
    expect(linted.code).not.toBe(1);
  });

  it('exits 2 and prints the findings when a database rules file has an error', async () => {
    const rulesFile = join(workDir, 'broken.database.rules.json');
    writeFileSync(rulesFile, JSON.stringify({ rules: { notes: { $id: { '.write': 'auth != null && (' } } } }));
    const linted = await run('rules.lint', [
      'rules',
      'lint',
      '--service',
      'database',
      '--rules-file',
      rulesFile,
    ]);
    expect(linted.code).toBe(2);
    expect(linted.stdout).toContain('1 findings, 1 errors');
    expect(linted.stdout).toContain('PARSE_ERROR');
  });

  it('exits 0 when a database rules file has no errors', async () => {
    const rulesFile = join(workDir, 'clean.database.rules.json');
    writeFileSync(rulesFile, JSON.stringify({ rules: { notes: { $id: { '.write': 'auth != null', '.validate': 'newData.isString()' } } } }));
    const linted = await run('rules.lint', [
      'rules',
      'lint',
      '--service',
      'database',
      '--rules-file',
      rulesFile,
    ]);
    expect(linted.code).toBe(0);
    expect(linted.stdout).toContain('0 findings, 0 errors');
  });

  it('lints and simulates a database rules file with comments as it does the same file without them', async () => {
    const plainFile = join(workDir, 'plain.database.rules.json');
    writeFileSync(
      plainFile,
      JSON.stringify({ rules: { notes: { $uid: { '.read': 'auth != null && auth.uid == $uid', '.write': 'auth != null && auth.uid == $uid', '.validate': 'newData.isString()' } } } }),
    );
    const commentedFile = join(workDir, 'commented.database.rules.json');
    writeFileSync(
      commentedFile,
      `/* Notes rules. */
{
  // Each user reads and writes their own notes.
  "rules": {
    "notes": {
      "$uid": {
        ".read": "auth != null && auth.uid == $uid", // the owner only
        ".write": "auth != null && auth.uid == $uid",
        ".validate": "newData.isString()"
      }
    }
  }
}
`,
    );
    const lint = (file: string) =>
      run('rules.lint', ['rules', 'lint', '--service', 'database', '--rules-file', file]);
    const simulate = (file: string, uid: string) =>
      run('rules.simulate', [
        'rules',
        'simulate',
        '--service',
        'database',
        '--operation',
        'read',
        '--path',
        'notes/alice',
        '--uid',
        uid,
        '--rules-file',
        file,
      ]);

    const lintedCommented = await lint(commentedFile);
    const lintedPlain = await lint(plainFile);
    expect(lintedCommented.code).toBe(0);
    expect(lintedCommented.stdout).toContain('0 findings, 0 errors');
    expect(lintedCommented).toEqual(lintedPlain);

    for (const [uid, decision] of [['alice', 'ALLOW'], ['bob', 'DENY']] as const) {
      const simulatedCommented = await simulate(commentedFile, uid);
      const simulatedPlain = await simulate(plainFile, uid);
      expect(simulatedCommented.stdout).toContain(decision);
      // The trace names the line of each evaluated rule, and the two files
      // place the rule on different lines; everything else is identical.
      const withoutLines = (output: { code: number; stdout: string }) => ({
        ...output,
        stdout: output.stdout.replace(/"line": \d+/g, '"line": 0'),
      });
      expect(simulatedCommented.stdout).toContain('"line": 7');
      expect(simulatedPlain.stdout).toContain('"line": 1');
      expect(withoutLines(simulatedCommented)).toEqual(withoutLines(simulatedPlain));
    }

    expect(await validate(commentedFile)).toEqual({ code: 0, stdout: '{\n  "errors": []\n}\n' });
  });

  it('refuses a database rules file with comments that is still not JSON', async () => {
    const brokenFile = join(workDir, 'commented-broken.database.rules.json');
    writeFileSync(brokenFile, '{\n  // An unterminated object.\n  "rules": { "notes": { ".read": true }\n');
    const linted = await run('rules.lint', [
      'rules',
      'lint',
      '--service',
      'database',
      '--rules-file',
      brokenFile,
    ]);
    expect(linted.code).toBe(2);
    expect(`${linted.stdout}${linted.stderr}`).toContain('not valid JSON');

    const validated = await validate(brokenFile);
    expect(validated.code).toBe(2);
    expect(validated.stdout).toContain('INVALID_RULES_JSON');
  });

  it('refuses an object argument that is not JSON', async () => {
    const rejected = await run('firestore.setDoc', [
      'firestore',
      'setDoc',
      '--path',
      'posts/p2',
      '--data',
      'a=1',
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('not valid JSON');
  });

  it('carries an anonymous user through a checkpoint, a reset, and a restore', async () => {
    const signedIn = await run('auth.signInAnonymously', ['auth', 'signInAnonymously', '--json']);
    expect(signedIn.code).toBe(0);
    const uid = (JSON.parse(signedIn.stdout).data.appSession as { uid: string }).uid;

    const listedBefore = await run('auth.listUsers', ['auth', 'listUsers', '--json']);
    const usersBefore = JSON.parse(listedBefore.stdout).data.users as Array<{ uid: string }>;
    expect(usersBefore.map((u) => u.uid)).toContain(uid);

    const saved = await run('sandbox.checkpoint', ['sandbox', 'checkpoint', '--name', 'anon-check']);
    expect(saved.code).toBe(0);

    const cleared = await run('sandbox.reset', [
      'sandbox',
      'reset',
      '--scope',
      'auth',
      '--confirm',
    ]);
    expect(cleared.code).toBe(0);
    const listedAfterReset = await run('auth.listUsers', ['auth', 'listUsers', '--json']);
    const usersAfterReset = JSON.parse(listedAfterReset.stdout).data.users as Array<{ uid: string }>;
    expect(usersAfterReset.map((u) => u.uid)).not.toContain(uid);

    const restored = await run('sandbox.restore', [
      'sandbox',
      'restore',
      '--name',
      'anon-check',
      '--confirm',
    ]);
    expect(restored.code).toBe(0);

    const listedAfterRestore = await run('auth.listUsers', ['auth', 'listUsers', '--json']);
    const usersAfterRestore = JSON.parse(listedAfterRestore.stdout).data.users as Array<{ uid: string }>;
    expect(usersAfterRestore.map((u) => u.uid)).toContain(uid);
  });

  it('carries the app session into a fresh process in the same working directory', async () => {
    const created = await run('auth.createUser', [
      'auth',
      'createUser',
      '--uid',
      'session-carrier',
      '--email',
      'carrier@example.com',
      '--password',
      'hunter222',
    ]);
    expect(created.code).toBe(0);

    const signedIn = await run('auth.signInWithEmailAndPassword', [
      'auth',
      'signInWithEmailAndPassword',
      '--email',
      'carrier@example.com',
      '--password',
      'hunter222',
    ]);
    expect(signedIn.code).toBe(0);

    // A fresh call, in the same working directory: no process, no handle,
    // and no argument carries the session forward except the state file.
    const whoami = await run('auth.whoami', ['auth', 'whoami', '--json']);
    expect(whoami.code).toBe(0);
    const appSession = JSON.parse(whoami.stdout).data.appSession as { uid: string } | null;
    expect(appSession?.uid).toBe('session-carrier');
  });
});

describe('a Storage write past the inline limit', () => {
  it('reports the result, says Storage was not saved, names the limit, and fails', async () => {
    const restore = setInlineStorageLimitForTesting(4);
    try {
      const upload = await run('storage.uploadBytes', [
        'storage', 'uploadBytes', '--in-process', '--path', 'big/five.bin', '--contentBase64', 'AQIDBAU=',
      ]);
      expect(upload.code).toBe(2);
      expect(upload.stderr).toContain('pyric: Storage was not saved.');
      expect(upload.stderr).toContain('MAX_INLINE_STORAGE_BYTES');
      expect(upload.stderr).toContain('`pyric snapshot`');
      const sidecar = join(workDir, '.pyric', 'state', 'storage.json');
      const saved = existsSync(sidecar) ? readFileSync(sidecar, 'utf8') : '';
      expect(saved).not.toContain('big/five.bin');
    } finally {
      restore();
    }
  });
});
