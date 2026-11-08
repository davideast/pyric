import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeOwners, withEmbeddedRules } from '../../../src/assurance-surface/rules/analyze-owners.js';
import type { AccessSite } from '../../../src/assurance-surface/code/types.js';

describe('withEmbeddedRules', () => {
  test('rules found in code are used only for a service with no rules file', () => {
    const out = withEmbeddedRules(
      { firestore: [{ source: 'firestore.rules', text: 'x' }], rtdb: [], problems: [] },
      [
        { service: 'firestore', source: 'a.ts:1', rules: 'y' },
        { service: 'rtdb', source: 'a.ts:2', rules: { rules: {} } },
      ],
    );
    expect(out.firestore.map((f) => f.source)).toEqual(['firestore.rules']);
    expect(out.rtdb.map((f) => f.source)).toEqual(['a.ts:2']);
  });
});

describe('analyzeOwners', () => {
  test('end to end over a firebase.json app', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owners-'));
    try {
      writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ database: { rules: 'db.json' } }));
      writeFileSync(join(dir, 'db.json'), JSON.stringify({ rules: { notes: { $uid: { '.write': 'auth.uid == $uid' } } } }));
      const sites: AccessSite[] = [
        { service: 'rtdb', op: 'set', path: 'notes/$uid', source: 'app.ts:3', resolution: 'resolved', pathVariables: [{ name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] }] },
      ];
      const out = analyzeOwners(dir, sites, []);
      expect(out.ruleSources).toEqual([{ service: 'rtdb', source: 'db.json' }]);
      expect(out.ownerBindings.map((b) => [b.path, b.kind, b.field, b.strength])).toEqual([['notes/$uid', 'pathVar', '$uid', 'strong']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit rules suppress both firebase.json and embedded rules for other services', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owners-explicit-'));
    try {
      writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, database: { rules: 'db.json' } }));
      writeFileSync(join(dir, 'firestore.rules'), "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /docs/{uid} { allow write: if request.auth.uid == uid; } } }");
      writeFileSync(join(dir, 'db.json'), JSON.stringify({ rules: { notes: { $uid: { '.write': 'auth.uid == $uid' } } } }));
      const explicitRtdb = join(dir, 'override.json');
      writeFileSync(explicitRtdb, JSON.stringify({ rules: { items: { $uid: { '.write': 'auth.uid == $uid' } } } }));
      const out = analyzeOwners(
        dir,
        [],
        [{ service: 'firestore', source: 'embedded.ts:1', rules: "rules_version = '2';" }],
        { rtdb: [explicitRtdb] },
      );
      expect(out.ruleSources).toEqual([{ service: 'rtdb', source: 'override.json' }]);
      expect(out.sources.firestore).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
