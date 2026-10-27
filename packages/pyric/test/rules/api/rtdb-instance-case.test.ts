import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rtdbRules } from '../../../src/rules/api/rtdb.js';

const dir = mkdtempSync(join(tmpdir(), 'rtdb-firebase-json-'));
writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ database: { rules: 'db.rules.json' } }));
writeFileSync(join(dir, 'db.rules.json'), JSON.stringify({ rules: { a: { '.read': "root.child('x').exists()" } } }));
const firebaseJson = join(dir, 'firebase.json');

describe('resolveInstanceCase duplicate instance names (CS-15)', () => {
  const decide = (instances: Record<string, unknown>) => rtdbRules.fromFirebaseJson(firebaseJson, { projectId: 'p' })
    .simulate([{ expectation: 'ALLOW', operation: 'read', path: '/a', data: { instances } as never }]).cases[0]!.decision;

  test('two keys naming one instance are UNSUPPORTED in either key order', () => {
    expect(decide({ 'p-default-rtdb': { x: 1 }, default: {} })).toBe('UNSUPPORTED');
    expect(decide({ default: {}, 'p-default-rtdb': { x: 1 } })).toBe('UNSUPPORTED');
  });
});
