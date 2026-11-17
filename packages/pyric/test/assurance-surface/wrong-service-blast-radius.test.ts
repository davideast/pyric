import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coverageMatrixPass,
  extractSdkUsage,
  loadRuleSources,
  projectRuleSurface,
  staticQueryProofPass,
  validateRulesSourceSyntax,
} from '../../src/assurance-surface/usage.js';
import { firestoreRequiredClaims } from '../../src/assurance-surface/rules/claims.js';
import { firestoreOwnerConditions } from '../../src/assurance-surface/rules/firestore-owners.js';
import { firestoreValueHints } from '../../src/assurance-surface/rules/value-hints.js';
import { InspectFirestoreRulesHandler } from '../../src/rules-production/inspect/handler.js';

const STORAGE_ALLOW_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const UNKNOWN_FOO_BAR = `rules_version = '2';
service foo.bar {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const HALLUCINATED_FIREBASE_FIRESTORE = `rules_version = '2';
service firebase.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow read, write: if request.auth != null &&
        request.auth.token.role == 'editor' &&
        resource.data.ownerId == request.auth.uid &&
        request.resource.data.status == 'published';
    }
  }
}`;

const MULTI_SERVICE_WITH_HALLUCINATED = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow read, write: if false;
    }
  }
}
service firebase.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const DUPLICATE_FIRESTORE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} { allow read: if true; }
  }
}
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} { allow read: if false; }
  }
}`;

const CLIENT_USAGE = extractSdkUsage({
  root: '/virtual/wrong-service-check',
  files: {
    'src/app.ts': `
      import { getFirestore, collection, collectionGroup, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
      export async function run() {
        const db = getFirestore();
        await getDocs(collection(db, 'posts'));
        await getDocs(collectionGroup(db, 'comments'));
        await getDoc(doc(db, 'posts', 'p1'));
        await setDoc(doc(db, 'posts', 'p1'), { status: 'draft' });
      }
    `,
  },
});

