/**
 * `pyric <tool> <method>` against a scratch project directory: the flags become
 * the record's arguments, the call runs the record's handler, and the state it
 * writes is the state the headless MCP server reads back.
 */
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HEADLESS_STATE_RELATIVE } from '../../src/bridge/server/headless.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runSurfaceMethod } from '../../src/cli/surface-method-runner.js';

const workDir = mkdtempSync(join(tmpdir(), 'pyric-surface-cli-'));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(key: string, argv: string[]): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runSurfaceMethod(key, parseArgs(argv), {
    cwd: workDir,
    stdout: { write: (text) => void (stdout += text) },
    stderr: { write: (text) => void (stderr += text) },
  });
  return { code, stdout, stderr };
}

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
    expect(written.stderr).toBe('');
    expect(written.code).toBe(0);
    expect(existsSync(join(workDir, HEADLESS_STATE_RELATIVE))).toBe(true);

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
});
