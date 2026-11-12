import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { extractAccessSites } from '../../../src/assurance-surface/code/extractor.js';
import { runProbes } from '../../../src/assurance-surface/probes/run-probes.js';
import { synthesizeMatchingContentType } from '../../../src/assurance-surface/probes/storage-step-builder.js';
import { ownerConditionsFrom } from '../../../src/assurance-surface/rules/analyze-owners.js';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/cross-check.js';
import type { RuleSources } from '../../../src/assurance-surface/rules/rule-sources.js';

function extractClientSites(code: string) {
  return extractAccessSites({ root: '/app', files: { 'client.ts': code } }).accessSites;
}

const FIRESTORE_ORG_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/members/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

describe('synthesizeMatchingContentType', () => {
  test('synthesizes valid MIME strings for common and custom Storage regex patterns', () => {
    expect(synthesizeMatchingContentType(undefined)).toBe('application/octet-stream');
    expect(synthesizeMatchingContentType('image/.*')).toBe('image/png');
    expect(synthesizeMatchingContentType('image/(jpeg|webp)')).toBe('image/jpeg');
    expect(synthesizeMatchingContentType('application/pdf')).toBe('application/pdf');
    expect(synthesizeMatchingContentType('video/.*')).toBe('video/mp4');
    expect(synthesizeMatchingContentType('application/vnd\\.custom\\..+')).toMatch(
      /^application\/vnd\.custom\..+$/,
    );
  });
});

