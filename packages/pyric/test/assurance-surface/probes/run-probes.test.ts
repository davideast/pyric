import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { runProbes } from '../../../src/assurance-surface/probes/run-probes.js';
import { ownerConditionsFrom } from '../../../src/assurance-surface/rules/analyze-owners.js';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/cross-check.js';
import { extractSdkUsage } from '../../../src/assurance-surface/usage.js';
import type { AccessSite } from '../../../src/assurance-surface/code/types.js';
import type { RuleSources } from '../../../src/assurance-surface/rules/rule-sources.js';

function makeSources(opts: { firestore?: string; rtdb?: unknown }): RuleSources {
  return {
    firestore: opts.firestore ? [{ source: 'firestore.rules', text: opts.firestore }] : [],
    rtdb: opts.rtdb ? [{ source: 'database.rules.json', json: opts.rtdb }] : [],
    problems: [],
  };
}

describe('runProbes', () => {
  test('does not grant admin claims from unrelated paths to peer when probing owned records', async () => {
    const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /adminLogs/{logId} {
      allow read, write: if request.auth.token.admin == true;
    }
    match /posts/{postId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.resource.data.author == request.auth.uid;
      allow update: if (resource.data.author == request.auth.uid && request.resource.data.author == resource.data.author)
        || request.auth.token.admin == true;
      allow delete: if resource.data.author == request.auth.uid
        || request.auth.token.admin == true;
    }
  }
}`;
    const sources = makeSources({ firestore: firestoreRules });
    const sites: AccessSite[] = [
      {
        service: 'firestore',
        op: 'addDoc',
        path: 'posts/{postId}',
        pathVariables: [{ name: 'postId' }],
        resolution: 'resolved',
        source: 'src/posts.ts:10',
        payload: {
          kind: 'object',
          open: false,
          fields: [
            { name: 'author', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
            { name: 'title', kind: 'string' },
          ],
        },
      },
      {
        service: 'firestore',
        op: 'deleteDoc',
        path: 'posts/{postId}',
        pathVariables: [{ name: 'postId' }],
        resolution: 'resolved',
        source: 'src/posts.ts:18',
      },
      {
        service: 'firestore',
        op: 'addDoc',
        path: 'adminLogs/{logId}',
        pathVariables: [{ name: 'logId' }],
        resolution: 'resolved',
        source: 'src/admin.ts:6',
        payload: {
          kind: 'object',
          open: false,
          fields: [{ name: 'event', kind: 'string' }],
        },
      },
    ];
    const conditions = ownerConditionsFrom(sources);
    const bindings = inferOwnerBindings(conditions, sites);
    const report = await runProbes({
      accessSites: sites,
      ownerBindings: bindings,
      conditions,
      sources,
    });

    expect(report.probes.total).toBeGreaterThan(0);
    expect(report.probes.invalid).toBe(0);
    const postFindings = report.findings.filter((f) => f.path === 'posts/{postId}');
    expect(postFindings).toEqual([]);
  });

  test('seeds multi-actor membership lookup records without wiping owner membership', async () => {
    const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/items/{itemId} {
      allow read: if exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid));
      allow create: if exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid))
        && request.resource.data.ownerId == request.auth.uid;
      allow delete: if exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid));
    }
  }
}`;
    const sources = makeSources({ firestore: firestoreRules });
    const sites: AccessSite[] = [
      {
        service: 'firestore',
        op: 'addDoc',
        path: 'orgs/{orgId}/items/{itemId}',
        pathVariables: [{ name: 'orgId' }, { name: 'itemId' }],
        resolution: 'resolved',
        source: 'src/items.ts:12',
        payload: {
          kind: 'object',
          open: false,
          fields: [
            { name: 'ownerId', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
            { name: 'label', kind: 'string' },
          ],
        },
      },
      {
        service: 'firestore',
        op: 'deleteDoc',
        path: 'orgs/{orgId}/items/{itemId}',
        pathVariables: [{ name: 'orgId' }, { name: 'itemId' }],
        resolution: 'resolved',
        source: 'src/items.ts:20',
      },
    ];
    const conditions = ownerConditionsFrom(sources);
    const bindings = inferOwnerBindings(conditions, sites);
    const report = await runProbes({
      accessSites: sites,
      ownerBindings: bindings,
      conditions,
      sources,
    });

    expect(report.probes.invalid).toBe(0);
    expect(
      report.findings.some((f) => f.kind === 'foreign-delete' && f.path === 'orgs/{orgId}/items/{itemId}'),
    ).toBe(true);
  });

  test('detects must-allow-denied when sibling teardown removes participant before session cleanup', async () => {
    const rtdbRules = {
      rules: {
        rooms: {
          $roomId: {
            call: {
              participants: {
                $uid: {
                  '.read': 'auth != null',
                  '.write': 'auth != null && auth.uid === $uid',
                },
              },
              sessions: {
                $from: {
                  $to: {
                    '.read': 'auth != null && (auth.uid === $from || auth.uid === $to)',
                    '.write': 'auth != null && auth.uid === $from && root.child("rooms").child($roomId).child("call").child("participants").child(auth.uid).exists()',
                  },
                },
              },
            },
          },
        },
      },
    };
    const sources = makeSources({ rtdb: rtdbRules });
    const sites: AccessSite[] = [
      {
        service: 'rtdb',
        op: 'set',
        path: 'rooms/$roomId/call/participants/$uid',
        pathVariables: [
          { name: 'roomId' },
          { name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
        ],
        resolution: 'resolved',
        source: 'src/call.ts:14',
        payload: {
          kind: 'object',
          open: false,
          fields: [{ name: 'joinedAt', kind: 'serverTimestamp' }],
        },
      },
      {
        service: 'rtdb',
        op: 'remove',
        path: 'rooms/$roomId/call/participants/$uid',
        pathVariables: [
          { name: 'roomId' },
          { name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
        ],
        resolution: 'resolved',
        source: 'src/call.ts:18',
      },
      {
        service: 'rtdb',
        op: 'set',
        path: 'rooms/$roomId/call/sessions/$from/$to',
        pathVariables: [
          { name: 'roomId' },
          { name: 'from', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
          { name: 'to' },
        ],
        resolution: 'resolved',
        source: 'src/call.ts:24',
        payload: {
          kind: 'object',
          open: false,
          fields: [{ name: 'sdp', kind: 'string' }],
        },
      },
      {
        service: 'rtdb',
        op: 'remove',
        path: 'rooms/$roomId/call/sessions/$from/$to',
        pathVariables: [
          { name: 'roomId' },
          { name: 'from', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
          { name: 'to' },
        ],
        resolution: 'resolved',
        source: 'src/call.ts:30',
      },
    ];
    const conditions = ownerConditionsFrom(sources);
    const bindings = inferOwnerBindings(conditions, sites);
    const report = await runProbes({
      accessSites: sites,
      ownerBindings: bindings,
      conditions,
      sources,
    });

    expect(
      report.findings.some(
        (f) =>
          f.kind === 'must-allow-denied' &&
          f.op === 'delete' &&
          f.path === 'rooms/$roomId/call/sessions/$from/$to',
      ),
    ).toBe(true);
  });

  test('runs end-to-end Storage probes against named client buckets governed by unscoped wildcard /b/{bucket}/o rules', async () => {
    const clientFiles = {
      'src/upload.ts': [
        "import 'fake-indexeddb/auto';",
        "import { getAuth } from 'firebase/auth';",
        "import { getStorage, ref, uploadBytes } from 'firebase/storage';",
        'export async function uploadNamedBucketDoc(fileId: string, bytes: Uint8Array, tier: string) {',
        '  const uid = getAuth().currentUser!.uid;',
        "  const storage = getStorage(undefined, 'gs://my-app.firebasestorage.app');",
        '  await uploadBytes(ref(storage, `files/${uid}/${fileId}`), bytes, {',
        "    contentType: 'image/png',",
        '    customMetadata: { tier },',
        '  });',
        '}',
      ].join('\n'),
    };
    const accessSites = [...extractSdkUsage({ root: 'app', files: clientFiles }).operations];

    const fixedRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{fileId} {
      allow read, create, update, delete: if request.auth != null
        && request.auth.uid == uid
        && (request.resource == null || (
          request.resource.contentType.matches('image/.*')
          && request.resource.metadata.tier == 'pro'
        ));
    }
  }
}`;
    const fixedSources: RuleSources = {
      firestore: [],
      rtdb: [],
      storage: [{ source: 'storage.rules', text: fixedRules }],
      problems: [],
    };
    const fixedConditions = ownerConditionsFrom(fixedSources);
    const fixedBindings = inferOwnerBindings(fixedConditions, accessSites);
    const fixedReport = await runProbes({
      accessSites,
      ownerBindings: fixedBindings,
      conditions: fixedConditions,
      sources: fixedSources,
    });
    expect(fixedReport.probes.total).toBeGreaterThan(0);
    expect(fixedReport.probes.invalid).toBe(0);
    expect(fixedReport.findings).toEqual([]);

    const buggyRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{fileId} {
      allow read, write: if request.auth != null;
    }
  }
}`;
    const buggySources: RuleSources = {
      firestore: [],
      rtdb: [],
      storage: [{ source: 'storage.rules', text: buggyRules }],
      problems: [],
    };
    const buggyConditions = ownerConditionsFrom(buggySources);
    const buggyBindings = inferOwnerBindings(buggyConditions, accessSites);
    const buggyReport = await runProbes({
      accessSites,
      ownerBindings: buggyBindings,
      conditions: buggyConditions,
      sources: buggySources,
    });
    expect(
      buggyReport.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'files/{uid}/{fileId}'
          && f.kind === 'foreign-slot-write'
          && f.status === 'proven',
      ),
    ).toBe(true);
  });

  test('evaluates updateMetadata must-allow-denied probes for MIME mismatches, update-only MIME seeds, and missing customMetadata', async () => {
    const updateOnlyMimeRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /assets/{uid}/{assetId} {
      allow create: if request.auth != null && request.auth.uid == uid;
      allow update: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*')
        && 'reviewedBy' in request.resource.metadata;
    }
  }
}`;
    const sources: RuleSources = {
      firestore: [],
      rtdb: [],
      storage: [{ source: 'storage.rules', text: updateOnlyMimeRules }],
      problems: [],
    };
    const conditions = ownerConditionsFrom(sources);

    // 1. Valid updateMetadata (omits contentType so seeded image/png is preserved, and passes reviewedBy) -> 0 findings, 0 invalid
    const validSites = [
      ...extractSdkUsage({
        root: 'app',
        files: {
          'src/meta.ts': [
            "import { getAuth } from 'firebase/auth';",
            "import { getStorage, ref, updateMetadata } from 'firebase/storage';",
            'export async function markReviewed(assetId: string) {',
            '  const uid = getAuth().currentUser!.uid;',
            '  await updateMetadata(ref(getStorage(), `assets/${uid}/${assetId}`), {',
            '    customMetadata: { reviewedBy: uid },',
            '  });',
            '}',
          ].join('\n'),
        },
      }).operations,
    ];
    const validReport = await runProbes({
      accessSites: validSites,
      ownerBindings: inferOwnerBindings(conditions, validSites),
      conditions,
      sources,
    });
    expect(validReport.probes.invalid).toBe(0);
    expect(validReport.findings).toEqual([]);

    // 2. Bad MIME on updateMetadata (application/pdf vs image/.*) -> must-allow-denied
    const badMimeSites = [
      ...extractSdkUsage({
        root: 'app',
        files: {
          'src/bad-mime.ts': [
            "import { getAuth } from 'firebase/auth';",
            "import { getStorage, ref, updateMetadata } from 'firebase/storage';",
            'export async function setPdfMime(assetId: string) {',
            '  const uid = getAuth().currentUser!.uid;',
            '  await updateMetadata(ref(getStorage(), `assets/${uid}/${assetId}`), {',
            "    contentType: 'application/pdf',",
            '    customMetadata: { reviewedBy: uid },',
            '  });',
            '}',
          ].join('\n'),
        },
      }).operations,
    ];
    const badMimeReport = await runProbes({
      accessSites: badMimeSites,
      ownerBindings: inferOwnerBindings(conditions, badMimeSites),
      conditions,
      sources,
    });
    expect(
      badMimeReport.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'assets/{uid}/{assetId}'
          && f.kind === 'must-allow-denied'
          && f.op === 'update',
      ),
    ).toBe(true);

    // 3. Missing customMetadata on updateMetadata (passes contentType: 'image/png' without customMetadata) -> must-allow-denied
    const missingMetaSites = [
      ...extractSdkUsage({
        root: 'app',
        files: {
          'src/no-meta.ts': [
            "import { getAuth } from 'firebase/auth';",
            "import { getStorage, ref, updateMetadata } from 'firebase/storage';",
            'export async function touchMimeOnly(assetId: string) {',
            '  const uid = getAuth().currentUser!.uid;',
            '  await updateMetadata(ref(getStorage(), `assets/${uid}/${assetId}`), {',
            "    contentType: 'image/png',",
            '  });',
            '}',
          ].join('\n'),
        },
      }).operations,
    ];
    const missingMetaReport = await runProbes({
      accessSites: missingMetaSites,
      ownerBindings: inferOwnerBindings(conditions, missingMetaSites),
      conditions,
      sources,
    });
    expect(
      missingMetaReport.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'assets/{uid}/{assetId}'
          && f.kind === 'must-allow-denied'
          && f.op === 'update',
      ),
    ).toBe(true);
  });
});
