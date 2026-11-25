import { describe, expect, test } from 'bun:test';
import { npmInstall, npmInstallArgs, shouldRetryOnline, type CommandResult } from './install.ts';

const STALE_PEER_ERESOLVE_OUTPUT = [
  'npm error code ERESOLVE',
  'npm error ERESOLVE unable to resolve dependency tree',
  'npm error',
  'npm error While resolving: my-chat@0.0.0',
  'npm error Found: firebase@undefined',
  'npm error node_modules/firebase',
  'npm error   firebase@"~13.4.0" from the root project',
  'npm error',
  'npm error Could not resolve dependency:',
  'npm error peer firebase@">=12" from @pyric/ui@0.1.0-alpha.36',
  '',
].join('\n');

const GENUINE_PEER_CONFLICT_OUTPUT = [
  'npm error code ERESOLVE',
  'npm error ERESOLVE unable to resolve dependency tree',
  'npm error',
  'npm error While resolving: my-chat@0.0.0',
  'npm error Found: firebase@11.10.0',
  'npm error node_modules/firebase',
  'npm error   firebase@"^11.0.0" from the root project',
  'npm error',
  'npm error Could not resolve dependency:',
  'npm error peer firebase@">=12" from @pyric/ui@0.1.0-alpha.36',
  '',
].join('\n');

describe('shouldRetryOnline on stale peer-dependency packuments', () => {
  test('retries ERESOLVE when Arborist resolved a missing cached version as <pkg>@undefined', () => {
    expect(shouldRetryOnline({ code: 1, output: STALE_PEER_ERESOLVE_OUTPUT })).toBe(true);
    const scopedUndefined = STALE_PEER_ERESOLVE_OUTPUT.replace(
      'Found: firebase@undefined',
      'Found: @firebase/app@undefined',
    );
    expect(shouldRetryOnline({ code: 1, output: scopedUndefined })).toBe(true);
  });

  test('never retries genuine ERESOLVE peer conflicts or zero-exit warnings', () => {
    expect(shouldRetryOnline({ code: 1, output: GENUINE_PEER_CONFLICT_OUTPUT })).toBe(false);
    expect(shouldRetryOnline({ code: 0, output: STALE_PEER_ERESOLVE_OUTPUT })).toBe(false);
  });

  test('npmInstall retries once with --prefer-online when --prefer-offline hits <pkg>@undefined', async () => {
    const calls: string[][] = [];
    const reported: string[] = [];
    const responses: CommandResult[] = [
      { code: 1, output: STALE_PEER_ERESOLVE_OUTPUT },
      { code: 0, output: 'added 412 packages\n' },
    ];
    const result = await npmInstall(
      '/cache',
      async (args) => {
        calls.push(args);
        return responses.shift() ?? { code: 1, output: 'unexpected third call' };
      },
      undefined,
      { report: (line) => reported.push(line) },
    );
    expect(calls).toEqual([npmInstallArgs('/cache'), npmInstallArgs('/cache', 'online')]);
    expect(result.code).toBe(0);
    expect(reported).toHaveLength(1);
  });
});