describe('Storage assurance probe families', () => {
  test('reproduces all 5 Storage defect families with <= 25% invalid rate on buggy rules', async () => {
    const clientCode = `
import { getAuth } from 'firebase/auth';
import {
  deleteObject,
  getDownloadURL,
  getStorage,
  ref,
  updateMetadata,
  uploadBytes,
} from 'firebase/storage';

const auth = getAuth();
const storage = getStorage();

export async function uploadBadMimeAvatar(bytes: Uint8Array) {
  const uid = auth.currentUser!.uid;
  // Bug 1a: client sends application/pdf, rule requires image/.*
  await uploadBytes(ref(storage, \`avatars/\${uid}/profile\`), bytes, {
    contentType: 'application/pdf',
  });
}

export async function uploadOversizedThumb() {
  const uid = auth.currentUser!.uid;
  // Bug 1b: client uploads 2048 bytes, rule caps thumbs at < 1024 bytes
  await uploadBytes(ref(storage, \`thumbs/\${uid}/icon\`), new Uint8Array(2048), {
    contentType: 'image/png',
  });
}

export async function uploadUserFile(fileId: string, bytes: Uint8Array) {
  const uid = auth.currentUser!.uid;
  await uploadBytes(ref(storage, \`files/\${uid}/\${fileId}\`), bytes, {
    contentType: 'image/png',
  });
}

export async function deleteUserFile(fileId: string) {
  const uid = auth.currentUser!.uid;
  await deleteObject(ref(storage, \`files/\${uid}/\${fileId}\`));
}

export async function createOwnedUpload(uploadId: string, bytes: Uint8Array) {
  const uid = auth.currentUser!.uid;
  await uploadBytes(ref(storage, \`uploads/\${uploadId}\`), bytes, {
    contentType: 'image/png',
    customMetadata: { ownerId: uid, label: 'draft' },
  });
}

export async function relabelOwnedUpload(uploadId: string) {
  const uid = auth.currentUser!.uid;
  await updateMetadata(ref(storage, \`uploads/\${uploadId}\`), {
    customMetadata: { ownerId: uid, label: 'published' },
  });
}

export async function uploadOrgAsset(orgId: string, assetId: string, bytes: Uint8Array) {
  await uploadBytes(ref(storage, \`orgs/\${orgId}/assets/\${assetId}\`), bytes, {
    contentType: 'application/pdf',
  });
}

export async function downloadOrgAsset(orgId: string, assetId: string) {
  return getDownloadURL(ref(storage, \`orgs/\${orgId}/assets/\${assetId}\`));
}
`;

    const buggyStorageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /avatars/{uid}/{slot} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create, update: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*')
        && request.resource.size < 5 * 1024 * 1024;
    }
    match /thumbs/{uid}/{slot} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create, update: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*')
        && request.resource.size < 1024;
    }
    match /files/{uid}/{fileId} {
      allow read: if request.auth != null && request.auth.uid == uid;
      // Bug 2 & 3: forgot request.auth.uid == uid on create/update and delete!
      allow create, update: if request.auth != null
        && request.resource.contentType.matches('image/.*');
      allow delete: if request.auth != null;
    }
    match /uploads/{uploadId} {
      allow read: if request.auth != null;
      // Bug 4a & 4b: create only checks ownerId != null (allows forging ownerId),
      // and update only checks request.resource.metadata.ownerId == request.auth.uid
      // without checking existing resource.metadata.ownerId (allows metadata hijack)!
      allow create: if request.auth != null
        && request.resource.contentType.matches('image/.*')
        && request.resource.metadata.ownerId != null;
      allow update: if request.auth != null
        && request.resource.metadata.ownerId == request.auth.uid;
      allow delete: if request.auth != null
        && resource.metadata.ownerId == request.auth.uid;
    }
    match /orgs/{orgId}/assets/{assetId} {
      // Bug 5: forgot firestore.exists / firestore.get org membership check on both read and write!
      allow read: if request.auth != null;
      allow write: if request.auth != null
        && (request.resource == null || request.resource.contentType == 'application/pdf');
    }
  }
}`;

    const accessSites = extractClientSites(clientCode);
    const sources: RuleSources = {
      firestore: [{ source: 'firestore.rules', text: FIRESTORE_ORG_RULES }],
      rtdb: [],
      storage: [{ source: 'storage.rules', text: buggyStorageRules }],
      problems: [],
    };
    const conditions = ownerConditionsFrom(sources);
    const ownerBindings = inferOwnerBindings(conditions, accessSites);

    const report = await runProbes({
      accessSites,
      ownerBindings,
      conditions,
      sources,
      users: [
        { uid: 'u-alice', email: 'alice@example.test', displayName: 'Alice' },
        { uid: 'u-bob', email: 'bob@example.test', displayName: 'Bob' },
      ],
    });

    expect(report.probes.total).toBeGreaterThan(0);
    const invalidRate = report.probes.invalid / report.probes.total;
    expect(invalidRate).toBeLessThanOrEqual(0.25);
    expect(report.probes.invalid).toBe(0);

    // 1. must-allow-denied on MIME mismatch and byte-size mismatch
    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'avatars/{uid}/profile'
          && f.kind === 'must-allow-denied'
          && f.status === 'proven',
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'thumbs/{uid}/icon'
          && f.kind === 'must-allow-denied'
          && f.status === 'proven',
      ),
    ).toBe(true);

    // 2. foreign-slot-write on UID-keyed path
    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'files/{uid}/{fileId}'
          && f.kind === 'foreign-slot-write'
          && f.status === 'proven',
      ),
    ).toBe(true);

    // 3. foreign-delete on UID-keyed path
    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'files/{uid}/{fileId}'
          && f.kind === 'foreign-delete'
          && f.status === 'proven',
      ),
    ).toBe(true);

    // 4. metadata-owner-forge on customMetadata.ownerId (create forge + update hijack)
    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'uploads/{uploadId}'
          && f.kind === 'metadata-owner-forge'
          && f.op === 'create',
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'uploads/{uploadId}'
          && f.kind === 'metadata-owner-forge'
          && f.op === 'update',
      ),
    ).toBe(true);

    // 5. Cross-service non-member upload and read allowed
    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'orgs/{orgId}/assets/{assetId}'
          && f.kind === 'foreign-slot-write'
          && f.op === 'write'
          && f.status === 'proven',
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'orgs/{orgId}/assets/{assetId}'
          && f.kind === 'foreign-slot-write'
          && f.op === 'read'
          && f.status === 'proven',
      ),
    ).toBe(true);
  });

  test('produces zero false positives and zero invalid probes when all Storage and cross-service rules are fixed', async () => {
    const fixedClientCode = `
