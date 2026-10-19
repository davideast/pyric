import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { clientSdkRefusal, isRemoteSandboxActivation } from '../../src/app/client-sdk-refusal.js';

interface Outcome {
  name: string;
  ok: boolean;
  code?: string | null;
  message?: string;
}

const FIXTURE = resolve(import.meta.dir, 'fixtures/register-client-sdk.ts');
const SERVICES = ['database', 'database.get', 'firestore', 'firestore.get', 'auth', 'storage'];

/** Runs the fixture in a fresh process, from an empty directory with no firebase.json. */
function runClientSdks(setting: string): Outcome[] {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-register-client-sdk-'));
  const env = { ...process.env, PYRIC_SANDBOX: setting };
  const result = Bun.spawnSync([process.execPath, FIXTURE], { cwd, env });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim().split('\n').map((line) => JSON.parse(line) as Outcome);
}

describe('client SDKs under the in-process register adapter (#1082)', () => {
  it('reads remote, remote:<url>, an empty remote url, 1 and true as a remote activation, and local as in-process', () => {
    for (const setting of ['remote', 'remote:http://127.0.0.1:5173', ' remote:http://h ', 'remote:', '1', 'true']) {
      expect(isRemoteSandboxActivation(setting), setting).toBe(true);
    }
    for (const setting of [undefined, '', 'local', 'remotely', 'false', '0']) {
      expect(isRemoteSandboxActivation(setting), String(setting)).toBe(false);
    }
  });

  for (const setting of ['remote:http://127.0.0.1:1', 'remote', 'remote:', '1', 'true']) {
    it(`refuses every client service call with failed-precondition under PYRIC_SANDBOX=${setting}`, () => {
      const outcomes = runClientSdks(setting);
      expect(outcomes.map(({ name }) => name)).toEqual(SERVICES);
      const expected = clientSdkRefusal(setting).message;
      for (const outcome of outcomes) {
        expect(outcome, outcome.name).toEqual({ name: outcome.name, ok: false, code: 'failed-precondition', message: expected });
      }
    });
  }

  it('keeps the in-process sandbox under PYRIC_SANDBOX=local', () => {
    const outcomes = runClientSdks('local');
    expect(outcomes.map(({ name }) => name)).toEqual(SERVICES);
    for (const outcome of outcomes) {
      expect(outcome.code, outcome.name).not.toBe('failed-precondition');
    }
    expect(outcomes.find(({ name }) => name === 'auth')?.ok).toBe(true);
  });
});
