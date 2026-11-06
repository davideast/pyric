// The served copy doesn't outlive its run: it stops when the process that
// started it is gone (by pid and start time) or the run's deadline passes,
// and then removes the private-network entries the run added.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTimeOf } from '../namespace.ts';
import { appPaths } from './app-paths.ts';
import { recordEntries, removeRecordedEntries } from './served-entries.ts';
import { OwnerArgsInvalid, ownerArgs, ownerGoneReason, parseOwner, watchOwner, type Owner } from './served-owner.ts';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** A process standing in for the supervisor. */
async function fakeSupervisor(): Promise<{ child: ChildProcess; owner: Owner }> {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  children.push(child);
  const pid = child.pid ?? -1;
  for (let tries = 0; tries < 100 && startTimeOf(pid) === null; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  return { child, owner: { pid, startTime: startTimeOf(pid) ?? '' } };
}

const self = (): Owner => ({ pid: process.pid, startTime: startTimeOf(process.pid) ?? '' });

describe('the served copy\'s owner', () => {
  test('a fake supervisor that dies stops the served copy, once', async () => {
    const { child, owner } = await fakeSupervisor();
    const reasons: string[] = [];
    const stop = watchOwner(owner, (reason) => reasons.push(reason), 20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reasons).toEqual([]);
    child.kill('SIGKILL');
    for (let tries = 0; tries < 100 && reasons.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();
    expect(reasons).toEqual([`the process that started it (pid ${owner.pid}) is gone`]);
  });

  test('a pid with another start time counts as gone, and a passed deadline stops it', () => {
    const now = Date.now();
    expect(ownerGoneReason(self(), now)).toBeUndefined();
    expect(ownerGoneReason({ ...self(), startTime: '1' }, now)).toContain('is gone');
    expect(ownerGoneReason({ ...self(), deadline: now + 60_000 }, now)).toBeUndefined();
    expect(ownerGoneReason({ ...self(), deadline: now - 1 }, now)).toBe('the run\'s deadline passed');
  });

  test('the owner reaches the served process through its arguments, and it refuses none', () => {
    const owner = { ...self(), deadline: Date.parse('2026-11-02T08:00:00.000Z') };
    const args = ownerArgs(owner);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(parseOwner(value)).toEqual(owner);
    expect(parseOwner((flag) => (flag === '--deadline' ? undefined : value(flag)))).toEqual(self());
    expect(() => parseOwner(() => undefined)).toThrow(OwnerArgsInvalid);
    expect(() => parseOwner((flag) => (flag === '--deadline' ? 'soon' : value(flag)))).toThrow(OwnerArgsInvalid);
  });
});

describe('removeRecordedEntries', () => {
  test('turns off only the entries the run recorded, once', () => {
    const base = mkdtempSync(join(tmpdir(), 'factory-entries-'));
    const paths = appPaths(join(base, 'run'));
    mkdirSync(paths.host, { mode: 0o700 });
    const calls = join(base, 'calls.txt');
    const script = join(base, 'tailscale');
    writeFileSync(script, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n`);
    chmodSync(script, 0o755);
    const env = { PYRIC_FACTORY_TAILSCALE: script };
    expect(removeRecordedEntries(paths, env)).toEqual([]);
    recordEntries(paths, [4120]);
    expect(removeRecordedEntries(paths, env)).toEqual(['4120: removed from the private network']);
    expect(readFileSync(calls, 'utf8')).toBe('serve --https=4120 off\n');
    expect(removeRecordedEntries(paths, env)).toEqual([]);
  });
});