import { getAuth } from 'firebase/auth';
import {
  deleteObject,
  getDownloadURL,
  getStorage,
  ref,
  updateMetadata,
  uploadBytes,
} from 'firebase/storage';

const auth = getAuth();
const storage = getStorage();

export async function uploadValidAvatar(bytes: Uint8Array) {
  const uid = auth.currentUser!.uid;
  await uploadBytes(ref(storage, \`avatars/\${uid}/profile\`), bytes, {
    contentType: 'image/png',
  });
}

export async function uploadUserFile(fileId: string, bytes: Uint8Array) {
  const uid = auth.currentUser!.uid;
  await uploadBytes(ref(storage, \`files/\${uid}/\${fileId}\`), bytes, {
    contentType: 'image/png',
  });
}

export async function deleteUserFile(fileId: string) {
  const uid = auth.currentUser!.uid;
  await deleteObject(ref(storage, \`files/\${uid}/\${fileId}\`));
}

export async function createOwnedUpload(uploadId: string, bytes: Uint8Array) {
  const uid = auth.currentUser!.uid;
  await uploadBytes(ref(storage, \`uploads/\${uploadId}\`), bytes, {
    contentType: 'image/png',
    customMetadata: { ownerId: uid, label: 'draft' },
  });
}

export async function relabelOwnedUpload(uploadId: string) {
  const uid = auth.currentUser!.uid;
  await updateMetadata(ref(storage, \`uploads/\${uploadId}\`), {
    customMetadata: { ownerId: uid, label: 'published' },
  });
}

export async function uploadOrgAsset(orgId: string, assetId: string, bytes: Uint8Array) {
  await uploadBytes(ref(storage, \`orgs/\${orgId}/assets/\${assetId}\`), bytes, {
    contentType: 'application/pdf',
  });
}

export async function downloadOrgAsset(orgId: string, assetId: string) {
  return getDownloadURL(ref(storage, \`orgs/\${orgId}/assets/\${assetId}\`));
}
`;

    const fixedStorageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /avatars/{uid}/{slot} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create, update: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*')
        && request.resource.size < 5 * 1024 * 1024;
    }
    match /thumbs/{uid}/{slot} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create, update: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*')
        && request.resource.size < 1024;
    }
    match /files/{uid}/{fileId} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create, update: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*')
        && request.resource.size < 5 * 1024 * 1024;
      allow delete: if request.auth != null && request.auth.uid == uid;
    }
    match /uploads/{uploadId} {
      allow read: if request.auth != null && resource.metadata.ownerId == request.auth.uid;
      allow create: if request.auth != null
        && request.resource.contentType.matches('image/.*')
        && request.resource.metadata.ownerId == request.auth.uid;
      allow update: if request.auth != null
        && resource.metadata.ownerId == request.auth.uid
        && request.resource.metadata.ownerId == resource.metadata.ownerId;
      allow delete: if request.auth != null
        && resource.metadata.ownerId == request.auth.uid;
    }
    match /orgs/{orgId}/assets/{assetId} {
      allow read: if request.auth != null
        && firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid));
      allow create, update: if request.auth != null
        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'editor'
        && request.resource.contentType == 'application/pdf';
      allow delete: if request.auth != null
        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'editor';
    }
  }
}`;

    const accessSites = extractClientSites(fixedClientCode);
    const sources: RuleSources = {
      firestore: [{ source: 'firestore.rules', text: FIRESTORE_ORG_RULES }],
      rtdb: [],
      storage: [{ source: 'storage.rules', text: fixedStorageRules }],
      problems: [],
    };
    const conditions = ownerConditionsFrom(sources);
    const ownerBindings = inferOwnerBindings(conditions, accessSites);

    const report = await runProbes({
      accessSites,
      ownerBindings,
      conditions,
      sources,
      state: {
        firestore: {
          // Both users belong to shared-org, so the non-member probe must isolate onto a fresh org scope!
          'orgs/shared-org/members/u-alice': { role: 'editor' },
          'orgs/shared-org/members/u-bob': { role: 'editor' },
        },
      },
      users: [
        { uid: 'u-alice', email: 'alice@example.test', displayName: 'Alice' },
        { uid: 'u-bob', email: 'bob@example.test', displayName: 'Bob' },
      ],
    });

    expect(report.probes.total).toBeGreaterThan(0);
    expect(report.probes.invalid / report.probes.total).toBeLessThanOrEqual(0.25);
    const storageResults = report.results.filter((r) => r.probe.service === 'storage');
    expect(storageResults.length).toBeGreaterThan(0);
    expect(storageResults.filter((r) => r.outcome === 'invalid')).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  test('plans root and non-root paginated list(ref, options) probes identically to listAll', async () => {
    const clientCode = `
