import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface StaticVerifyOutput {
  ok: boolean;
  counts: {
    total: number;
    byCertainty: Record<string, number>;
  };
  diagnostics: Array<{
    code: string;
    service: string;
    certainty: string;
  }>;
}

interface DeriveOutput extends StaticVerifyOutput {
  campaignId: string;
}

export default scenario(async (app) => {
  await app.step('database indexes --check catches missing .indexOn and generate fixes it', async () => {
    const failedCheck = await app.pyric([
      'database',
      'indexes',
      'generate',
      'src',
      '--check',
    ]);
    assert.notEqual(failedCheck.code, 0, failedCheck.output);

    const generated = await app.pyric(['database', 'indexes', 'generate', 'src']);
    assert.equal(generated.code, 0, generated.output);

    const updatedRules = JSON.parse(app.readFile('database.rules.json')) as {
      rules: {
        orgs: {
          $orgId: {
            presence: { '.indexOn'?: string[] };
          };
        };
      };
    };
    assert.deepEqual(updatedRules.rules.orgs.$orgId.presence['.indexOn'], ['role']);

    const cleanCheck = await app.pyric([
      'database',
      'indexes',
      'generate',
      'src',
      '--check',
    ]);
    assert.equal(cleanCheck.code, 0, cleanCheck.output);
  });

  await app.step('verify --static catches unprovable Firestore list query and Storage MIME mismatch before runtime', async () => {
    const staticRun = await app.pyric(['verify', '--static', '--json']);
    assert.equal(staticRun.code, 1, staticRun.output);
    const parsed = JSON.parse(staticRun.output) as StaticVerifyOutput;
    assert.equal(parsed.ok, false);
    const codes = parsed.diagnostics.map((d) => d.code);
    assert.ok(
      codes.includes('firestore-unprovable-list-query'),
      `expected firestore-unprovable-list-query in ${JSON.stringify(codes)}`,
    );
    assert.ok(
      codes.includes('storage-content-type-mismatch'),
      `expected storage-content-type-mismatch in ${JSON.stringify(codes)}`,
    );
  });

  await app.step('assurance derive emits proven-counterexample and static-proof diagnostics across the tri-source app', async () => {
    const deriveRun = await app.pyric(['assurance', 'derive', '--json']);
    assert.equal(deriveRun.code, 1, deriveRun.output);
    const parsed = JSON.parse(deriveRun.output) as DeriveOutput;
    assert.equal(parsed.ok, false);
    assert.ok(parsed.campaignId.length > 0);
    assert.ok(
      parsed.counts.byCertainty['proven-counterexample'] >= 1,
      `expected at least 1 proven-counterexample, got ${JSON.stringify(parsed.counts)}`,
    );
    assert.ok(
      parsed.counts.byCertainty['static-proof'] >= 2,
      `expected at least 2 static-proof failures, got ${JSON.stringify(parsed.counts)}`,
    );
  });

  await app.step('fixing rules and client contracts makes both verify --static and assurance derive exit 0', async () => {
    app.writeFile(
      'firestore.rules',
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/members/{uid} {
      allow get: if request.auth != null && request.auth.uid == uid;
    }
    match /orgs/{orgId}/items/{itemId} {
      allow get, list: if request.auth != null && resource.data.ownerId == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.ownerId == request.auth.uid;
      allow update: if request.auth != null
        && resource.data.ownerId == request.auth.uid
        && request.resource.data.ownerId == resource.data.ownerId;
    }
  }
}
`,
    );

    app.writeFile(
      'src/app.ts',
      `import { getAuth } from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  equalTo,
  get,
  getDatabase,
  orderByChild,
  query as dbQuery,
  ref as dbRef,
  set,
} from 'firebase/database';
import {
  getStorage,
  ref as storageRef,
  uploadString,
} from 'firebase/storage';

export async function syncWorkspace() {
  const auth = getAuth();
  const uid = auth.currentUser!.uid;

  const db = getFirestore();
  await setDoc(doc(db, 'orgs/acme/items', 'item-1'), {
    ownerId: uid,
    title: 'Quarterly summary',
  });
  await updateDoc(doc(db, 'orgs/acme/items', 'item-1'), {
    title: 'Revised summary',
  });
  await getDocs(query(collection(db, 'orgs/acme/items'), where('ownerId', '==', uid)));

  const rtdb = getDatabase();
  await set(dbRef(rtdb, \`orgs/acme/presence/\${uid}\`), {
    status: 'online',
    role: 'editor',
  });
  await get(
    dbQuery(
      dbRef(rtdb, 'orgs/acme/presence'),
      orderByChild('role'),
      equalTo('editor'),
    ),
  );

  const storage = getStorage();
  await uploadString(
    storageRef(storage, 'orgs/acme/attachments/report.pdf'),
    '%PDF-1.4 sample',
    'raw',
    {
      contentType: 'application/pdf',
      customMetadata: { ownerId: uid },
    },
  );
}
`,
    );

    const staticClean = await app.pyric(['verify', '--static', '--json']);
    assert.equal(staticClean.code, 0, staticClean.output);
    const staticParsed = JSON.parse(staticClean.output) as StaticVerifyOutput;
    assert.equal(staticParsed.ok, true);
    assert.equal(staticParsed.counts.byCertainty['static-proof'], 0);

    const deriveClean = await app.pyric(['assurance', 'derive', '--json']);
    assert.equal(deriveClean.code, 0, deriveClean.output);
    const deriveParsed = JSON.parse(deriveClean.output) as DeriveOutput;
    assert.equal(deriveParsed.ok, true);
    assert.equal(deriveParsed.counts.byCertainty['proven-counterexample'], 0);
    assert.equal(deriveParsed.counts.byCertainty['static-proof'], 0);
  });
});
