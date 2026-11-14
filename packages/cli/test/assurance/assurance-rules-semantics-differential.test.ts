import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { firestoreRules, storageRules as compileStorageRules } from 'pyric/rules';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getStorageSandbox,
  ref as storageRef,
  updateMetadata,
  uploadBytes,
  uploadString,
} from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import {
  publishAssuranceVisualization,
  subscribeAssuranceVisualizations,
  type AssuranceVisualizationSnapshot,
} from '../../src/assurance/browser.js';
import { deriveAssurance } from '../../src/assurance/derive.js';
import { AssuranceCampaignStore } from '../../src/assurance/tools.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('deriveAssurance differential rules-semantics parity', () => {
  test('preserves seeded Auth customClaims and abstains when seeded owners lack email_verified or custom claims', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/verifiedDocs/{docId} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.email_verified == true;
    }
    match /users/{uid}/roleDocs/{docId} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && 'tier' in request.auth.token
        && request.auth.token.role == 'editor';
    }
    match /users/{uid}/tierDocs/{docId} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && 'tier' in request.auth.token;
    }
  }
}`;
    const seededUser = {
      uid: 'u-seeded-owner',
      email: 'owner@example.test',
      emailVerified: false,
      providerId: 'password',
      customClaims: { tier: 'pro' },
    };

    const simSummary = firestoreRules(rules).simulate([
      {
        description: 'unverified seeded owner denied on verifiedDocs',
        expectation: 'DENY',
        method: 'create',
        path: 'users/u-seeded-owner/verifiedDocs/d1',
        auth: { uid: 'u-seeded-owner', token: { email_verified: false, tier: 'pro' } },
        data: { ownerId: 'u-seeded-owner' },
      },
      {
        description: 'seeded owner without editor role denied on roleDocs',
        expectation: 'DENY',
        method: 'create',
        path: 'users/u-seeded-owner/roleDocs/d1',
        auth: { uid: 'u-seeded-owner', token: { email_verified: false, tier: 'pro' } },
        data: { ownerId: 'u-seeded-owner' },
      },
      {
        description: 'seeded owner with tier claim allowed on tierDocs',
        expectation: 'ALLOW',
        method: 'create',
        path: 'users/u-seeded-owner/tierDocs/d1',
        auth: { uid: 'u-seeded-owner', token: { email_verified: false, tier: 'pro' } },
        data: { ownerId: 'u-seeded-owner' },
      },
    ]);
    expect(simSummary.failed).toBe(0);

    const sandbox = initializeSandbox();
    setRules(sandbox, rules);
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [seededUser]);
    const session = authSandbox.mintSession(auth, { kind: 'uid', uid: 'u-seeded-owner' });
    const ownerDb = getFirestore(sandbox.withAuth(session.state));

    let verifiedAllowed = true;
    try {
      await setDoc(doc(ownerDb, 'users/u-seeded-owner/verifiedDocs/d1'), {
        ownerId: 'u-seeded-owner',
      });
    } catch {
      verifiedAllowed = false;
    }
    expect(verifiedAllowed).toBe(false);

    let roleAllowed = true;
    try {
      await setDoc(doc(ownerDb, 'users/u-seeded-owner/roleDocs/d1'), {
        ownerId: 'u-seeded-owner',
      });
    } catch {
      roleAllowed = false;
    }
    expect(roleAllowed).toBe(false);

    await setDoc(doc(ownerDb, 'users/u-seeded-owner/tierDocs/d1'), {
      ownerId: 'u-seeded-owner',
    });

    const root = makeTempDir('derive-claims-diff-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'firebase.json'),
      JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
    );
    writeFileSync(join(root, 'firestore.rules'), rules);
    writeFileSync(
      join(root, 'src/app.ts'),
      `import { getAuth } from 'firebase/auth';
