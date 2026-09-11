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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IN_PROCESS_STATE_RELATIVE } from '../../src/bridge/server/in-process.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runSurfaceMethod } from '../../src/cli/surface-method-runner.js';

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
});
