import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rtdbRules } from '../../../src/rules/api/rtdb.js';

const dir = mkdtempSync(join(tmpdir(), 'rtdb-firebase-json-'));
writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ database: { rules: 'db.rules.json' } }));
writeFileSync(join(dir, 'db.rules.json'), JSON.stringify({ rules: { a: { '.read': "root.child('x').exists()" } } }));
const firebaseJson = join(dir, 'firebase.json');

describe('loadFirebaseJsonRules project id (CS-15)', () => {
  test("projectId '' is unset, not the instance '-default-rtdb'", () => {
    const result = rtdbRules.fromFirebaseJson(firebaseJson, { projectId: '' })
      .simulate([{ expectation: 'ALLOW', operation: 'read', path: '/a' }]).cases[0]!;
    expect(result.instance).not.toBe('-default-rtdb');
  });
});
