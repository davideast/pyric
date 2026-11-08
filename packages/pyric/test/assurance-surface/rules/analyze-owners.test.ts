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

  test('infers Storage pathVar and customMetadata ownerBindings from storage.rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owners-storage-'));
    try {
      writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ storage: { rules: 'storage.rules' } }));
      writeFileSync(
        join(dir, 'storage.rules'),
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{fileId} {
      allow write: if request.auth != null && request.auth.uid == uid;
    }
    match /items/{itemId} {
      allow create: if request.auth != null && request.resource.metadata.owner == request.auth.uid;
      allow update, delete: if request.auth != null && resource.metadata.owner == request.auth.uid;
    }
  }
}`,
      );
      const sites: AccessSite[] = [
        {
          service: 'storage',
          op: 'uploadBytes',
          path: 'files/{uid}/{fileId}',
          source: 'upload.ts:8',
          resolution: 'resolved',
          pathVariables: [
            { name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
            { name: 'fileId' },
          ],
        },
        {
          service: 'storage',
          op: 'uploadBytes',
          path: 'items/{itemId}',
          source: 'upload.ts:14',
          resolution: 'resolved',
          pathVariables: [{ name: 'itemId' }],
          payload: {
            kind: 'object',
            fields: [
              {
                name: 'owner',
                kind: 'string',
                optional: false,
                auth: [{ source: 'auth.uid', certainty: 'exact' }],
              },
            ],
            open: false,
          },
        },
      ];
      const out = analyzeOwners(dir, sites, []);
      expect(out.ruleSources).toEqual([{ service: 'storage', source: 'storage.rules' }]);
      expect(out.ownerBindings.map((b) => [b.service, b.path, b.kind, b.field, b.strength])).toEqual([
        ['storage', 'files/{uid}/{fileId}', 'pathVar', '{uid}', 'strong'],
        ['storage', 'items/{itemId}', 'incomingField', 'owner', 'strong'],
        ['storage', 'items/{itemId}', 'storedField', 'owner', 'strong'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
