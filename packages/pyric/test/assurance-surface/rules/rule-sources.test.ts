import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { staticQueryProofPass } from '../../../src/assurance-surface/passes/static-query-proof.js';
import { firestoreRequiredClaims, storageRequiredClaims } from '../../../src/assurance-surface/rules/claims.js';
import { loadRuleSources, parseRtdbRulesText } from '../../../src/assurance-surface/rules/rule-sources.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';

const dir = mkdtempSync(join(tmpdir(), 'rule-sources-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadRuleSources', () => {
  test('reads firebase.json targets once each, with comments in RTDB rules', () => {
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({
      firestore: { rules: 'firestore.rules' },
      database: [{ target: 'a', rules: 'db.rules.json' }, { target: 'b', rules: 'db.rules.json' }],
    }));
    writeFileSync(join(dir, 'firestore.rules'), "rules_version = '2';");
    writeFileSync(join(dir, 'db.rules.json'), '{\n  // generated\n  "rules": { ".read": true, },\n}');
    const s = loadRuleSources(dir);
    expect(s.firestore.map((f) => f.source)).toEqual(['firestore.rules']);
    expect(s.rtdb).toEqual([{ source: 'db.rules.json', json: { rules: { '.read': true } } }]);
    expect(s.problems).toEqual([]);
  });

  test('explicit files win and suppress firebase.json discovery for unspecified services', () => {
    const customRtdb = join(dir, 'custom.rules.json');
    writeFileSync(customRtdb, JSON.stringify({ rules: { items: { '.read': 'auth != null' } } }));
    const s = loadRuleSources(dir, { rtdb: [customRtdb] });
    expect(s.firestore).toEqual([]);
    expect(s.rtdb.map((r) => r.source)).toEqual(['custom.rules.json']);

    const missing = loadRuleSources(dir, { rtdb: [join(dir, 'missing.json')] });
    expect(missing.firestore).toEqual([]);
    expect(missing.rtdb).toEqual([]);
    expect(missing.problems[0]).toContain('missing.json');
  });

  test('parseRtdbRulesText accepts trailing commas', () => {
    expect(parseRtdbRulesText('{"rules":{"a":{".write":"auth != null",},},}')).toEqual({ rules: { a: { '.write': 'auth != null' } } });
  });

  test('loads single and per-bucket storage rule entries from firebase.json', () => {
    const stDir = mkdtempSync(join(tmpdir(), 'rule-sources-storage-'));
    try {
      writeFileSync(
        join(stDir, 'firebase.json'),
        JSON.stringify({
          storage: [
            { rules: 'storage.rules' },
            { bucket: 'media-bucket', rules: 'media.storage.rules' },
          ],
        }),
      );
      writeFileSync(join(stDir, 'storage.rules'), "rules_version = '2'; service firebase.storage {}");
      writeFileSync(join(stDir, 'media.storage.rules'), "rules_version = '2'; service firebase.storage {}");
      const loaded = loadRuleSources(stDir);
      expect(loaded.storage).toEqual([
        { source: 'storage.rules', text: "rules_version = '2'; service firebase.storage {}" },
        {
          source: 'media.storage.rules',
          bucket: 'media-bucket',
          text: "rules_version = '2'; service firebase.storage {}",
        },
      ]);
    } finally {
      rmSync(stDir, { recursive: true, force: true });
    }
  });

  test('refuses symbolic links for rule files', () => {
    const symDir = mkdtempSync(join(tmpdir(), 'rule-sources-symlink-'));
    try {
      const realTarget = join(symDir, 'outside.rules');
      writeFileSync(realTarget, "rules_version = '2';");
      const linked = join(symDir, 'firestore.rules');
      symlinkSync(realTarget, linked);
      writeFileSync(
        join(symDir, 'firebase.json'),
        JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
      );
      const loaded = loadRuleSources(symDir);
      expect(loaded.firestore).toEqual([]);
      expect(loaded.problems[0]).toContain('Symbolic links are not followed');
    } finally {
      rmSync(symDir, { recursive: true, force: true });
    }
  });

  test('loads per-database Firestore and per-instance RTDB rule entries from firebase.json', () => {
    const multiDir = mkdtempSync(join(tmpdir(), 'rule-sources-multi-'));
    try {
      writeFileSync(
        join(multiDir, 'firebase.json'),
        JSON.stringify({
          firestore: [
            { rules: 'firestore.rules' },
            { database: 'analytics', rules: 'analytics.firestore.rules' },
          ],
          database: [
            { rules: 'database.rules.json' },
            { instance: 'shard-a', rules: 'shard-a.rules.json' },
          ],
        }),
      );
      writeFileSync(join(multiDir, 'firestore.rules'), "rules_version = '2';");
      writeFileSync(join(multiDir, 'analytics.firestore.rules'), "rules_version = '2'; // analytics");
      writeFileSync(join(multiDir, 'database.rules.json'), '{"rules":{".read":false}}');
      writeFileSync(join(multiDir, 'shard-a.rules.json'), '{"rules":{"metrics":{".read":"auth != null"}}}');

      const loaded = loadRuleSources(multiDir);
      expect(loaded.firestore).toEqual([
        { source: 'firestore.rules', text: "rules_version = '2';" },
        {
          source: 'analytics.firestore.rules',
          database: 'analytics',
          text: "rules_version = '2'; // analytics",
        },
      ]);
      expect(loaded.rtdb).toEqual([
        { source: 'database.rules.json', json: { rules: { '.read': false } } },
        {
          source: 'shard-a.rules.json',
          instance: 'shard-a',
          json: { rules: { metrics: { '.read': 'auth != null' } } },
        },
      ]);
    } finally {
      rmSync(multiDir, { recursive: true, force: true });
    }
  });

  test('bundles 2+modules stdlib and relative .rules imports for Firestore and Storage and enforces project containment on relative imports', () => {
    const modDir = mkdtempSync(join(tmpdir(), 'rule-sources-modules-'));
    try {
      const helpersDir = join(modDir, 'rules', 'helpers');
      rmSync(helpersDir, { recursive: true, force: true });
      writeFileSync(
        join(modDir, 'firebase.json'),
        JSON.stringify({
          firestore: { rules: 'firestore.rules' },
          storage: { rules: 'storage.rules' },
        }),
      );
      writeFileSync(
        join(modDir, 'tenant.rules'),
        `export function isSameOrg(orgId) {
  return request.auth.token.orgId == orgId;
}
`,
      );
      writeFileSync(
        join(modDir, 'firestore.rules'),
        `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
import { isSameOrg } from './tenant.rules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/items/{itemId} {
      allow get, list: if isAuthenticated() && isSameOrg(orgId) && resource.data.ownerId == request.auth.uid;
    }
  }
}
`,
      );
      writeFileSync(
        join(modDir, 'storage.rules'),
        `rules_version = '2+modules';
import { isAuthenticated, isOwner } from 'auth';
import { contentTypeMatches } from 'storage/uploads';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{fileName} {
      allow write: if isAuthenticated() && isOwner(uid) && contentTypeMatches('image/.*');
    }
  }
}
`,
      );

      const loaded = loadRuleSources(modDir);
      expect(loaded.problems).toEqual([]);
      expect(loaded.firestore).toHaveLength(1);
      expect(loaded.firestore[0]!.text).toContain("rules_version = '2';");
      expect(loaded.firestore[0]!.text).toContain('request.auth.token.orgId == orgId');
      expect(loaded.storage).toHaveLength(1);
      expect(loaded.storage![0]!.text).toContain("rules_version = '2';");
      expect(loaded.storage![0]!.text).toContain('image/.*');

      const usage = extractSdkUsage({
        root: '/virtual',
        files: {
          'src/app.ts': `
            import { getFirestore, collection, getDocs } from 'firebase/firestore';
            export async function loadItems() {
              await getDocs(collection(getFirestore(), 'orgs', 'acme', 'items'));
            }
          `,
        },
      });
      const rawModularFs = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
import { hasRole } from './roles.rules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/items/{itemId} {
      allow get, list: if isAuthenticated() && hasRole('editor') && resource.data.ownerId == request.auth.uid;
    }
  }
}`;
      const modules = {
        './roles.rules': `export function hasRole(expected) { return request.auth.token.role == expected; }`,
      };
      const diags = staticQueryProofPass(usage, {
        rules: rawModularFs,
        modules,
      });
      expect(diags.map((d) => d.code)).toContain('firestore-unprovable-list-query');

      const claims = firestoreRequiredClaims(rawModularFs, {
        path: 'orgs/acme/items/i1',
        op: 'get',
        modules,
      });
      expect(claims).toEqual({ role: 'editor' });

      const rawModularStorage = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
import { contentTypeMatches } from 'storage/uploads';
import { hasRole } from './roles.rules';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{fileName} {
      allow write: if isAuthenticated() && hasRole('uploader') && contentTypeMatches('image/.*');
    }
  }
}`;
      const storageClaims = storageRequiredClaims(rawModularStorage, {
        path: 'users/u1/pic.png',
        op: 'create',
        modules,
      });
      expect(storageClaims).toEqual({ role: 'uploader' });

      const surface = projectRuleSurface({
        firestore: [{ source: 'firestore.rules', text: rawModularFs, modules }],
        storage: [{ source: 'storage.rules', text: rawModularStorage, modules }],
      });
      const storageEntry = surface.entries.find((e) => e.pattern.service === 'storage');
      expect(storageEntry?.storageMetadata?.contentTypePattern).toContain('image/.*');
    } finally {
      rmSync(modDir, { recursive: true, force: true });
    }
  });

  test('resolves active project alias from XDG firebase-tools configstore and normalizes *-default-rtdb without .firebaserc', () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'pyric-rule-sources-rc-'));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    try {
      const projDir = join(tmpBase, 'multi-alias');
      const xdgDir = join(tmpBase, 'xdg');
      mkdirSync(projDir, { recursive: true });
      mkdirSync(join(xdgDir, 'configstore'), { recursive: true });
      writeFileSync(
        join(projDir, '.firebaserc'),
        JSON.stringify({
          projects: { staging: 'proj-stage', prod: 'proj-prod' },
          targets: {
            'proj-stage': {
              firestore: { secondaryDb: ['db-stage'] },
              database: { secondaryRtdb: ['inst-stage'] },
              storage: { assets: ['stage-assets'] },
            },
          },
        }),
      );
      writeFileSync(
        join(xdgDir, 'configstore', 'firebase-tools.json'),
        JSON.stringify({ activeProjects: { [projDir]: 'staging' } }),
      );
      writeFileSync(
        join(projDir, 'firebase.json'),
        JSON.stringify({
          firestore: [{ target: 'secondaryDb', rules: 'fs.rules' }],
          database: [{ target: 'secondaryRtdb', rules: 'db.rules.json' }],
          storage: [{ target: 'assets', rules: 'st.rules' }],
        }),
      );
      writeFileSync(
        join(projDir, 'fs.rules'),
        "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /items/{id} { allow read: if true; } } }",
      );
      writeFileSync(join(projDir, 'db.rules.json'), JSON.stringify({ rules: { '.read': true } }));
      writeFileSync(
        join(projDir, 'st.rules'),
        "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /docs/{id} { allow read: if true; } } }",
      );

      process.env.XDG_CONFIG_HOME = xdgDir;
      const stageLoaded = loadRuleSources(projDir);
      expect(stageLoaded.firestore.map((s) => s.database)).toEqual(['db-stage']);
      expect(stageLoaded.rtdb.map((s) => s.instance)).toEqual(['inst-stage']);
      expect(stageLoaded.storage?.map((s) => s.bucket)).toEqual(['stage-assets']);

      const noRcDir = join(tmpBase, 'no-rc');
      mkdirSync(noRcDir, { recursive: true });
      writeFileSync(
        join(noRcDir, 'firebase.json'),
        JSON.stringify({
          database: [
            { instance: 'proj-1-default-rtdb', rules: 'default.rules.json' },
            { instance: 'secondary-rtdb', rules: 'secondary.rules.json' },
          ],
        }),
      );
      writeFileSync(join(noRcDir, 'default.rules.json'), JSON.stringify({ rules: { '.read': true } }));
      writeFileSync(join(noRcDir, 'secondary.rules.json'), JSON.stringify({ rules: { '.read': false } }));

      const noRcLoaded = loadRuleSources(noRcDir);
      expect(noRcLoaded.rtdb.map((s) => s.instance)).toEqual([undefined, 'secondary-rtdb']);
    } finally {
      if (prevXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prevXdg;
      }
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
