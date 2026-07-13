import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import * as credentialFreeDiscovery from '../../src/discover/index.js';
import {
  LocalEnvironmentCrawlerAdapter,
  crawl,
  findCollectionGroup,
} from '../../src/discover/index.js';
import { createRestCrawlerFirestore } from '../../src/discover/production.js';

const ALLOW_ALL_RULES =
  "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; }}}";

describe('credential-free discovery contract', () => {
  test('public discovery traverses, groups, infers, and converges without network access', async () => {
    const env = new LocalEnvironment();
    const documents: Record<string, Record<string, unknown>> = {
      'users/alice': { displayName: 'Alice' },
      'users/bob': { displayName: 'Bob' },
    };
    for (const user of ['alice', 'bob']) {
      for (let i = 0; i < 3; i++) {
        documents[`users/${user}/posts/${user}-${i}`] = {
          status: 'published',
          score: 1,
        };
      }
    }
    env.seed({ rules: ALLOW_ALL_RULES, documents });

    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error('credential-free discovery attempted network access');
    }) as typeof fetch;

    try {
      const source = new LocalEnvironmentCrawlerAdapter(env);
      const result = await crawl(source, { stopOnStable: 2, maxSamples: 10 });

      expect([...result.finalizedSchemas.keys()].sort()).toEqual([
        'users',
        'users/{userId}/posts',
      ]);

      const posts = result.finalizedSchemas.get('users/{userId}/posts');
      expect(posts).toMatchObject({
        templatePath: 'users/{userId}/posts',
        samplingComplete: 'converged_via_stable',
        declaredAt: 2,
      });
      expect(posts?.schema.fields.status?.types).toContainEqual({
        kind: 'scalar',
        type: 'string',
      });
      expect(posts?.schema.fields.score?.types).toContainEqual({
        kind: 'scalar',
        type: 'integer',
      });

      const grouped = await findCollectionGroup(source, 'posts');
      expect(grouped).toEqual({
        hosts: [
          {
            templatePath: 'users/{userId}/posts',
            sampleDocCount: 6,
          },
        ],
        reads: 6,
        limitWasReached: false,
      });
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('production discovery remains available as an isolated adapter for issue #265', () => {
    expect(typeof createRestCrawlerFirestore).toBe('function');
    expect('createRestCrawlerFirestore' in credentialFreeDiscovery).toBe(false);
    expect('RestCrawlerFirestoreError' in credentialFreeDiscovery).toBe(false);
  });

  test('credential-free module graph has no production, credential, or Firebase SDK edge', () => {
    const entry = fileURLToPath(
      new URL('../../src/discover/index.ts', import.meta.url),
    );
    const visited = new Set<string>();
    const externalSpecifiers = new Set<string>();

    function visit(file: string): void {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      const imports = source.matchAll(
        /(?:from\s+|import\s*\()(['"])([^'"]+)\1/g,
      );
      const sideEffectImports = source.matchAll(
        /\bimport\s+(['"])([^'"]+)\1/g,
      );
      for (const match of [...imports, ...sideEffectImports]) {
        const specifier = match[2]!;
        if (!specifier.startsWith('.')) {
          externalSpecifiers.add(specifier);
          continue;
        }
        const target = resolve(
          dirname(file),
          specifier.replace(/\.js$/, '.ts'),
        );
        visit(target);
      }
    }

    visit(entry);

    expect(
      [...visited].some(
        (file) =>
          file.endsWith('production.ts') ||
          file.endsWith('rest-crawler-firestore.ts'),
      ),
    ).toBe(false);
    expect(
      [...visited].some((file) => file.includes('/credentials/')),
    ).toBe(false);
    expect([...externalSpecifiers]).not.toContain('@pyric/cli/discover');
    expect(
      [...externalSpecifiers].filter(
        (specifier) =>
          specifier === 'firebase' ||
          specifier.startsWith('firebase/') ||
          specifier === 'firebase-admin' ||
          specifier.startsWith('firebase-admin/'),
      ),
    ).toEqual([]);
  });
});
