import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultJobs, longestFirst, readDurations, recordDurations } from './schedule.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function durationsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-app-durations-'));
  dirs.push(dir);
  return join(dir, 'app-durations.json');
}

describe('the order apps start in', () => {
  test('the apps that took longest last run start first', () => {
    const durations = { 'admin-writes': 20, 'hosted-restart': 142, 'vite-ssr': 45 };
    expect(longestFirst(['admin-writes', 'hosted-restart', 'vite-ssr'], durations)).toEqual(['hosted-restart', 'vite-ssr', 'admin-writes']);
  });

  test('an app with no recorded time starts before every timed app, in name order', () => {
    const durations = { 'admin-writes': 20, 'hosted-restart': 142 };
    expect(longestFirst(['new-b', 'admin-writes', 'new-a', 'hosted-restart'], durations)).toEqual(['new-a', 'new-b', 'hosted-restart', 'admin-writes']);
  });

  test('with no recorded times the apps keep name order', () => {
    expect(longestFirst(['b', 'a', 'c'], {})).toEqual(['a', 'b', 'c']);
  });
});

describe('the recorded times', () => {
  test('a run adds its passing apps to the times already recorded, and a failing app keeps its old time', () => {
    const file = durationsFile();
    recordDurations(file, [{ name: 'a', ok: true, scenarioSeconds: 30 }, { name: 'b', ok: true, scenarioSeconds: 40 }], ['a', 'b']);
    recordDurations(file, [{ name: 'b', ok: true, scenarioSeconds: 50 }, { name: 'a', ok: false, scenarioSeconds: 300 }], ['a', 'b']);
    expect(readDurations(file)).toEqual({ a: 30, b: 50 });
  });

  test('an app that no longer exists drops out of the recorded times', () => {
    const file = durationsFile();
    recordDurations(file, [{ name: 'old-name', ok: true, scenarioSeconds: 30 }], ['old-name']);
    recordDurations(file, [{ name: 'new-name', ok: true, scenarioSeconds: 31 }], ['new-name']);
    expect(readDurations(file)).toEqual({ 'new-name': 31 });
  });

  test('a missing or unreadable file reads as no times', () => {
    const file = durationsFile();
    expect(readDurations(file)).toEqual({});
    writeFileSync(file, 'not json');
    expect(readDurations(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ a: 'slow', b: 12 }));
    expect(readDurations(file)).toEqual({ b: 12 });
  });
});

describe('how many apps run at once by default', () => {
  test('locally, one app per four free threads, at most six', () => {
    expect(defaultJobs({ threads: 32, load: 8 }, {})).toBe(6);
    expect(defaultJobs({ threads: 16, load: 4 }, {})).toBe(3);
  });

  test('a loaded machine runs fewer, and never fewer than one', () => {
    expect(defaultJobs({ threads: 32, load: 22 }, {})).toBe(2);
    expect(defaultJobs({ threads: 4, load: 9 }, {})).toBe(1);
  });

  test('on CI, one app per runner thread', () => {
    expect(defaultJobs({ threads: 4, load: 0.5 }, { CI: 'true' })).toBe(4);
    expect(defaultJobs({ threads: 4, load: 0.5 }, { CI: '1' })).toBe(4);
    expect(defaultJobs({ threads: 4, load: 0.5 }, { CI: 'false' })).toBe(1);
  });
});
