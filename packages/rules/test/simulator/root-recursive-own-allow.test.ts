/**
 * Replays the root recursive `match /{path=**}` observations (`c4a`, `c4c`,
 * `c5e`, plus `c4b` control) and verifies multi-segment `$(rest)` splicing
 * from `{rest=**}` inside `get()` and `exists()` (#1894).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firestoreRules } from '../../src/index.js';

interface ObservationFile {
  behavior: Record<string, 'ALLOW' | 'DENY'>;
  diagnostics?: Record<string, { notes?: string[] }>;
}

function readObs(name: string): ObservationFile {
  return JSON.parse(
    readFileSync(
      join(import.meta.dir, `../../../conformance/observations/firestore-rules/${name}`),
      'utf-8',
    ),
  ) as ObservationFile;
}

describe('root recursive match /{path=**} own allow rules and path binding (#1894)', () => {
  test('c4a: root match /{path=**} own allow read grants get c/1 and list c', () => {
    const obs = readObs('rules-firestore-root-recursive-with-own-allow.json');
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /{path=**} {
    allow read: if true;
  }
}`);
    const report = ruleset.simulate([
      {
        description: 'root recursive own allow grants get c/1',
        expectation: obs.behavior['root recursive own allow grants get c/1'] ?? 'ALLOW',
        method: 'get',
        path: 'c/1',
      },
      {
        description: 'root recursive own allow grants list c',
        expectation: obs.behavior['root recursive own allow grants list c'] ?? 'ALLOW',
        method: 'list',
        path: 'c',
      },
    ]);
    expect(report.passed).toBe(2);
  });

  test('c4c: root match /{path=**} binds path to full resource name as a rules.Path', () => {
    const obs = readObs('rules-firestore-root-recursive-path-value.json');
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /{path=**} {
    allow get: if path is path && path == path('databases/(default)/documents/c/1');
  }
}`);
    const report = ruleset.simulate([
      {
        description: 'root recursive binds the full resource name',
        expectation: obs.behavior['root recursive binds the full resource name'] ?? 'ALLOW',
        method: 'get',
        path: 'c/1',
      },
      {
        description: 'different document path does not match c/1',
        expectation: 'DENY',
        method: 'get',
        path: 'c/2',
      },
    ]);
    expect(report.passed).toBe(2);
  });

  test('c5e: root match /{path=**} own allow write grants signed-in create and denies signed-out create', () => {
    const obs = readObs('rules-firestore-root-recursive-own-allow-write.json');
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /{path=**} {
    allow write: if request.auth.uid != null;
  }
}`);
    const report = ruleset.simulate([
      {
        description: 'root /{path=**} own write rule, signed out create c/1',
        expectation: obs.behavior['root /{path=**} own write rule, signed out create c/1'] ?? 'DENY',
        method: 'create',
        path: 'c/1',
        data: { x: 1 },
      },
      {
        description: 'root /{path=**} own write rule, signed in create c/1',
        expectation: obs.behavior['root /{path=**} own write rule, signed in create c/1'] ?? 'ALLOW',
        method: 'create',
        path: 'c/1',
        auth: { uid: 'u1' },
        data: { x: 1 },
      },
    ]);
    expect(report.passed).toBe(2);
    expect(report.cases[0]?.decision).toBe('DENY');
    expect(report.cases[1]?.decision).toBe('ALLOW');
  });

  test('c4b control: own allow on non-recursive /databases/{database}/documents grants nothing', () => {
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    allow read: if true;
  }
}`);
    const report = ruleset.simulate([
      {
        description: 'root documents block does not reach c/1 on its own',
        expectation: 'DENY',
        method: 'get',
        path: 'c/1',
      },
    ]);
    expect(report.passed).toBe(1);
  });

  test('splices multi-segment $(rest) from {rest=**} into get() and exists() paths', () => {
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /mirrors/{mirrorId}/{rest=**} {
      allow get: if rest is path
        && exists(/databases/$(database)/documents/originals/$(mirrorId)/$(rest))
        && get(/databases/$(database)/documents/originals/$(mirrorId)/$(rest)).data.published == true;
    }
  }
}`);
    const report = ruleset.simulate([
      {
        description: 'multi-segment {rest=**} resolves originals/m1/orgs/o1/docs/d1',
        expectation: 'ALLOW',
        method: 'get',
        path: 'mirrors/m1/orgs/o1/docs/d1',
        functionMocks: [
          { function: 'exists', path: 'originals/m1/orgs/o1/docs/d1', result: true },
          { function: 'get', path: 'originals/m1/orgs/o1/docs/d1', result: { published: true } },
        ],
      },
    ]);
    expect(report.passed).toBe(1);
    expect(report.cases[0]?.decision).toBe('ALLOW');
  });
});
