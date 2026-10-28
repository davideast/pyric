/**
 * A Firestore case fixture with a case the case check refuses is reported on
 * rules reload, not skipped silently (#1338).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProjectFixturesOnRulesReload } from '../../src/serve/rules-fixture-check.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} { allow read: if true; }
  }
}`;

const dirs: string[] = [];

function projectWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-fixture-check-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'fixtures'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'fixtures', name), JSON.stringify(body));
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runProjectFixturesOnRulesReload with Firestore case fixtures', () => {
  it('reports a fixture whose case the case check refuses', async () => {
    const projectDir = projectWith({
      'typo.json': [{ description: 'read', expectation: 'ALLOW', method: 'get', path: 'notes/n1', existingData: {} }],
      'ok.json': [{ description: 'read', expectation: 'ALLOW', method: 'get', path: 'notes/n1' }],
    });

    const summary = await runProjectFixturesOnRulesReload({ projectDir, service: 'firestore', firestoreRules: RULES });

    expect(summary.ran).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.lines.some((line) => line.includes('[typo] not checked, case 0') && line.includes("'existingData'"))).toBe(true);
  });

  it('leaves another service\'s case list alone', async () => {
    const projectDir = projectWith({
      'rtdb.json': { cases: [{ expectation: 'ALLOW', operation: 'read', path: '/a' }] },
    });

    const summary = await runProjectFixturesOnRulesReload({ projectDir, service: 'firestore', firestoreRules: RULES });

    expect(summary.ran).toBe(0);
    expect(summary.lines).toEqual([]);
  });
});
