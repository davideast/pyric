import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssuranceCampaignStore } from '../../src/assurance/tools.js';
import { deriveAssurance } from '../../src/assurance/derive.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerifyStatic } from '../../src/cli/verify-static.js';
import { prepareRulesSource } from '../../src/serve/rules.js';
import { parsedRulesOf } from '../../src/serve/worker/host/observe-local-firestore-scopes.js';

const STORAGE_ALLOW_ALL = `rules_version = '2';
service firebase.storage {
  function storageHelper() {
    return true;
  }
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if storageHelper();
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
    match /{document=**} {
      allow read, write: if true;
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

function makeProjectDir(rulesContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-wrong-svc-derive-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'firebase.json'),
    JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
  );
  writeFileSync(join(dir, 'firestore.rules'), rulesContent);
  writeFileSync(
    join(dir, 'src/app.ts'),
    [
      "import { getFirestore, collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';",
      'export async function runClient() {',
      '  const db = getFirestore();',
      "  await getDocs(collection(db, 'posts'));",
      "  await getDoc(doc(db, 'posts', 'p1'));",
      "  await setDoc(doc(db, 'posts', 'p1'), { title: 'hi' });",
      '}',
    ].join('\n'),
  );
  return dir;
}

function bufferIo(cwd: string) {
  let out = '';
  let err = '';
  return {
    cwd,
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    getOut: () => out,
    getErr: () => err,
  };
}

describe('CLI assurance, verify --static, prepareRulesSource, and scope indexing on #1434 & Path.bind', () => {
  test.each([
    ['service firebase.storage', STORAGE_ALLOW_ALL],
    ['service foo.bar', UNKNOWN_FOO_BAR],
    ['service firebase.firestore', HALLUCINATED_FIREBASE_FIRESTORE],
    ['multi-service with dead firebase.firestore', MULTI_SERVICE_WITH_HALLUCINATED],
  ])('deriveAssurance and verify --static accept %s and report unprovable list query + uncovered operations', async (_label, rulesContent) => {
    const dir = makeProjectDir(rulesContent);
    try {
      const store = new AssuranceCampaignStore();
      const derived = await deriveAssurance({ root: dir }, { store });
      const codes = derived.diagnostics.map((d) => d.code);
      expect(codes).not.toContain('invalid-rules-configuration');
      expect(codes).toContain('firestore-unprovable-list-query');
      expect(codes).toContain('uncovered-client-operation');

      const exported = store.get(derived.campaignId).export();
      expect(exported.campaign.target.rules.firestore).toBe(rulesContent);

      const io = bufferIo(dir);
      const exitCode = await runVerifyStatic(
        parseArgs(['verify', '--static', '--root', dir, '--json']),
        io,
      );
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(io.getOut()) as {
        ok: boolean;
        diagnostics: Array<{ code: string }>;
      };
      expect(parsed.ok).toBe(false);
      const staticCodes = parsed.diagnostics.map((d) => d.code);
      expect(staticCodes).not.toContain('invalid-rules-configuration');
      expect(staticCodes).toContain('firestore-unprovable-list-query');
      expect(staticCodes).toContain('uncovered-client-operation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verify --static --rules firestore=<file> accepts a wrong-service ruleset and emits static-proof denials', async () => {
    const dir = makeProjectDir(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} { allow read, write: if true; }
  }
}`);
    try {
      writeFileSync(join(dir, 'wrong.rules'), STORAGE_ALLOW_ALL);
      const io = bufferIo(dir);
      const exitCode = await runVerifyStatic(
        parseArgs(['verify', '--static', '--root', dir, '--rules', 'firestore=wrong.rules', '--json']),
        io,
      );
      expect(exitCode).toBe(1);
      expect(io.getErr()).toBe('');
      const parsed = JSON.parse(io.getOut()) as { diagnostics: Array<{ code: string }> };
      const codes = parsed.diagnostics.map((d) => d.code);
      expect(codes).toContain('firestore-unprovable-list-query');
      expect(codes).toContain('uncovered-client-operation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prepareRulesSource accepts let-bound path literal templates used with .bind(...)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-let-bind-prepare-'));
    try {
      const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function matchesBound() {
      let t = /a/{x};
      return t.bind({'x': '1'}) == path('/a/1');
    }
    match /items/{id} {
      allow get: if request.auth != null && matchesBound();
    }
  }
}`;
      const prepared = prepareRulesSource(source, dir);
      expect(prepared).toContain('let t = /a/{x};');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parsedRulesOf ignores non-Firestore service functions when indexing Firestore trace scopes', () => {
    const entry = parsedRulesOf(STORAGE_ALLOW_ALL);
    expect(entry).not.toBeNull();
    expect(entry?.allFunctions.has('storageHelper')).toBe(false);
  });
});
