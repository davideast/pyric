// Serving: the newest commit that passed typecheck and app-start is served,
// labelled with the gates it fails, and last-good.json still means every
// gate passed; the pid in served.json is signalled only when /proc shows this
// run's served process with the recorded start time; the port is checked;
// the private-network host comes from Tailscale's stdout only, and only
// while it runs; the run's end removes only the entries the run added.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTimeOf } from '../namespace.ts';
import { studioEnvironment } from './app-start.ts';
import { appPaths, checkoutAt, type AppPaths } from './app-paths.ts';
import type { AppRecord } from './app-setup.ts';
import type { GateName } from './gates.ts';
import { git, headCommit } from './git.ts';
import { readLastGood } from './last-good.ts';
import { readLastServed } from './last-served.ts';
import { labelText, servedLine, serveNewest } from './serve-newest.ts';
import { isServedProcess, SERVED_PROCESS, servedPort, ServedPortInvalid, type ServedControl } from './served.ts';
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

  test('ensureServed proxies to the address the served copy listens on', () => {
    const { tailscale, calls } = fake(() => ok(''));
    ensureServed([4120], tailscale, '192.0.2.10');
    expect(calls.filter((args) => args.includes('--bg'))).toEqual([['serve', '--bg', '--https=4120', 'http://192.0.2.10:4120']]);
  });
});

interface ServedRun {
  paths: AppPaths;
  record: AppRecord;
  /** The start commit, then three commits after it. */
  commits: string[];
}

/** A run whose host repo holds the start commit and three after it. */
function servedRun(): ServedRun {
  const runDir = join(mkdtempSync(join(tmpdir(), 'factory-serve-')), 'run');
  const paths = appPaths(runDir);
  const work = join(paths.host, 'src');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  git(work, ['init', '--quiet', '--separate-git-dir', paths.gitDir]);
  const subjects = ['start', 'add the playlist page', 'fix the playlist <b>title</b>', 'move settings'];
  const commits = subjects.map((subject) => {
    git(work, ['commit', '--quiet', '--allow-empty', '-m', subject]);
    return headCommit(work);
  });
  const start = commits[0] ?? '';
  const record: AppRecord = { source: work, sourceCommit: start, startCommit: start, setupAt: new Date().toISOString(), briefDir: '/briefs/app', adaptations: [], tools: {} };
  return { paths, record, commits };
}

/** A served process that starts and stops at once, and records each start. */
function fakeControl(): ServedControl & { starts: string[] } {
  let serving: string | undefined;
  const starts: string[] = [];
  return {
    starts,
    servingCommit: () => serving,
    stop: async () => { serving = undefined; },
    start: async (commit) => {
      starts.push(commit);
      serving = commit;
      return undefined;
    },
    publish: () => ['published'],
  };
}

function serverFor(run: ServedRun, control: ServedControl) {
  return (index: number, failed: GateName[], hour = 1) => serveNewest({ paths: run.paths, record: run.record, failed, commit: run.commits[index] ?? '', hour, say: () => {}, control });
}

const short = (commit: string | undefined) => (commit ?? '').slice(0, 12);

describe('serveNewest', () => {
  test('a commit failing only tests and walks is served, labelled with those two', async () => {
    const run = servedRun();
    const outcome = await serverFor(run, fakeControl())(2, ['tests', 'walks']);
    expect(outcome.action).toBe('restart');
    expect(outcome.served).toMatchObject({ commit: run.commits[2], failing: ['tests', 'walks'], localUrl: 'http://127.0.0.1:4120/', statusUrl: 'http://127.0.0.1:4120/_factory/status' });
    expect(labelText({ commit: run.commits[2] ?? '', failing: ['tests', 'walks'] })).toBe(`serving ${short(run.commits[2])}, failing: tests, walks`);
    expect(readLastServed(run.paths.lastServed)).toMatchObject({
      commit: run.commits[2],
      failing: ['tests', 'walks'],
      since: { commit: run.commits[0], what: 'start' },
      changes: ['fix the playlist <b>title</b>', 'add the playlist page'],
    });
    expect(readLastGood(run.paths.lastGood)).toBeUndefined();
  });

  test('a commit failing app-start leaves the previous copy up', async () => {
    const run = servedRun();
    const control = fakeControl();
    const serve = serverFor(run, control);
    await serve(1, ['tests']);
    const outcome = await serve(2, ['app-start', 'walks'], 2);
    expect(outcome.action).toBe('leave');
    expect(outcome.note).toBe(`this commit failed app-start, so the served copy stays on ${short(run.commits[1])}`);
    expect(outcome.served).toMatchObject({ commit: run.commits[1], failing: ['tests'] });
    expect(control.starts).toEqual([run.commits[1] ?? '']);
    expect(readLastServed(run.paths.lastServed)?.commit).toBe(run.commits[1]);
  });

  test('the same commit with other failing gates stays up, and only its label changes', async () => {
    const run = servedRun();
    const control = fakeControl();
    const serve = serverFor(run, control);
    await serve(2, ['tests']);
    const outcome = await serve(2, ['walks', 'layout'], 2);
    expect(outcome.action).toBe('leave');
    expect(control.starts).toEqual([run.commits[2] ?? '']);
    expect(outcome.served).toMatchObject({ commit: run.commits[2], failing: ['walks', 'layout'] });
    expect(readLastServed(run.paths.lastServed)).toMatchObject({ hour: 2, failing: ['walks', 'layout'], changes: ['fix the playlist <b>title</b>', 'add the playlist page'] });
  });

  test('a newer servable commit counts its changes from the one served before it', async () => {
    const run = servedRun();
    const serve = serverFor(run, fakeControl());
    await serve(1, ['tests']);
    await serve(3, ['tests'], 2);
    expect(readLastServed(run.paths.lastServed)).toMatchObject({ since: { commit: run.commits[1], what: 'previous' }, changes: ['move settings', 'fix the playlist <b>title</b>'] });
  });

  test('when every gate passes, last-good.json is written too', async () => {
    const run = servedRun();
    const outcome = await serverFor(run, fakeControl())(1, [], 3);
    expect(readLastGood(run.paths.lastGood)).toMatchObject({ commit: run.commits[1], hour: 3 });
    expect(outcome.served?.failing).toEqual([]);
    expect(labelText({ commit: run.commits[1] ?? '', failing: [] })).toBe(`serving ${short(run.commits[1])}, every gate passed`);
  });

  test('nothing starts before a commit passes typecheck and app-start', async () => {
    const run = servedRun();
    const control = fakeControl();
    const outcome = await serverFor(run, control)(1, ['typecheck']);
    expect(outcome).toEqual({ action: 'leave', note: 'this commit failed typecheck, so nothing is served' });
    expect(control.starts).toEqual([]);
    expect(servedLine(outcome.served)).toBe('nothing is served now');
  });

  test('a start that fails records nothing as served', async () => {
    const run = servedRun();
    const control: ServedControl = { ...fakeControl(), start: async () => 'Studio exited' };
    const outcome = await serverFor(run, control)(1, ['tests']);
    expect(outcome).toEqual({ action: 'restart', note: 'the served copy failed to start: Studio exited' });
    expect(readLastServed(run.paths.lastServed)).toBeUndefined();
  });
});
