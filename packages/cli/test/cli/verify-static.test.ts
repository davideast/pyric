import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../../src/cli/index.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerifyStatic } from '../../src/cli/verify-static.js';

function bufferIo() {
  let out = '';
  let err = '';
  return {
    stdout: {
      write(chunk: string): void {
        out += chunk;
      },
    },
    stderr: {
      write(chunk: string): void {
        err += chunk;
      },
    },
    getOut: () => out,
    getErr: () => err,
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-verify-static-'));
}

describe('pyric verify --static', () => {
  it('catches unprovable Firestore list queries, Storage MIME mismatches, and missing RTDB .indexOn statically without a session capture', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'firebase.json'),
        JSON.stringify(
          {
            firestore: { rules: 'firestore.rules' },
            database: { rules: 'database.rules.json' },
            storage: { rules: 'storage.rules' },
          },
          null,
          2,
        ),
        'utf8',
      );
      writeFileSync(
        join(dir, 'firestore.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow get, list: if resource.data.orgId == 'acme';
      allow create: if request.auth != null;
    }
  }
}
`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'database.rules.json'),
        JSON.stringify(
          {
            rules: {
              orgs: {
                $orgId: {
                  presence: {
                    '.read': 'auth != null',
                    '.write': 'auth != null',
                  },
                },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      writeFileSync(
        join(dir, 'storage.rules'),
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/exports/{fileName} {
      allow write: if request.auth != null && request.resource.contentType.matches('image/.*');
      allow read: if request.auth != null;
    }
  }
}
`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'src', 'app.ts'),
        `import { getFirestore, collection, getDocs } from 'firebase/firestore';
import { getDatabase, ref as dbRef, query as dbQuery, orderByChild, equalTo, get } from 'firebase/database';
import { getStorage, ref as storageRef, uploadBytes } from 'firebase/storage';

export async function loadDashboard() {
  const db = getFirestore();
  await getDocs(collection(db, 'items'));

  const rtdb = getDatabase();
  await get(dbQuery(dbRef(rtdb, 'orgs/acme/presence'), orderByChild('role'), equalTo('member')));

  const storage = getStorage();
  await uploadBytes(
    storageRef(storage, 'orgs/acme/exports/report.pdf'),
    new Uint8Array([1, 2, 3]),
    { contentType: 'application/pdf' },
  );
}
`,
        'utf8',
      );

      const io = bufferIo();
      const code = await runVerifyStatic(
        parseArgs(['verify', '--static', '--root', dir, '--json']),
        io,
      );
      expect(code).toBe(1);
      const out = JSON.parse(io.getOut()) as {
        ok: boolean;
        diagnostics: Array<{ code: string; service: string; certainty: string }>;
      };
      expect(out.ok).toBe(false);
      const codes = out.diagnostics.map((d) => d.code);
      expect(codes).toContain('firestore-unprovable-list-query');
      expect(codes).toContain('storage-content-type-mismatch');
      expect(codes).toContain('rtdb-missing-index-on');

      // Service filter restricts output to the selected service
      const fsOnlyIo = bufferIo();
      const fsOnlyCode = await runVerifyStatic(
        parseArgs(['verify', '--static', '--root', dir, '--service', 'firestore', '--json']),
        fsOnlyIo,
      );
      expect(fsOnlyCode).toBe(1);
      const fsOnlyOut = JSON.parse(fsOnlyIo.getOut()) as {
        diagnostics: Array<{ service: string }>;
      };
      expect(fsOnlyOut.diagnostics.every((d) => d.service === 'firestore')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 via dispatch("verify", "--static") when static contracts hold', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'firestore.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow get, list: if resource.data.orgId == 'acme';
    }
  }
}
`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'src', 'app.ts'),
        `import { getFirestore, collection, query, where, getDocs } from 'firebase/firestore';

