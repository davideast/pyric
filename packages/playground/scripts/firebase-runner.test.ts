import { describe, expect, test } from 'bun:test';
import type { DeployStep } from './deploy-plan';
import { createFirebaseRunner } from './firebase-runner';

describe('Firebase CLI runner', () => {
  test('executes deploy steps with the firebase binary', async () => {
    const calls: Array<{ command: string[]; stdout: 'inherit' | 'pipe' }> = [];
    const run = createFirebaseRunner({
      cwd: '/playground',
      environment: { FIREBASE_TOKEN: 'test-token' },
      log() {},
      spawn(command, options) {
        calls.push({ command: [...command], stdout: options.stdout });
        return { exited: Promise.resolve(0), stdout: null };
      },
    });
    const step: DeployStep = {
      kind: 'deploy',
      args: ['deploy', '--only', 'hosting'],
    };

    await run(step);

    expect(calls).toEqual([
      {
        command: ['firebase', 'deploy', '--only', 'hosting'],
        stdout: 'inherit',
      },
    ]);
  });

  test('captures and parses firebase-tools JSON discovery output', async () => {
    const run = createFirebaseRunner({
      cwd: '/playground',
      environment: {},
      log() {},
      spawn(_command, options) {
        expect(options.stdout).toBe('pipe');
        return {
          exited: Promise.resolve(0),
          stdout: new Response('{"status":"success","result":[]}').body,
        };
      },
    });
    const step: DeployStep = {
      kind: 'discover-endpoint',
      args: ['functions:list', '--json'],
    };

    await expect(run(step)).resolves.toEqual({ status: 'success', result: [] });
  });

  test('fails when firebase-tools exits unsuccessfully', async () => {
    const run = createFirebaseRunner({
      cwd: '/playground',
      environment: {},
      log() {},
      spawn() {
        return { exited: Promise.resolve(2), stdout: null };
      },
    });

    await expect(run({ kind: 'deploy', args: ['deploy'] })).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});
