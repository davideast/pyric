/**
 * The interlock status line and the warn-only beacon watchdog.
 *
 * Everything the status line reports is knowable synchronously from the env
 * `pyric sandbox` is about to hand the child: the guard mode, whether
 * NODE_OPTIONS actually carries the register import, and the beacon endpoint
 * the child will post to. It is a statement about the launch, printed before
 * anything can have gone wrong at runtime.
 *
 * The watchdog is the other half, and it never kills and never blocks. It
 * speaks at most once per child.
 */
import { describe, expect, it } from 'bun:test';
import { buildChildEnv } from '../../src/cli/sandbox-runner.js';
import {
  describeInterlock,
  formatInterlockLine,
  formatMissingBeaconWarning,
  startBeaconWatchdog,
} from '../../src/cli/sandbox-interlock.js';

const REGISTER_URL = 'file:///usr/local/pyric/dist/register/index.js';

describe('describeInterlock', () => {
  it('reads the guard mode, the register import and the beacon off the child env', () => {
    const env = buildChildEnv(
      { PYRIC_GUARD: 'block' } as NodeJS.ProcessEnv,
      { serveUrl: 'http://localhost:3473', registerUrl: REGISTER_URL, beaconToken: 't' },
    );
    expect(describeInterlock(env, REGISTER_URL)).toEqual({
      guard: 'block',
      registerImported: true,
      beacon: 'http://localhost:3473/__pyric/beacon',
    });
  });

  it('defaults the guard to warn and survives a user NODE_OPTIONS prefix', () => {
    const env = buildChildEnv(
      { NODE_OPTIONS: '--max-old-space-size=4096' } as NodeJS.ProcessEnv,
      { serveUrl: 'http://localhost:3473', registerUrl: REGISTER_URL, beaconToken: 't' },
    );
    const status = describeInterlock(env, REGISTER_URL);
    expect(status.guard).toBe('warn');
    expect(status.registerImported).toBe(true);
  });

  it('reports registerImported=false when NODE_OPTIONS lost the import', () => {
    const status = describeInterlock(
      { PYRIC_SANDBOX: 'remote:http://localhost:3473', NODE_OPTIONS: '--inspect' },
      REGISTER_URL,
    );
    expect(status.registerImported).toBe(false);
    expect(status.beacon).toBe('http://localhost:3473/__pyric/beacon');
  });
});

describe('formatInterlockLine', () => {
  it('is one short ✔ line naming the guard mode and the loader', () => {
    const line = formatInterlockLine({
      guard: 'warn',
      registerImported: true,
      beacon: 'http://localhost:3473/__pyric/beacon',
    });
    expect(line.startsWith('✔ interlock')).toBe(true);
    expect(line).toContain('guard=warn');
    expect(line).toContain('NODE_OPTIONS');
    expect(line.endsWith('\n')).toBe(true);
    // Quiet by default: one line, and no beacon URL the reader has to skim past.
    expect(line.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
    expect(line.length).toBeLessThan(80);
  });

  it('degrades to ⚠ and says what is lost when the register import is missing', () => {
    const line = formatInterlockLine({ guard: 'off', registerImported: false, beacon: null });
    expect(line.startsWith('⚠ interlock')).toBe(true);
    expect(line).toContain('guard=off');
    expect(line).toContain('NOT');
    expect(line).toContain('LIVE Firebase');
  });
});

describe('formatMissingBeaconWarning', () => {
  it('names the command, the wait, and what the silence means', () => {
    const line = formatMissingBeaconWarning({
      label: 'next dev',
      graceMs: 15_000,
      beacon: 'http://localhost:3473/__pyric/beacon',
    });
    expect(line).toContain('⚠ interlock');
    expect(line).toContain('next dev');
    expect(line).toContain('15s');
    expect(line).toContain('/__pyric/beacon');
    expect(line.toLowerCase()).toContain('warning only');
  });
});

describe('startBeaconWatchdog', () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('warns exactly once when a live child never posts its beacon', async () => {
    const warnings: string[] = [];
    startBeaconWatchdog({
      label: 'next dev',
      beacon: 'http://localhost:3473/__pyric/beacon',
      graceMs: 5,
      sawBeacon: () => false,
      isAlive: () => true,
      warn: (line) => warnings.push(line),
    });
    await wait(40);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('next dev');
  });

  it('stays silent when the beacon arrived', async () => {
    const warnings: string[] = [];
    startBeaconWatchdog({
      label: 'next dev',
      beacon: 'http://localhost:3473/__pyric/beacon',
      graceMs: 5,
      sawBeacon: () => true,
      isAlive: () => true,
      warn: (line) => warnings.push(line),
    });
    await wait(40);
    expect(warnings).toEqual([]);
  });

  it('stays silent when the child already exited, since nothing was expected', async () => {
    const warnings: string[] = [];
    startBeaconWatchdog({
      label: 'node seed.js',
      beacon: 'http://localhost:3473/__pyric/beacon',
      graceMs: 5,
      sawBeacon: () => false,
      isAlive: () => false,
      warn: (line) => warnings.push(line),
    });
    await wait(40);
    expect(warnings).toEqual([]);
  });

  it('stays silent when there is no beacon endpoint to be absent from', async () => {
    const warnings: string[] = [];
    startBeaconWatchdog({
      label: 'next dev',
      beacon: null,
      graceMs: 5,
      sawBeacon: () => false,
      isAlive: () => true,
      warn: (line) => warnings.push(line),
    });
    await wait(40);
    expect(warnings).toEqual([]);
  });

  it('stop() cancels a pending warn', async () => {
    const warnings: string[] = [];
    const watchdog = startBeaconWatchdog({
      label: 'next dev',
      beacon: 'http://localhost:3473/__pyric/beacon',
      graceMs: 20,
      sawBeacon: () => false,
      isAlive: () => true,
      warn: (line) => warnings.push(line),
    });
    watchdog.stop();
    await wait(60);
    expect(warnings).toEqual([]);
  });
});
