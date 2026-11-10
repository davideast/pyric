import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleRecords, serializeToBuckets } from 'pyric/sandbox';
import { runAssuranceDerive } from '../../src/cli/assurance.js';
import { dispatch } from '../../src/cli/index.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerifyStatic } from '../../src/cli/verify-static.js';
import { HOSTED_METHOD_PATH } from '../../src/serve/hosted/method-protocol.js';

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
  return mkdtempSync(join(tmpdir(), 'pyric-cli-assurance-'));
}

describe('pyric assurance derive CLI', () => {
  it('exits 1 by default on proven-counterexample or static-proof diagnostics and prints structured JSON', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'firebase.json'),
        JSON.stringify({ firestore: { rules: 'firestore.rules' } }, null, 2),
        'utf8',
      );
      writeFileSync(
        join(dir, 'firestore.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow get, list: if resource.data.ownerId == request.auth.uid;
      allow create, update: if request.auth != null;
    }
  }
}
`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'src', 'app.ts'),
        `import { getFirestore, collection, doc, setDoc, updateDoc, getDocs } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

export async function syncItems() {
  const db = getFirestore();
  const auth = getAuth();
  await setDoc(doc(db, 'items', 'item-1'), { ownerId: auth.currentUser!.uid, title: 'alpha' });
  await updateDoc(doc(db, 'items', 'item-1'), { title: 'beta' });
  await getDocs(collection(db, 'items'));
}
`,
        'utf8',
      );

      const io = bufferIo();
      const code = await runAssuranceDerive(
        parseArgs(['assurance', 'derive', '--root', dir, '--json']),
        io,
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(io.getOut()) as {
        ok: boolean;
        campaignId: string;
        counts: {
          byCertainty: Record<string, number>;
        };
        diagnostics: Array<{ code: string; certainty: string }>;
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.campaignId.length).toBeGreaterThan(0);
      expect(parsed.counts.byCertainty['proven-counterexample']).toBeGreaterThan(0);
      expect(parsed.counts.byCertainty['static-proof']).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 by default when only heuristic hints exist, and exits 1 when --include-heuristic or --fail-on heuristic is passed', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'firebase.json'),
        JSON.stringify({ firestore: { rules: 'firestore.rules' } }, null, 2),
        'utf8',
      );
      writeFileSync(
        join(dir, 'firestore.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow get: if request.auth != null && request.auth.uid == uid;
    }
    match /auditLogs/{logId} {
      allow get: if request.auth != null && request.auth.token.admin == true;
    }
  }
}
`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'src', 'app.ts'),
        `import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

export async function readProfile() {
  const db = getFirestore();
  const auth = getAuth();
  await getDoc(doc(db, 'users', auth.currentUser!.uid));
}
`,
        'utf8',
      );

      const defaultIo = bufferIo();
      const defaultCode = await runAssuranceDerive(
        parseArgs(['assurance', 'derive', '--root', dir, '--json']),
        defaultIo,
      );
      expect(defaultCode).toBe(0);
      const defaultJson = JSON.parse(defaultIo.getOut()) as {
        ok: boolean;
        counts: { byCertainty: Record<string, number> };
      };
      expect(defaultJson.ok).toBe(true);
      expect(defaultJson.counts.byCertainty['proven-counterexample']).toBe(0);
      expect(defaultJson.counts.byCertainty['static-proof']).toBe(0);
      expect(defaultJson.counts.byCertainty.heuristic).toBeGreaterThan(0);

      const heuristicIo = bufferIo();
      const heuristicCode = await runAssuranceDerive(
        parseArgs(['assurance', 'derive', '--root', dir, '--include-heuristic', '--json']),
        heuristicIo,
      );
      expect(heuristicCode).toBe(1);

      const failOnIo = bufferIo();
      const failOnCode = await runAssuranceDerive(
        parseArgs(['assurance', 'derive', '--root', dir, '--fail-on', 'heuristic', '--json']),
        failOnIo,
      );
      expect(failOnCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('connects to loopback sandbox via --port without mutating live server and routes via top-level dispatch', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'firestore.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow get: if request.auth != null && request.auth.uid == uid;
    }
  }
}
`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'src', 'app.ts'),
        `import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

