/**
 * The RTDB rules simulator treats the legacy default instance name, the
 * project id, as the default instance (#1062): a case may name it, and a
 * `firebase.json` entry for it deploys the default instance's rules.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rtdbRules } from 'pyric/rules';

const PROJECT = 'legacy-sim';
const RULES = JSON.stringify({
  rules: {
    open: { '.read': true, '.write': true },
    closed: { '.read': false, '.write': false },
  },
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project directory holding `files`, keyed by name. Returns its firebase.json path. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-rtdb-legacy-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return join(dir, 'firebase.json');
}

const cases = (instance: string) => [
  { expectation: 'ALLOW' as const, operation: 'write' as const, instance, path: '/open/a', newData: 1 },
  { expectation: 'DENY' as const, operation: 'write' as const, instance, path: '/closed/a', newData: 1 },
];

describe('rtdbRules.fromFirebaseJson with the legacy default instance name', () => {
  test('a case on <projectId> runs on the default instance of a single database object', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: { rules: 'database.rules.json' } }),
      '.firebaserc': JSON.stringify({ projects: { default: PROJECT } }),
      'database.rules.json': RULES,
    });
    const ruleset = rtdbRules.fromFirebaseJson(firebaseJson);
    for (const instance of [PROJECT, `https://${PROJECT}.firebaseio.com`]) {
      const summary = ruleset.simulate(cases(instance));
      expect([instance, summary.passed, summary.failed, summary.unsupported]).toEqual([instance, 2, 0, 0]);
    }
  });

  test('an instance array entry for <projectId> gives a case without an instance its rules', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: [{ instance: PROJECT, rules: 'database.rules.json' }] }),
      'database.rules.json': RULES,
    });
    const summary = rtdbRules.fromFirebaseJson(firebaseJson, { projectId: PROJECT }).simulate([
      { expectation: 'ALLOW', operation: 'write', path: '/open/a', newData: 1 },
      { expectation: 'DENY', operation: 'write', path: '/closed/a', newData: 1 },
    ]);
    expect([summary.passed, summary.failed, summary.unsupported]).toEqual([2, 0, 0]);
  });

  test('per-instance data under <projectId> is the default instance tree', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: { rules: 'reader.rules.json' } }),
      'reader.rules.json': JSON.stringify({ rules: { doc: { '.read': "root.child('flag').val() === true" } } }),
    });
    const summary = rtdbRules.fromFirebaseJson(firebaseJson, { projectId: PROJECT }).simulate([
      { expectation: 'ALLOW', operation: 'read', path: '/doc', data: { instances: { [PROJECT]: { flag: true } } } },
    ]);
    expect([summary.passed, summary.failed, summary.unsupported]).toEqual([1, 0, 0]);
  });
});
