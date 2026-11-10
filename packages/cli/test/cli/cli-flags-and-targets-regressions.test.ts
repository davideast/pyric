import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { runAssuranceDerive } from '../../src/cli/assurance.js';
import { runDatabaseIndexesGenerate } from '../../src/cli/database-indexes.js';
import { runFirestoreIndexesGenerate } from '../../src/cli/firestore-indexes.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerifyStatic } from '../../src/cli/verify-static.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function bufferIo(): {
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  getOut(): string;
  getErr(): string;
} {
  let out = '';
  let err = '';
  return {
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
    getOut: () => out,
    getErr: () => err,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLI target overrides, .firebaserc target resolution, and required flag values', () => {
  it('preserves named databases and buckets when unqualified --rules overrides (default) in verify --static', async () => {
    const dir = makeTempDir('verify-static-named-preserve-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({
        firestore: [
          { rules: 'default.firestore.rules' },
          { database: 'db-secondary', rules: 'secondary.firestore.rules' },
          { database: 'db-open', rules: 'open.firestore.rules' },
        ],
        storage: [
          { rules: 'default.storage.rules' },
          { bucket: 'bucket-secondary', rules: 'secondary.storage.rules' },
        ],
      }),
    );
    writeFileSync(
      join(dir, 'default.firestore.rules'),
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} { allow read: if false; }
  }
}
`,
    );
    writeFileSync(
      join(dir, 'override.firestore.rules'),
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} { allow read: if request.auth != null && request.auth.uid == uid; }
  }
}
`,
    );
    writeFileSync(
      join(dir, 'secondary.firestore.rules'),
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow get, list: if resource.data.ownerId == request.auth.uid; }
  }
}
`,
    );
    writeFileSync(
      join(dir, 'open.firestore.rules'),
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} { allow read: if true; }
  }
}
`,
    );
    writeFileSync(
      join(dir, 'default.storage.rules'),
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid} { allow read: if false; }
  }
}
`,
    );
    writeFileSync(
      join(dir, 'override.storage.rules'),
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid} { allow read: if request.auth != null && request.auth.uid == uid; }
  }
}
`,
    );
    writeFileSync(
      join(dir, 'secondary.storage.rules'),
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} { allow create: if request.resource.contentType.matches('image/.*'); }
  }
}
`,
    );
    writeFileSync(
      join(dir, 'src/app.ts'),
      `import { getFirestore, collection, getDocs, doc, getDoc } from 'pyric/firestore';
import { getStorage, ref, uploadBytes } from 'pyric/storage';
declare const app: unknown;
export async function runMulti() {
  await getDocs(collection(getFirestore(app, 'db-secondary'), 'items'));
  await getDoc(doc(getFirestore(app, 'db-open'), 'docs', 'doc-1'));
  await uploadBytes(ref(getStorage(app, 'gs://bucket-secondary'), 'docs/doc-1'), new Uint8Array([1]), {
    contentType: 'text/plain',
  });
}
`,
    );

    const runWithRules = async (extra: string[]) => {
      const io = bufferIo();
      const code = await runVerifyStatic(
        parseArgs(['verify', '--static', '--root', dir, ...extra, '--json']),
        { cwd: dir, ...io },
      );
      const parsed = JSON.parse(io.getOut()) as {
        diagnostics: Array<{ code: string; resourceId: string }>;
      };
      return {
        code,
        tagged: parsed.diagnostics.map((d) => `${d.code}@${d.resourceId}`),
      };
    };

    const unqualified = await runWithRules([
      '--rules',
      'firestore=override.firestore.rules',
      '--rules',
      'storage=override.storage.rules',
    ]);
    const qualified = await runWithRules([
      '--rules',
      'firestore:(default)=override.firestore.rules',
      '--rules',
      'storage:(default)=override.storage.rules',
    ]);

    expect(unqualified.code).toBe(1);
    expect(unqualified.tagged).toContain('firestore-unprovable-list-query@db-secondary');
    expect(unqualified.tagged).toContain('storage-content-type-mismatch@bucket-secondary');
    expect(unqualified.tagged.some((t) => t.endsWith('@db-open'))).toBe(false);
    expect(unqualified.tagged).toEqual(qualified.tagged);
  });

  it('resolves .firebaserc firestore targets in firestore indexes generate', async () => {
    const dir = makeTempDir('firestore-indexes-rc-targets-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, '.firebaserc'),
      JSON.stringify({
        projects: { default: 'proj-1' },
        targets: {
          'proj-1': {
            firestore: { primaryDb: ['(default)'] },
          },
        },
      }),
    );
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({
        firestore: [
          {
            target: 'primaryDb',
            rules: 'firestore.rules',
            indexes: 'custom/firestore.indexes.json',
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, 'src/app.ts'),
      `import { getFirestore, collection, query, where, orderBy, getDocs } from 'firebase/firestore';