export async function readOwn() {
  const db = getFirestore();
  const auth = getAuth();
  await getDoc(doc(db, 'users', auth.currentUser!.uid));
}
`,
        'utf8',
      );

      const records = serializeToBuckets(
        { 'users/u-alice': { name: 'Alice' } },
        {
          auth: {
            users: [{ uid: 'u-alice', email: 'alice@example.test' }],
            providers: {},
          },
        },
        1_700_000_000_000,
      );
      const v3Firestore = JSON.parse(bundleRecords(records)) as unknown;
      const seenUrls: string[] = [];
      let receivedProjectDir: unknown;
      const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(input);
        seenUrls.push(urlStr);
        if (urlStr.endsWith('/__pyric/init.json')) {
          return new Response(
            JSON.stringify({
              sessionToken: 'tok-cli',
              instanceId: 'inst-cli',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (urlStr.endsWith('/__pyric/state')) {
          return new Response(
            JSON.stringify({
              version: 1,
              firestore: v3Firestore,
              auth: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (urlStr.endsWith(HOSTED_METHOD_PATH)) {
          const parsedBody = JSON.parse(String(init?.body ?? '{}')) as {
            projectDir?: unknown;
          };
          receivedProjectDir = parsedBody.projectDir;
          return new Response(
            JSON.stringify({
              ok: true,
              summary: 'events',
              data: {
                events: [
                  { kind: 'request', service: 'firestore', path: 'users/u-alice', op: 'get' },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      const io = bufferIo();
      const code = await runAssuranceDerive(
        parseArgs(['assurance', 'derive', '--root', dir, '--port', '4512', '--json']),
        { ...io, fetchImpl: mockFetch },
      );
      expect(code).toBe(0);
      expect(seenUrls.some((u) => u.endsWith('/__pyric/init.json'))).toBe(true);
      expect(seenUrls.some((u) => u.endsWith(HOSTED_METHOD_PATH))).toBe(true);
      expect(receivedProjectDir).toBe(realpathSync(dir));
      const out = JSON.parse(io.getOut()) as { studioUrl?: string; ok: boolean };
      expect(out.ok).toBe(true);
      expect(out.studioUrl).toContain('http://127.0.0.1:4512/');
      expect(out.studioUrl).toContain('campaign=');

      const badIo = bufferIo();
      const badCode = await runAssuranceDerive(
        parseArgs(['assurance', 'derive', '--root', dir, '--port', '4512', '--json']),
        {
          ...badIo,
          fetchImpl: (async () =>
            new Response('not found', { status: 404 })) as unknown as typeof fetch,
        },
      );
      expect(badCode).toBe(2);

      const dispatchedCode = await dispatch(
        parseArgs(['assurance', 'derive', '--root', dir, '--json']),
      );
      expect(dispatchedCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed in both verify --static and assurance derive on broken firebase.json, missing/escaping rules paths, and syntax-broken rules', async () => {
    const parent = makeTempDir();
    try {
      writeFileSync(
        join(parent, 'outside.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read: if request.auth != null; }
  }
}
`,
        'utf8',
      );

      const clientApp = `import { getFirestore, collection, getDocs } from 'pyric/firestore';
declare const app: unknown;
export async function readAll() {
  await getDocs(collection(getFirestore(app), 'items'));
}
`;

      const cases: Array<{
        name: string;
        firebaseJson: string;
        firestoreRules?: string;
        storageRules?: string;
      }> = [
        {
          name: 'missing-rules',
          firebaseJson: JSON.stringify({ firestore: { rules: 'missing.rules' } }),
        },
        {
          name: 'malformed-firebase-json',
          firebaseJson: '{ "firestore": { "rules": "firestore.rules"',
        },
        {
          name: 'escaping-rules-path',
          firebaseJson: JSON.stringify({ firestore: { rules: '../outside.rules' } }),
        },
        {
          name: 'syntax-broken-firestore-rules',
          firebaseJson: JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
          firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get, list: if resource.data.ownerId == ;
    }
  }
}
`,
        },
        {
          name: 'syntax-broken-storage-rules',
          firebaseJson: JSON.stringify({ storage: { rules: 'storage.rules' } }),
          storageRules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{id} {
      allow write: if request.resource.size < ;
    }
  }
}
`,
        },
      ];

      for (const c of cases) {
        const caseDir = join(parent, c.name);
        mkdirSync(join(caseDir, 'src'), { recursive: true });
        writeFileSync(join(caseDir, 'firebase.json'), c.firebaseJson, 'utf8');
        if (c.firestoreRules !== undefined) {
          writeFileSync(join(caseDir, 'firestore.rules'), c.firestoreRules, 'utf8');
        }
        if (c.storageRules !== undefined) {
          writeFileSync(join(caseDir, 'storage.rules'), c.storageRules, 'utf8');
        }
        writeFileSync(join(caseDir, 'src', 'app.ts'), clientApp, 'utf8');

        const verifyIo = bufferIo();
        const verifyCode = await runVerifyStatic(
          parseArgs(['verify', '--static', '--root', caseDir, '--json']),
          verifyIo,
        );
        expect(verifyCode).toBe(1);
        const verifyJson = JSON.parse(verifyIo.getOut()) as {
          ok: boolean;
          diagnostics: Array<{ code: string; certainty: string }>;
        };
        expect(verifyJson.ok).toBe(false);
        expect(
          verifyJson.diagnostics.some(
            (d) => d.code === 'invalid-rules-configuration' && d.certainty === 'static-proof',
          ),
        ).toBe(true);

        const deriveIo = bufferIo();
        const deriveCode = await runAssuranceDerive(
          parseArgs(['assurance', 'derive', '--root', caseDir, '--json']),
          deriveIo,
        );
        expect(deriveCode).toBe(1);
        const deriveJson = JSON.parse(deriveIo.getOut()) as {
          ok: boolean;
          diagnostics: Array<{ code: string; certainty: string }>;
        };
        expect(deriveJson.ok).toBe(false);
        expect(
          deriveJson.diagnostics.some(
            (d) => d.code === 'invalid-rules-configuration' && d.certainty === 'static-proof',
          ),
        ).toBe(true);
      }

      const gateDir = join(parent, 'heuristic-only-gate');
      mkdirSync(join(gateDir, 'src'), { recursive: true });
      writeFileSync(
        join(gateDir, 'firebase.json'),
        JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
        'utf8',
      );
      writeFileSync(
        join(gateDir, 'firestore.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId} {
      allow read: if request.auth != null;
    }
  }
}
`,
        'utf8',
      );
      writeFileSync(join(gateDir, 'src', 'app.ts'), 'export const unused = 1;\n', 'utf8');

      const verifyGateIo = bufferIo();
      const verifyGateCode = await runVerifyStatic(
        parseArgs([
          'verify',
          '--static',
          '--root',
          gateDir,
          '--include-heuristic',
          '--fail-on',
          'static-proof',
          '--json',
        ]),
        verifyGateIo,
      );
      expect(verifyGateCode).toBe(0);
      const verifyGateJson = JSON.parse(verifyGateIo.getOut()) as {
        ok: boolean;
        counts: { byCertainty: Record<string, number> };
      };
      expect(verifyGateJson.ok).toBe(true);
      expect(verifyGateJson.counts.byCertainty.heuristic).toBeGreaterThan(0);

      const deriveGateIo = bufferIo();
      const deriveGateCode = await runAssuranceDerive(
        parseArgs([
          'assurance',
          'derive',
          '--root',
          gateDir,
          '--include-heuristic',
          '--fail-on',
          'static-proof',
          '--json',
        ]),
        deriveGateIo,
      );
      expect(deriveGateCode).toBe(0);
      expect((JSON.parse(deriveGateIo.getOut()) as { ok: boolean }).ok).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
