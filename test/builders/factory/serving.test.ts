// Serving: the pid in served.json is signalled only when /proc shows this
// run's served process with the recorded start time; the port is checked;
// the private-network host comes from Tailscale's stdout only, and only
// while it runs; the run's end removes only the entries the run added.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTimeOf } from '../namespace.ts';
import { studioEnvironment } from './app-start.ts';
import { checkoutAt } from './app-paths.ts';
import { isServedProcess, SERVED_PROCESS, servedPort, ServedPortInvalid } from './served.ts';
import type { ServedState } from './served-process.ts';
import { ensureServed, removeServed, tailnetHost, type Tailscale, type TailscaleResult } from './tailnet.ts';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** A process whose command line looks like the served process's for `runDir`, without starting it. */
async function lookalike(runDir: string): Promise<ServedState> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', SERVED_PROCESS, '--run-dir', runDir], { stdio: 'ignore' });
  children.push(child);
  const pid = child.pid ?? -1;
  // Until the exec, the child's command line is still this process's.
  const hasExeced = () => readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(SERVED_PROCESS);
  for (let tries = 0; tries < 100 && !hasExeced(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  return { pid, startTime: startTimeOf(pid) ?? '', runDir, commit: 'c', port: 4120, status: 'ready', startedAt: new Date().toISOString() };
}

describe('studioEnvironment', () => {
  test('turns on the brief’s fake media provider, so the walks can reach a generated item', () => {
    expect(studioEnvironment({ checkout: checkoutAt('/f/tree') }).MDMEDIA_FAKE_MEDIA).toBe('1');
  });
});

describe('isServedProcess', () => {
  test('accepts this run\'s served process with its recorded start time', async () => {
    const state = await lookalike('/runs/a');
    expect(isServedProcess(state, '/runs/a')).toBe(true);
  });

  test('refuses another run\'s, a different start time, or a process that isn\'t the served one', async () => {
    const state = await lookalike('/runs/a');
    expect(isServedProcess(state, '/runs/b')).toBe(false);
    expect(isServedProcess({ ...state, startTime: '1' }, '/runs/a')).toBe(false);
    const self = { ...state, pid: process.pid, startTime: startTimeOf(process.pid) ?? '' };
    expect(isServedProcess(self, '/runs/a')).toBe(false);
    expect(isServedProcess({ ...state, pid: 1, startTime: startTimeOf(1) ?? '' }, '/runs/a')).toBe(false);
  });
});

describe('servedPort', () => {
  test('takes 4120 or a valid port, and refuses anything else', () => {
    expect(servedPort({})).toBe(4120);
    expect(servedPort({ PYRIC_FACTORY_SERVED_PORT: '5000' })).toBe(5000);
    for (const bad of ['80', 'abc', '65535', '4120.5']) expect(() => servedPort({ PYRIC_FACTORY_SERVED_PORT: bad })).toThrow(ServedPortInvalid);
  });
});

const ok = (stdout: string, stderr = ''): TailscaleResult => ({ ok: true, stdout, stderr });
const fake = (answer: (args: readonly string[]) => TailscaleResult): { tailscale: Tailscale; calls: string[][] } => {
  const calls: string[][] = [];
  return { calls, tailscale: (args) => { calls.push([...args]); return answer(args); } };
};

describe('tailnetHost', () => {
  const running = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.example.net.' } });

  test('reads the name from stdout while Tailscale runs, whatever stderr says', () => {
    expect(tailnetHost({}, fake(() => ok(running, 'Warning: client version differs')).tailscale)).toBe('box.example.net');
  });

  test('is undefined with no CLI, empty or bad stdout, or a backend that isn\'t running', () => {
    expect(tailnetHost({})).toBeUndefined();
    expect(tailnetHost({}, fake(() => ok('')).tailscale)).toBeUndefined();
    expect(tailnetHost({}, fake(() => ok('Warning: not JSON')).tailscale)).toBeUndefined();
    expect(tailnetHost({}, fake(() => ok(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: 'box.' } }))).tailscale)).toBeUndefined();
    expect(tailnetHost({}, fake(() => ({ ok: false, stdout: running, stderr: '' })).tailscale)).toBeUndefined();
  });

  test('runs the binary PYRIC_FACTORY_TAILSCALE names, and none without it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-tailscale-'));
    const script = join(dir, 'tailscale');
    writeFileSync(script, `#!/bin/sh\necho "warning on stderr" >&2\necho '${running}'\n`);
    chmodSync(script, 0o755);
    expect(tailnetHost({ PYRIC_FACTORY_TAILSCALE: script })).toBe('box.example.net');
    expect(tailnetHost({ PYRIC_FACTORY_TAILSCALE: '' })).toBeUndefined();
  });
});

describe('the private-network entries', () => {
  test('ensureServed adds only missing entries and reports which it added', () => {
    const { tailscale, calls } = fake((args) => ok(args[1] === 'status' ? 'https://box.example.net:4121 (tailnet only)\n|-- / proxy http://127.0.0.1:4121' : ''));
    expect(ensureServed([4120, 4121], tailscale).added).toEqual([4120]);
    expect(calls.filter((args) => args.includes('--bg'))).toEqual([['serve', '--bg', '--https=4120', 'http://127.0.0.1:4120']]);
  });

  test('removeServed turns off each entry it is given', () => {
    const { tailscale, calls } = fake(() => ok(''));
    removeServed([4120], tailscale);
    expect(calls).toEqual([['serve', '--https=4120', 'off']]);
  });

  test('without the CLI nothing is published or removed', () => {
    expect(ensureServed([4120], undefined).added).toEqual([]);
    expect(removeServed([4120], undefined)[0]).toContain('left');
  });
});
