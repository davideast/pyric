/**
 * `pyric verify` treats the legacy default instance name, the project id, as
 * the default instance (#1062): `--rules rtdb:<projectId>=<path>` replaces
 * the default instance's rules, and a firebase.json entry for `<projectId>`
 * is the default instance's candidate rules.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, ref, set, sandbox as rtdbSandbox } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';

import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerify } from '../../src/cli/verify.js';
import { buildVerifyFixture, type PyricVerifyFixture } from '../../src/verify/index.js';
import { captureRtdbInstances, defaultInstanceUrl } from '../../src/verify/rtdb-instance-capture.js';

const PROJECT = 'legacy-verify';
const SIGNED_IN = { rules: { '.read': 'auth != null', '.write': 'auth != null' } };
const READ_ONLY = { rules: { '.read': 'auth != null', '.write': false } };

/** A session on the project's default instance. */
async function captureSession(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const main = getDatabase(sandbox);
  rtdbSandbox.setRules(main, SIGNED_IN);
  await set(ref(getDatabase(sandbox.withAuth({ uid: 'alice' })), 'rooms/lobby'), { name: 'lobby' });
  const defaultName = `${PROJECT}-default-rtdb`;
  return buildVerifyFixture({
    sandbox,
    rtdbRules: SIGNED_IN,
    rtdbState: rtdbSandbox.snapshotState(main),
    rtdbDatabaseUrl: defaultInstanceUrl(defaultName),
    rtdbInstances: captureRtdbInstances(sandbox, defaultName),
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function project(files: Record<string, unknown>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-verify-legacy-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureSession()));
  return dir;
}

async function verify(dir: string, argv: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
  const stderr = spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const code = await runVerify(parseArgs(['verify', 'session.json', ...argv]));
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.chdir(previous);
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('pyric verify with the legacy default instance name', () => {
  for (const instance of [PROJECT, `https://${PROJECT}.firebaseio.com`]) {
    it(`maps rtdb:${instance} to the default instance`, async () => {
      const dir = await project({
        'firebase.json': { database: { rules: 'database.rules.json' } },
        '.firebaserc': { projects: { default: PROJECT } },
        'database.rules.json': SIGNED_IN,
        'strict.rules.json': READ_ONLY,
      });
      const result = await verify(dir, ['--rules', `rtdb:${instance}=strict.rules.json`]);
      expect(result.err).not.toMatch(/^pyric verify:/m);
      expect(result.code).toBe(1);
      expect(result.out).toContain('[rtdb] now-denied: set /rooms/lobby');
    });
  }

  it('reads the default instance candidate rules from a firebase.json entry for <projectId>', async () => {
    const dir = await project({
      'firebase.json': { database: [{ instance: PROJECT, rules: 'strict.rules.json' }] },
      '.firebaserc': { projects: { default: PROJECT } },
      'strict.rules.json': READ_ONLY,
    });
    const result = await verify(dir);
    expect(result.err).not.toMatch(/^pyric verify:/m);
    expect(result.code).toBe(1);
    expect(result.out).toContain('[rtdb] now-denied: set /rooms/lobby');
  });
});