import { getStorage, list, ref } from 'firebase/storage';

const storage = getStorage();

export async function listRootPage() {
  return list(ref(storage), { maxResults: 5 });
}

export async function listOrgAssetsPage(orgId: string) {
  return list(ref(storage, \`orgs/\${orgId}/assets\`), { maxResults: 10 });
}
`;
    const buggyListRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/assets/{allPaths=**} {
      // Root list is denied (no root rule), while orgs list forgot firestore.exists membership check!
      allow list: if request.auth != null;
    }
  }
}`;

    const accessSites = extractClientSites(clientCode);
    const sources: RuleSources = {
      firestore: [{ source: 'firestore.rules', text: FIRESTORE_ORG_RULES }],
      rtdb: [],
      storage: [{ source: 'storage.rules', text: buggyListRules }],
      problems: [],
    };
    const conditions = ownerConditionsFrom(sources);
    const ownerBindings = inferOwnerBindings(conditions, accessSites);

    const report = await runProbes({
      accessSites,
      ownerBindings,
      conditions,
      sources,
      users: [
        { uid: 'u-alice', email: 'alice@example.test', displayName: 'Alice' },
        { uid: 'u-bob', email: 'bob@example.test', displayName: 'Bob' },
      ],
    });

    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === ''
          && f.kind === 'must-allow-denied'
          && f.op === 'read'
          && f.operation?.method === 'list',
      ),
    ).toBe(true);
    expect(
      report.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'orgs/{orgId}/assets'
          && f.kind === 'foreign-slot-write'
          && f.op === 'read'
          && f.operation?.method === 'list',
      ),
    ).toBe(true);
  });

  test('isolates multi-tenant WorldState scopes without false positives and probes updateMetadata in cross-service Family 5', async () => {
    const clientCode = `
import { getStorage, ref, updateMetadata, uploadBytes } from 'firebase/storage';

const storage = getStorage();

export async function uploadTenantAsset(orgId: string, assetId: string, bytes: Uint8Array) {
  await uploadBytes(ref(storage, \`orgs/\${orgId}/assets/\${assetId}\`), bytes, {
    contentType: 'application/pdf',
  });
}

export async function tagTenantAsset(orgId: string, assetId: string) {
  await updateMetadata(ref(storage, \`orgs/\${orgId}/docs/\${assetId}\`), {
    customMetadata: { tag: 'reviewed' },
  });
}
`;

    const multiTenantState = {
      firestore: {
        'orgs/org-alice/members/u-alice': { role: 'editor' },
        'orgs/org-bob/members/u-bob': { role: 'editor' },
      },
    };
    const users = [
      { uid: 'u-alice', email: 'alice@example.test', displayName: 'Alice' },
      { uid: 'u-bob', email: 'bob@example.test', displayName: 'Bob' },
    ];
    const accessSites = extractClientSites(clientCode);

    // 1. Fixed cross-service rules across multi-tenant WorldState -> 0 findings, 0 invalid Storage probes
    const fixedRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/assets/{assetId} {
      allow create, update: if request.auth != null
        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'editor'
        && request.resource.contentType == 'application/pdf';
    }
    match /orgs/{orgId}/docs/{assetId} {
      allow create: if false;
      allow update: if request.auth != null
        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'editor';
    }
  }
}`;
    const fixedSources: RuleSources = {
      firestore: [{ source: 'firestore.rules', text: FIRESTORE_ORG_RULES }],
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
      state: multiTenantState,
      users,
    });
    const fixedStorageResults = fixedReport.results.filter((r) => r.probe.service === 'storage');
    expect(fixedStorageResults.filter((r) => r.outcome === 'invalid')).toEqual([]);
    expect(fixedReport.findings).toEqual([]);

    // 2. Buggy update rule missing org membership check (with allow create: if false!) -> hits foreign-slot-write via method: 'update'
    const buggyUpdateRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/assets/{assetId} {
      allow create, update: if request.auth != null
        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'editor'
        && request.resource.contentType == 'application/pdf';
    }
    match /orgs/{orgId}/docs/{assetId} {
      allow create: if false;
      allow update: if request.auth != null;
    }
  }
}`;
    const buggySources: RuleSources = {
      firestore: [{ source: 'firestore.rules', text: FIRESTORE_ORG_RULES }],
      rtdb: [],
      storage: [{ source: 'storage.rules', text: buggyUpdateRules }],
      problems: [],
    };
    const buggyConditions = ownerConditionsFrom(buggySources);
    const buggyBindings = inferOwnerBindings(buggyConditions, accessSites);
    const buggyReport = await runProbes({
      accessSites,
      ownerBindings: buggyBindings,
      conditions: buggyConditions,
      sources: buggySources,
      state: multiTenantState,
      users,
    });
    expect(
      buggyReport.findings.some(
        (f) =>
          f.service === 'storage'
          && f.path === 'orgs/{orgId}/docs/{assetId}'
          && f.kind === 'foreign-slot-write'
          && f.operation?.method === 'update',
      ),
    ).toBe(true);
  });

  test('synthesizes compliant witnesses for conjoined contentType.matches(...) and lower-bounded request.resource.size without false must-allow-denied hits', async () => {
    const clientCode = `
import { getAuth } from 'firebase/auth';
import { getBytes, getStorage, ref, uploadBytes } from 'firebase/storage';

export async function readTiffPhoto() {
  const uid = getAuth().currentUser!.uid;
  return getBytes(ref(getStorage(), \`users/\${uid}/photo\`));
}

export async function uploadBoundedBundle(payload: Uint8Array) {
  const uid = getAuth().currentUser!.uid;
  return uploadBytes(ref(getStorage(), \`users/\${uid}/bundle.bin\`), payload);
}
`;
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/photo {
      allow read: if request.auth != null
        && request.auth.uid == uid
        && resource.contentType.matches('image/.*')
        && resource.contentType.matches('.*tiff');
      allow write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*')
        && request.resource.contentType.matches('.*tiff');
    }
    match /users/{uid}/bundle.bin {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.size >= 100
        && request.resource.size <= 1000;
    }
  }
}`;
    const accessSites = extractClientSites(clientCode);
    const sources: RuleSources = {
      firestore: [],
      rtdb: [],
      storage: [{ source: 'storage.rules', text: storageRules }],
      problems: [],
    };
    const conditions = ownerConditionsFrom(sources);
    const ownerBindings = inferOwnerBindings(conditions, accessSites);

    const report = await runProbes({
      accessSites,
      ownerBindings,
      conditions,
      sources,
    });
    expect(report.findings.filter((f) => f.kind === 'must-allow-denied')).toEqual([]);
  });
});