describe('wrong-service ruleset blast radius across assurance and inspect (#1434)', () => {
  test.each([
    ['service firebase.storage', STORAGE_ALLOW_ALL],
    ['service foo.bar', UNKNOWN_FOO_BAR],
    ['service firebase.firestore', HALLUCINATED_FIREBASE_FIRESTORE],
    ['multi-service with dead firebase.firestore', MULTI_SERVICE_WITH_HALLUCINATED],
  ])('staticQueryProofPass emits firestore-unprovable-list-query for collection and collectionGroup queries under %s', (_label, rules) => {
    const diags = staticQueryProofPass(CLIENT_USAGE, rules);
    const listDiags = diags.filter((d) => d.code === 'firestore-unprovable-list-query');
    expect(listDiags).toHaveLength(2);
  });

  test('staticQueryProofPass still returns [] when Firestore rules have unparseable syntax', () => {
    const broken = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n";
    expect(staticQueryProofPass(CLIENT_USAGE, broken)).toEqual([]);
  });

  test.each([
    ['service firebase.storage', STORAGE_ALLOW_ALL],
    ['service foo.bar', UNKNOWN_FOO_BAR],
    ['service firebase.firestore', HALLUCINATED_FIREBASE_FIRESTORE],
  ])('projectRuleSurface, owners, valueHints, claims, and coverageMatrixPass treat %s as zero grants', (_label, rules) => {
    const surface = projectRuleSurface({ firestore: rules });
    expect(surface.entries).toEqual([]);
    expect(firestoreOwnerConditions(rules, 'firestore.rules')).toEqual([]);
    expect(firestoreValueHints(rules)).toEqual([]);
    expect(firestoreRequiredClaims(rules, { path: 'posts/p1', op: 'get' })).toEqual({});

    const covDiags = coverageMatrixPass(CLIENT_USAGE, surface).filter(
      (d) => d.code === 'uncovered-client-operation',
    );
    expect(covDiags.length).toBeGreaterThanOrEqual(4);
  });

  test('multi-service file with cloud.firestore deny and firebase.firestore allow-all does not fail open in coverageMatrixPass', () => {
    const surface = projectRuleSurface({ firestore: MULTI_SERVICE_WITH_HALLUCINATED });
    expect(surface.entries.every((e) => e.alwaysDeny === true)).toBe(true);
    const covDiags = coverageMatrixPass(CLIENT_USAGE, surface).filter(
      (d) => d.code === 'uncovered-client-operation',
    );
    expect(covDiags.length).toBeGreaterThanOrEqual(4);
  });

  test('validateRulesSourceSyntax and loadRuleSources accept non-Firestore services for Firestore while keeping Storage strict and rejecting duplicates', () => {
    expect(validateRulesSourceSyntax(STORAGE_ALLOW_ALL, 'cloud.firestore')).toEqual({ ok: true });
    expect(validateRulesSourceSyntax(UNKNOWN_FOO_BAR, 'cloud.firestore')).toEqual({ ok: true });
    expect(validateRulesSourceSyntax(HALLUCINATED_FIREBASE_FIRESTORE, 'cloud.firestore')).toEqual({ ok: true });
    expect(validateRulesSourceSyntax(DUPLICATE_FIRESTORE, 'cloud.firestore')).toMatchObject({
      ok: false,
      message: expect.stringContaining('Duplicate service name declaration.'),
    });
    expect(validateRulesSourceSyntax(UNKNOWN_FOO_BAR, 'firebase.storage')).toEqual({
      ok: false,
      message: "Missing 'service firebase.storage' block.",
    });

    const tempDir = mkdtempSync(join(tmpdir(), 'pyric-wrong-svc-src-'));
    try {
      writeFileSync(join(tempDir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' } }));
      writeFileSync(join(tempDir, 'firestore.rules'), STORAGE_ALLOW_ALL);
      const loaded = loadRuleSources(tempDir);
      expect(loaded.problems).toEqual([]);
      expect(loaded.firestore).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('InspectFirestoreRulesHandler ignores non-Firestore service blocks in standalone and multi-service rulesets', async () => {
    const origFetch = globalThis.fetch;
    const runInspect = async (content: string) => {
      globalThis.fetch = (async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes('/rulesets?')) {
          return new Response(
            JSON.stringify({
              rulesets: [{ name: 'projects/demo-proj/rulesets/rs1', createTime: '2026-11-17T00:00:00Z', metadata: { services: ['cloud.firestore'] } }],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            createTime: '2026-11-17T00:00:00Z',
            source: { files: [{ name: 'firestore.rules', content }] },
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      try {
        return await new InspectFirestoreRulesHandler().execute({
          projectId: 'demo-proj',
          resolveToken: async () => 'tok',
        });
      } finally {
        globalThis.fetch = origFetch;
      }
    };

    const standaloneRes = await runInspect(HALLUCINATED_FIREBASE_FIRESTORE);
    expect(standaloneRes.success).toBe(true);
    if (standaloneRes.success) {
      expect(standaloneRes.data.summary.matchPaths).toEqual([]);
      expect(standaloneRes.data.summary.publicReadPaths).toEqual([]);
      expect(standaloneRes.data.summary.publicWritePaths).toEqual([]);
      expect(standaloneRes.data.summary.totalAllowRules).toBe(0);
      expect(standaloneRes.data.findings).toEqual([]);
    }

    const multiContent = `${STORAGE_ALLOW_ALL}\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /notes/{id} {\n      allow get: if request.auth != null;\n    }\n  }\n}`;
    const multiRes = await runInspect(multiContent);
    expect(multiRes.success).toBe(true);
    if (multiRes.success) {
      expect(multiRes.data.summary.matchPaths).toEqual(['/notes/{id}']);
      expect(multiRes.data.summary.publicReadPaths).toEqual([]);
      expect(multiRes.data.summary.publicWritePaths).toEqual([]);
    }
  });
});