export async function listAcmeItems() {
  const db = getFirestore();
  await getDocs(query(collection(db, 'items'), where('orgId', '==', 'acme')));
}
`,
        'utf8',
      );

      const code = await dispatch(
        parseArgs(['verify', '--static', '--root', dir, '--json']),
      );
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports target-qualified --rules firestore:<db>, rtdb:<instance>, database:<instance>, and storage:<bucket>', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'analytics.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /events/{id} {
      allow get, list: if resource.data.orgId == 'acme';
    }
  }
}
`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'shard-a.rules.json'),
        JSON.stringify({ rules: { metrics: { '.read': 'auth != null' } } }),
        'utf8',
      );
      writeFileSync(
        join(dir, 'shard-b.rules.json'),
        JSON.stringify({ rules: { logs: { '.read': 'auth != null', '.indexOn': ['ts'] } } }),
        'utf8',
      );
      writeFileSync(
        join(dir, 'media.storage.rules'),
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /clips/{file} {
      allow create: if request.resource.contentType.matches('video/.*');
    }
  }
}
`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'src', 'multi.ts'),
        `import { getFirestore, collection, getDocs } from 'pyric/firestore';
import { getDatabase, ref as dbRef, query as dbQuery, orderByChild, equalTo, get as dbGet } from 'pyric/database';
import { getStorage, ref as stRef, uploadBytes } from 'pyric/storage';
declare const app: unknown;

export async function runTargets() {
  const analytics = getFirestore(app, 'analytics');
  await getDocs(collection(analytics, 'events'));

  const shardA = getDatabase(app, 'https://shard-a.firebaseio.com');
  await dbGet(dbQuery(dbRef(shardA, 'metrics'), orderByChild('score'), equalTo(1)));

  const shardB = getDatabase(app, 'https://shard-b.firebaseio.com');
  await dbGet(dbQuery(dbRef(shardB, 'logs'), orderByChild('ts'), equalTo(1)));

  const media = getStorage(app, 'gs://media-bucket');
  await uploadBytes(stRef(media, 'clips/intro.png'), new Uint8Array(4), {
    contentType: 'image/png',
  });
}
`,
        'utf8',
      );

      const io = bufferIo();
      const code = await runVerifyStatic(
        parseArgs([
          'verify',
          '--static',
          '--root',
          dir,
          '--rules',
          `firestore:analytics=${join(dir, 'analytics.rules')}`,
          '--rules',
          `rtdb:shard-a=${join(dir, 'shard-a.rules.json')}`,
          '--rules',
          `database:shard-b=${join(dir, 'shard-b.rules.json')}`,
          '--rules',
          `storage:gs://media-bucket=${join(dir, 'media.storage.rules')}`,
          '--json',
        ]),
        io,
      );
      expect(code).toBe(1);
      const out = JSON.parse(io.getOut()) as {
        diagnostics: Array<{ code: string; service: string; resourceId: string }>;
      };
      expect(out.diagnostics.map((d) => `${d.code}@${d.resourceId}`)).toEqual([
        'firestore-unprovable-list-query@analytics',
        'storage-content-type-mismatch@media-bucket',
        'rtdb-missing-index-on@shard-a',
      ]);

      const urlIo = bufferIo();
      const urlCode = await runVerifyStatic(
        parseArgs([
          'verify',
          '--static',
          '--root',
          dir,
          '--rules',
          `firestore:analytics=${join(dir, 'analytics.rules')}`,
          '--rules',
          `rtdb:https://shard-a.firebaseio.com=${join(dir, 'shard-a.rules.json')}`,
          '--rules',
          `database:https://shard-b.europe-west1.firebasedatabase.app=${join(dir, 'shard-b.rules.json')}`,
          '--rules',
          `storage:gs://media-bucket=${join(dir, 'media.storage.rules')}`,
          '--json',
        ]),
        urlIo,
      );
      expect(urlCode).toBe(1);
      const urlOut = JSON.parse(urlIo.getOut()) as {
        diagnostics: Array<{ code: string; resourceId: string }>;
      };
      expect(urlOut.diagnostics.map((d) => `${d.code}@${d.resourceId}`)).toContain(
        'rtdb-missing-index-on@shard-a',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