import { doc, getFirestore, setDoc } from 'firebase/firestore';
export async function saveAll() {
  const uid = getAuth().currentUser!.uid;
  const db = getFirestore();
  await setDoc(doc(db, 'users', uid, 'verifiedDocs', 'd1'), { ownerId: uid });
  await setDoc(doc(db, 'users', uid, 'roleDocs', 'd1'), { ownerId: uid });
  await setDoc(doc(db, 'users', uid, 'tierDocs', 'd1'), { ownerId: uid });
}
`,
    );

    const store = new AssuranceCampaignStore();
    const seededSandbox = initializeSandbox();
    authSandbox.seedUsers(getAuth(seededSandbox), [seededUser]);
    const derived = await deriveAssurance({ root }, { store, sandbox: seededSandbox });
    const mustAllowDenied = derived.diagnostics.filter(
      (d) => d.code === 'assurance-must-allow-denied',
    );
    expect(mustAllowDenied).toEqual([]);
    const inconclusive = derived.diagnostics.filter(
      (d) => d.code === 'assurance-probe-inconclusive' && d.certainty === 'heuristic',
    );
    expect(inconclusive.length).toBeGreaterThanOrEqual(2);

    const campaign = store.get(derived.campaignId);
    const preservedOwner = campaign.target.state?.auth?.users?.find(
      (u) => u.uid === 'u-seeded-owner',
    );
    expect(preservedOwner?.emailVerified).toBe(false);
    expect(preservedOwner?.customClaims).toEqual({ tier: 'pro' });
  });

  test('Storage default contentType, HTTP metadata fields, and disjunctive allow rules agree across storageRules().simulate(), Sandbox, deriveAssurance, and campaign runner', async () => {
    const storageRuleText = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/raw/{fileName} {
      allow create: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*');
    }
    match /users/{uid}/headers/{fileName} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create: if request.auth != null
        && request.auth.uid == uid
        && request.resource.cacheControl == 'public, max-age=600'
        && request.resource.contentDisposition == 'inline'
        && request.resource.contentEncoding == 'gzip'
        && request.resource.contentLanguage == 'en';
    }
    match /users/{uid}/sharedHeaders/{fileName} {
      allow write: if request.auth != null
        && request.resource.cacheControl == 'public, max-age=600'
        && request.resource.contentDisposition == 'inline'
        && request.resource.contentEncoding == 'gzip'
        && request.resource.contentLanguage == 'en';
    }
    match /users/{uid}/or/{fileName} {
      allow write: if false;
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*')
        && request.resource.size < 1024;
      allow create: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType == 'application/pdf'
        && request.resource.size < 4096;
    }
    match /users/{uid}/asymmetric/{fileName} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*');
      allow write: if request.auth != null
        && request.resource.contentType == 'application/pdf';
    }
  }
}`;
    const compiled = compileStorageRules(storageRuleText, { bucket: 'default-bucket' });
    const simSummary = compiled.simulate([
      {
        description: 'raw uploadString default text/plain denied by image/.*',
        expectation: 'DENY',
        method: 'create',
        path: 'users/u-alice/raw/note.txt',
        auth: { uid: 'u-alice', token: {} },
        requestResource: { size: 5, contentType: 'text/plain;charset=utf-8', metadata: {} },
      },
      {
        description: 'four HTTP metadata headers allowed',
        expectation: 'ALLOW',
        method: 'create',
        path: 'users/u-alice/headers/report.bin',
        auth: { uid: 'u-alice', token: {} },
        requestResource: {
          size: 4,
          contentType: 'application/octet-stream',
          cacheControl: 'public, max-age=600',
          contentDisposition: 'inline',
          contentEncoding: 'gzip',
          contentLanguage: 'en',
          metadata: {},
        },
      },
      {
        description: 'second disjunctive allow statement permits 2KB PDF',
        expectation: 'ALLOW',
        method: 'create',
        path: 'users/u-alice/or/spec.pdf',
        auth: { uid: 'u-alice', token: {} },
        requestResource: { size: 2048, contentType: 'application/pdf', metadata: {} },
      },
      {
        description: 'peer u-bob denied on asymmetric image/.* arm but allowed on overbroad PDF arm',
        expectation: 'ALLOW',
        method: 'update',
        path: 'users/u-alice/asymmetric/avatar.png',
        auth: { uid: 'u-bob', token: {} },
        resource: { size: 2, contentType: 'image/png', metadata: {} },
        requestResource: { size: 2, contentType: 'application/pdf', metadata: {} },
      },
    ]);
    expect(simSummary.failed).toBe(0);

    const sandbox = initializeSandbox();
    getAdminStorageSandbox(sandbox, { rules: storageRuleText });
    const aliceStorage = getStorageSandbox(sandbox.withAuth({ uid: 'u-alice', token: {} }));
    const bobStorage = getStorageSandbox(sandbox.withAuth({ uid: 'u-bob', token: {} }));

    let rawAllowed = true;
    try {
      await uploadString(storageRef(aliceStorage, 'users/u-alice/raw/note.txt'), 'hello', 'raw');
    } catch {
      rawAllowed = false;
    }
    expect(rawAllowed).toBe(false);

    await uploadBytes(
      storageRef(aliceStorage, 'users/u-alice/headers/report.bin'),
      new Uint8Array([1, 2, 3, 4]),
      {
        cacheControl: 'public, max-age=600',
        contentDisposition: 'inline',
        contentEncoding: 'gzip',
        contentLanguage: 'en',
      },
    );
    await uploadBytes(
      storageRef(aliceStorage, 'users/u-alice/or/spec.pdf'),
      new Uint8Array(2048),
      { contentType: 'application/pdf' },
    );
    await uploadBytes(
      storageRef(aliceStorage, 'users/u-alice/asymmetric/avatar.png'),
      new Uint8Array([1, 2]),
      { contentType: 'image/png' },
    );
    await uploadBytes(
      storageRef(bobStorage, 'users/u-alice/asymmetric/avatar.png'),
      new Uint8Array([1, 2]),
      { contentType: 'application/pdf' },
    );

    const root = makeTempDir('derive-storage-http-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'firebase.json'),
      JSON.stringify({ storage: { rules: 'storage.rules' } }),
    );
    writeFileSync(join(root, 'storage.rules'), storageRuleText);
    writeFileSync(
      join(root, 'src/upload.ts'),
      `import { getAuth } from 'firebase/auth';
import { getBytes, getStorage, ref, uploadBytes, uploadString } from 'firebase/storage';
export async function syncFiles(dynamicLang: string) {
  const uid = getAuth().currentUser!.uid;
  const st = getStorage();
  await uploadString(ref(st, 'users/' + uid + '/raw/note.txt'), 'hello', 'raw');
  const headerRef = ref(st, 'users/' + uid + '/headers/report.bin');
  await uploadBytes(headerRef, new Uint8Array([1, 2, 3, 4]), {
    cacheControl: 'public, max-age=600',
    contentDisposition: 'inline',
    contentEncoding: 'gzip',
    contentLanguage: 'en',
  });
  await getBytes(headerRef);
  await uploadBytes(ref(st, 'users/' + uid + '/sharedHeaders/open.bin'), new Uint8Array([1, 2, 3, 4]), {
    cacheControl: 'public, max-age=600',
    contentDisposition: 'inline',
    contentEncoding: 'gzip',
    contentLanguage: 'en',
  });
  await uploadBytes(ref(st, 'users/' + uid + '/headers/dyn.bin'), new Uint8Array([1, 2, 3, 4]), {
    cacheControl: 'public, max-age=600',
    contentDisposition: 'inline',
    contentEncoding: 'gzip',
    contentLanguage: dynamicLang,
  });
  await uploadBytes(ref(st, 'users/' + uid + '/or/spec.pdf'), new Uint8Array(2048), {
    contentType: 'application/pdf',
  });
  await uploadBytes(ref(st, 'users/' + uid + '/asymmetric/avatar.png'), new Uint8Array([1, 2]), {
    contentType: 'image/png',
  });
}
`,
    );

    const store = new AssuranceCampaignStore();
    const derived = await deriveAssurance({ root }, { store });

    const contractDiags = derived.diagnostics.filter(
      (d) => d.code === 'storage-content-type-mismatch',
    );
    expect(contractDiags.map((d) => d.codeSite?.source)).toEqual(['src/upload.ts:6']);

    const mustAllowDiags = derived.diagnostics.filter(
      (d) => d.code === 'assurance-must-allow-denied',
    );
    expect(mustAllowDiags).toHaveLength(1);
    expect(mustAllowDiags[0]!.codeSite?.source).toBe('src/upload.ts:6');

    const foreignSlotDiags = derived.diagnostics.filter(
      (d) => d.code === 'assurance-foreign-slot-write',
    );
    expect(
      foreignSlotDiags.some((d) => d.message.includes('asymmetric/avatar.png')),
    ).toBe(true);

    const campaign = store.get(derived.campaignId);
    const headerObj = campaign.target.state?.storage?.find((obj) =>
      obj.path.endsWith('sharedHeaders/open.bin'),
    );
    expect(headerObj?.cacheControl).toBe('public, max-age=600');
    expect(headerObj?.contentDisposition).toBe('inline');
    expect(headerObj?.contentEncoding).toBe('gzip');
    expect(headerObj?.contentLanguage).toBe('en');

    const runReport = await campaign.run();
    expect(runReport.summary.candidateSignals).toBe(2);
    expect(runReport.summary.noCounterexamples).toBe(0);
    expect(runReport.summary.invalidProbes).toBe(0);
    expect(runReport.summary.engineGaps).toBe(0);

    const snapshots: AssuranceVisualizationSnapshot[] = [];
    const unsubscribe = subscribeAssuranceVisualizations((snap) => {
      snapshots.push(snap);
    });
    publishAssuranceVisualization({
      schema: 'pyric.assurance.visualization.v1',
      campaignId: derived.campaignId,
      observations: [],
      probes: [],
    });
    unsubscribe();
    expect(snapshots).toHaveLength(1);
  });

  test('omitted HTTP defaults plus Family 4 and Family 5 disjunctive Storage arms agree with getStorageSandbox()', async () => {
    const root = makeTempDir('pyric-asr-storage-f4-f5-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'firebase.json'),
      JSON.stringify({
        firestore: { rules: 'firestore.rules' },
        storage: { rules: 'storage.rules' },
      }),
    );

    const fsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/members/{uid} {
      allow read: if request.auth != null;
    }
  }
}`;
    const stRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /enc/{uid}/{name} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentEncoding == 'identity';
    }
    match /disp/{uid}/{name} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentDisposition.matches('inline.*');
    }
    match /nullencdyn/{uid}/{name} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentEncoding == null
        && request.resource.contentLanguage == 'en';
    }
    match /uploads/{fileName} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.contentType.matches('image/.*')
        && request.resource.metadata.owner == request.auth.uid;
      allow create: if request.auth != null
        && request.resource.contentType == 'application/pdf';
    }
    match /shared/{fileName} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.metadata.owner == request.auth.uid
        && request.resource.cacheControl == 'public, max-age=3600';
      allow update: if request.auth != null
        && request.resource.cacheControl == 'no-cache';
    }
    match /orgs/{orgId}/files/{fileName} {
      allow read: if request.auth != null
        && firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid));
      allow write: if request.auth != null
        && firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid))
        && request.resource.contentType.matches('image/.*');
      allow write: if request.auth != null
        && request.resource.contentType == 'application/pdf';
    }
    match /orgs/{orgId}/managed/{fileName} {
      allow read: if request.auth != null
        && firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid));
      allow create: if request.auth != null
        && firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid));
      allow update: if request.auth != null
        && firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid))
        && request.resource.cacheControl == 'public, max-age=600';
      allow update: if request.auth != null
        && request.resource.cacheControl == 'no-cache';
    }
  }
}`;
    writeFileSync(join(root, 'firestore.rules'), fsRules);
    writeFileSync(join(root, 'storage.rules'), stRules);
    writeFileSync(
      join(root, 'src', 'f4f5.ts'),
      `import { getAuth } from 'firebase/auth';
import { getStorage, ref, updateMetadata, uploadBytes } from 'firebase/storage';
export async function runClient(fileId: string, orgId: string, dynLang: string) {
  const uid = getAuth().currentUser!.uid;
  const st = getStorage();
  await uploadBytes(ref(st, 'enc/' + uid + '/a.bin'), new Uint8Array([1]));
  await uploadBytes(ref(st, 'disp/' + uid + '/doc.pdf'), new Uint8Array([1]), { contentType: 'application/pdf' });
  await uploadBytes(ref(st, 'nullencdyn/' + uid + '/a.bin'), new Uint8Array([1]), { contentLanguage: dynLang });
  await uploadBytes(ref(st, 'uploads/' + fileId), new Uint8Array([1]), {
    contentType: 'image/png',
    customMetadata: { owner: uid },
  });
  await uploadBytes(ref(st, 'shared/' + fileId), new Uint8Array([1]), {
    cacheControl: 'public, max-age=3600',
    customMetadata: { owner: uid },
  });
  await uploadBytes(ref(st, 'orgs/' + orgId + '/files/' + fileId), new Uint8Array([1]), {
    contentType: 'image/png',
  });
  await updateMetadata(ref(st, 'orgs/' + orgId + '/managed/' + fileId), {
    cacheControl: 'public, max-age=600',
  });
}
`,
    );

    const sb = initializeSandbox();
    await setDoc(doc(getFirestore(sb), 'orgs/org-1/members/u-alice'), { active: true });
    setRules(sb, fsRules);
    getAdminStorageSandbox(sb, { rules: stRules });
    const aliceSt = getStorageSandbox(sb.withAuth({ uid: 'u-alice', token: {} }));
    const bobSt = getStorageSandbox(sb.withAuth({ uid: 'u-bob', token: {} }));
    await uploadBytes(storageRef(aliceSt, 'enc/u-alice/a.bin'), new Uint8Array([1]));
    await uploadBytes(storageRef(aliceSt, 'disp/u-alice/doc.pdf'), new Uint8Array([1]), {
      contentType: 'application/pdf',
    });
    await expect(
      uploadBytes(storageRef(aliceSt, 'nullencdyn/u-alice/a.bin'), new Uint8Array([1]), {
        contentLanguage: 'en',
      }),
    ).rejects.toThrow();
    await uploadBytes(storageRef(bobSt, 'uploads/f1'), new Uint8Array([1]), {
      contentType: 'application/pdf',
      customMetadata: { owner: 'u-alice' },
    });
    await uploadBytes(storageRef(aliceSt, 'shared/f1'), new Uint8Array([1]), {
      cacheControl: 'public, max-age=3600',
      customMetadata: { owner: 'u-alice' },
    });
    await updateMetadata(storageRef(bobSt, 'shared/f1'), {
      cacheControl: 'no-cache',
      customMetadata: { owner: 'u-bob' },
    });
    await uploadBytes(storageRef(bobSt, 'orgs/org-1/files/f1'), new Uint8Array([1]), {
      contentType: 'application/pdf',
    });
    await uploadBytes(storageRef(aliceSt, 'orgs/org-1/managed/f1'), new Uint8Array([1]));
    await updateMetadata(storageRef(bobSt, 'orgs/org-1/managed/f1'), {
      cacheControl: 'no-cache',
    });

    const derived = await deriveAssurance({ root, includeHeuristic: false });
    const diagSummary = derived.diagnostics.map((d) => `${d.code}@${d.codeSite?.source}`);
    expect(diagSummary).not.toContain('storage-http-metadata-mismatch@src/f4f5.ts:6');
    expect(diagSummary).not.toContain('storage-http-metadata-mismatch@src/f4f5.ts:7');
    expect(diagSummary).toContain('storage-http-metadata-mismatch@src/f4f5.ts:8');
    expect(diagSummary).toContain('assurance-must-allow-denied@src/f4f5.ts:8');
    expect(diagSummary).toContain('assurance-metadata-owner-forge@src/f4f5.ts:9');
    expect(diagSummary).toContain('assurance-metadata-owner-forge@src/f4f5.ts:13');
    expect(diagSummary).toContain('assurance-foreign-slot-write@src/f4f5.ts:17');
    expect(diagSummary).toContain('assurance-foreign-slot-write@src/f4f5.ts:20');
  });
});