export async function listOrderedItems() {
  return getDocs(query(collection(getFirestore(), 'items'), where('ownerId', '==', 'u-1'), orderBy('seq', 'desc')));
}
`,
    );

    const parsed = parseArgs(['firestore', 'indexes', 'generate', 'src']);
    const io = bufferIo();
    const code = await runFirestoreIndexesGenerate(
      { ...parsed, positional: parsed.positional.slice(2) },
      { cwd: dir, ...io },
    );
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'custom/firestore.indexes.json'))).toBe(true);
    expect(existsSync(join(dir, 'firestore.indexes.json'))).toBe(false);
  });

  it('rejects omitted values on value-taking CLI flags with exit code 2 without mutating files', async () => {
    const dir = makeTempDir('cli-missing-value-flags-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    const originalDbRules = JSON.stringify(
      { rules: { users: { $uid: { '.read': 'auth != null' } } } },
      null,
      2,
    );
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({ database: { rules: 'database.rules.json' } }),
    );
    writeFileSync(join(dir, 'database.rules.json'), originalDbRules);
    writeFileSync(
      join(dir, 'src/app.ts'),
      `import { getDatabase, ref, query, orderByChild, get } from 'firebase/database';
export async function listByRank() {
  return get(query(ref(getDatabase(), 'items'), orderByChild('rank')));
}
`,
    );

    for (const argv of [
      ['firestore', 'indexes', 'generate', 'src', '--out'],
      ['firestore', 'indexes', 'generate', 'src', '--out='],
    ]) {
      const p = parseArgs(argv);
      const io = bufferIo();
      const code = await runFirestoreIndexesGenerate(
        { ...p, positional: p.positional.slice(2) },
        { cwd: dir, ...io },
      );
      expect(code).toBe(2);
      expect(io.getErr()).toContain('--out');
      expect(existsSync(join(dir, 'firestore.indexes.json'))).toBe(false);
    }

    for (const argv of [
      ['database', 'indexes', 'generate', 'src', '--out'],
      ['database', 'indexes', 'generate', 'src', '--rules'],
      ['database', 'indexes', 'generate', 'src', '--instance'],
    ]) {
      const p = parseArgs(argv);
      const io = bufferIo();
      const code = await runDatabaseIndexesGenerate(
        { ...p, positional: p.positional.slice(2) },
        { cwd: dir, ...io },
      );
      expect(code).toBe(2);
      expect(readFileSync(join(dir, 'database.rules.json'), 'utf8')).toBe(originalDbRules);
    }

    for (const argv of [
      ['assurance', 'derive', '--root', dir, '--port'],
      ['assurance', 'derive', '--root', dir, '-p'],
      ['assurance', 'derive', '--root', dir, '--url'],
      ['assurance', 'derive', '--root', dir, '--fail-on'],
      ['assurance', 'derive', '--campaign-id'],
      ['assurance', 'derive', '--root'],
    ]) {
      const io = bufferIo();
      const code = await runAssuranceDerive(parseArgs(argv), { cwd: dir, ...io });
      expect(code).toBe(2);
    }

    for (const argv of [
      ['verify', '--static', '--root', dir, '--rules'],
      ['verify', '--static', '--root', dir, '--service'],
      ['verify', '--static', '--root', dir, '--fail-on'],
      ['verify', '--static', '--root'],
    ]) {
      const io = bufferIo();
      const code = await runVerifyStatic(parseArgs(argv), { cwd: dir, ...io });
      expect(code).toBe(2);
    }
  });

  it('bundles 2+modules relative imports passed via --rules overrides in verify --static', async () => {
    const dir = makeTempDir('verify-static-modular-override-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'shared.rules'),
      `export function isOwner(ownerId) {
  return request.auth != null && request.auth.uid == ownerId;
}
export function isImageMime() {
  return request.resource.contentType.matches('image/.*');
}
`,
    );
    writeFileSync(
      join(dir, 'custom.firestore.rules'),
      `rules_version = '2+modules';
import { isOwner } from './shared.rules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get, list: if isOwner(resource.data.ownerId);
    }
  }
}
`,
    );
    writeFileSync(
      join(dir, 'custom.storage.rules'),
      `rules_version = '2+modules';
import { isOwner, isImageMime } from './shared.rules';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow create: if isOwner(request.resource.metadata.ownerId) && isImageMime();
    }
  }
}
`,
    );
    writeFileSync(
      join(dir, 'src/app.ts'),
      `import { getFirestore, collection, getDocs } from 'pyric/firestore';
import { getStorage, ref, uploadBytes } from 'pyric/storage';
declare const app: unknown;
export async function run() {
  await getDocs(collection(getFirestore(app), 'items'));
  await uploadBytes(ref(getStorage(app), 'docs/doc-1'), new Uint8Array([1]), {
    contentType: 'text/plain',
    customMetadata: { ownerId: 'u-1' },
  });
}
`,
    );

    const io = bufferIo();
    const code = await runVerifyStatic(
      parseArgs([
        'verify',
        '--static',
        '--root',
        dir,
        '--rules',
        'firestore=custom.firestore.rules',
        '--rules',
        'storage=custom.storage.rules',
        '--json',
      ]),
      { cwd: dir, ...io },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(io.getOut()) as {
      ok: boolean;
      diagnostics: Array<{ code: string }>;
    };
    expect(parsed.ok).toBe(false);
    const codes = parsed.diagnostics.map((d) => d.code);
    expect(codes).toContain('firestore-unprovable-list-query');
    expect(codes).toContain('storage-content-type-mismatch');
  });
});
