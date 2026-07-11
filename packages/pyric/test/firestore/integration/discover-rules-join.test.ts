/**
 * Integration test for the codegen agent flow: `firestore_discover_paths`
 * × rules-AST join (Phase 3.2's third + fourth tool calls).
 *
 * The codegen agent JOINs the rules AST (from `firestore_inspect_rules`)
 * with the per-templatePath field schemas (from
 * `firestore_discover_paths`) on the templatePath dimension to build
 * a single typed code generator. This test exercises that join
 * hermetically:
 *   - Discover side: simulator-backed via `LocalEnvironmentCrawlerAdapter`.
 *   - Rules side: in-process AST via `parseToAST`, mirroring exactly
 *     what `firestore_inspect_rules` emits at the structural layer.
 *
 * No live Firestore, no rules deploy, no service account — runs in CI.
 *
 * Risk 6 cover: rules emit single-segment wildcards (`{userId}`) AND
 * recursive ones (`{document=**}`); the seeded ruleset deliberately
 * uses both so we surface any future drift in the templatePath ↔
 * matchPath contract before it ships.
 *
 * Moved 2026-05-24 from sdk/test/firestore/discover/codegen-flow.test.ts
 * as part of W8C — dispatch switched from legacy
 * `getAgentTools(app).call(name)` to direct invocation of the canonical
 * `createFirestoreDiscoverTools` factory. Test logic is identical;
 * the AgentApp shim is gone.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import {
  LocalEnvironmentCrawlerAdapter,
  createFirestoreDiscoverTools,
} from '../../../../pyric-tools/src/discover/index.js';
import { parseToAST } from 'pyric/rules/internal';
import type { MatchBlock } from 'pyric/rules/internal';

// ─── Test corpus ──────────────────────────────────────────────────────────

const SEED_DOCS: Record<string, Record<string, unknown>> = {
  // Users + posts subcollection: exercises a 2-deep templatePath.
  'users/u1': { name: 'Alice', age: 30, role: 'admin' },
  'users/u2': { name: 'Bob', age: 25, role: 'user' },
  'users/u1/posts/p1': { title: 'hello', published: true },
  'users/u1/posts/p2': { title: 'world', published: false },
  'users/u2/posts/p1': { title: 'foo', published: true },
  // Articles: single-segment match.
  'articles/a1': { headline: 'first', wordCount: 100 },
  'articles/a2': { headline: 'second', wordCount: 250 },
};

// Rules deliberately mix single-segment + recursive wildcard patterns
// to cover Risk 6 (templatePath ↔ matchPath contract under both forms).
const TEST_RULES = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      match /posts/{postId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
    match /articles/{articleId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    // Recursive wildcard — exercises the {document=**} form.
    match /archive/{document=**} {
      allow read: if request.auth != null;
    }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Walk the rules AST and rebuild full match paths. Each match's
 * `path.raw` carries only the local segment; nested matches lose the
 * parent prefix unless we reassemble them. discover_paths emits FULL
 * templatePaths, so the join requires aligned reconstruction here.
 */
function collectFullMatchPaths(rootMatch: MatchBlock): string[] {
  const paths: string[] = [];
  function walk(match: MatchBlock, parentPath: string): void {
    const local = match.path.raw.startsWith('/')
      ? match.path.raw.slice(1)
      : match.path.raw;
    const full = parentPath ? `${parentPath}/${local}` : local;
    paths.push(full);
    for (const child of match.children) walk(child, full);
  }
  for (const child of rootMatch.children) walk(child, '');
  return paths;
}

function buildDiscoverHandler() {
  const env = new LocalEnvironment();
  env.seed({ rules: TEST_RULES, documents: SEED_DOCS });
  const adapter = new LocalEnvironmentCrawlerAdapter(env);
  const tools = createFirestoreDiscoverTools({
    resolveDb: () => adapter as never,
  });
  const discover = tools.find((t) => t.name === 'firestore_discover_paths');
  if (!discover) {
    throw new Error('firestore_discover_paths missing from createFirestoreDiscoverTools — contract changed.');
  }
  return discover;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('codegen-flow: discover_paths × rules-AST join (simulator)', () => {
  test('discover finds the seeded templatePaths (single + nested)', async () => {
    const discover = buildDiscoverHandler();
    const result = await discover.execute({}, { signal: new AbortController().signal });

    expect(result.ok).toBe(true);
    const data = result.data as { schemas: Record<string, unknown>; complete: boolean };
    expect(data.complete).toBe(true);

    const found = Object.keys(data.schemas);
    // Single-segment root collections.
    expect(found).toContain('users');
    expect(found).toContain('articles');
    // Nested templatePath via toTemplatePath() inference.
    expect(found).toContain('users/{userId}/posts');
  });

  test('discover schema captures field types from seeded docs', async () => {
    const discover = buildDiscoverHandler();
    const result = await discover.execute({}, { signal: new AbortController().signal });

    expect(result.ok).toBe(true);
    const data = result.data as {
      schemas: Record<
        string,
        { schema: { fields: Record<string, { types: { kind: string; type?: string }[] }> } }
      >;
    };

    const usersSchema = data.schemas['users']!;
    expect(usersSchema).toBeDefined();
    expect(usersSchema.schema.fields['name']).toBeDefined();
    const nameTypes = usersSchema.schema.fields['name']!.types;
    expect(nameTypes.some((t) => t.kind === 'scalar' && t.type === 'string')).toBe(true);
    const ageTypes = usersSchema.schema.fields['age']!.types;
    expect(ageTypes.some((t) => t.kind === 'scalar' && t.type === 'integer')).toBe(true);
  });

  test('templatePath ↔ matchPath join: every seeded templatePath has a rules entry', async () => {
    const discover = buildDiscoverHandler();
    const result = await discover.execute({}, { signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    const data = result.data as { schemas: Record<string, unknown> };

    // Parse rules in-process — same AST shape that firestore_inspect_rules emits.
    const ast = parseToAST(TEST_RULES);
    expect(ast).not.toBeNull();
    const rootMatch = ast!.service.match;
    const allMatchPaths = collectFullMatchPaths(rootMatch);

    const discoveredPaths = Object.keys(data.schemas);

    // Rules match paths terminate at the document wildcard
    // (e.g. `users/{userId}`); discover's templatePaths terminate at
    // the collection (`users`). To align them on the COLLECTION
    // dimension, drop the trailing `/{xxx}` segment from each
    // non-recursive match path. The recursive `{document=**}` arm is
    // skipped here — by design it isn't a single collection.
    const ruleCollectionPaths = allMatchPaths
      .filter((p) => !p.includes('{document=**}'))
      .map((p) => {
        const segments = p.split('/');
        // Last segment is `{wildcard}`; drop it to get the collection path.
        return segments.slice(0, -1).join('/');
      });

    // For each discovered path that maps to a non-recursive rule, we
    // expect a literal collection-level match. The recursive
    // `archive/{document=**}` arm is not crawled (no docs seeded
    // under it) so it doesn't appear in discover's output — it's
    // there in the rules to verify the recursive form parses without
    // breaking the join.
    for (const tp of discoveredPaths) {
      const found = ruleCollectionPaths.some((mp) => mp === tp);
      expect(
        found,
        `discover surfaced templatePath ${tp} but rules has no aligned match`,
      ).toBe(true);
    }

    // And the recursive form is present in the rules summary regardless.
    expect(allMatchPaths.some((p) => p.includes('{document=**}'))).toBe(true);
  });

  test('cost counters report listOps + readOps from a real crawl', async () => {
    const discover = buildDiscoverHandler();
    const result = await discover.execute({}, { signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    const data = result.data as { listOps: number; readOps: number };
    // 1 root listCollections + per-collection listDocuments + per-doc
    // listCollections — bounded but always > 0 for a non-empty corpus.
    expect(data.listOps).toBeGreaterThan(0);
    // Sampled at least one doc per collection.
    expect(data.readOps).toBeGreaterThan(0);
  });
});
