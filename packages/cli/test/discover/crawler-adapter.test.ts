/**
 * Unit tests for the LocalEnvironment → CrawlerFirestore adapter.
 *
 * Covers:
 *   1. LocalState.listRootCollections / listSubcollections derive IDs
 *      from the keyspace correctly (incl. phantom-parent paths).
 *   2. wire-encoder round-trips JSON-shaped values into the discriminator
 *      shape that wire.ts expects.
 *   3. The adapter satisfies the full CrawlerFirestore contract end-to-end:
 *      discover_paths runs to completion against an in-memory simulator.
 *   4. collectionGroup() finds parents whose penultimate segment matches.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { LocalState } from 'pyric/sandbox/internal';
import { encodeValue, encodeFieldsProto } from 'pyric/sandbox/internal';
import { LocalEnvironmentCrawlerAdapter } from '../../src/discover/crawler-adapter.js';
import { crawl } from '../../src/discover/crawler.js';
import { findCollectionGroup } from '../../src/discover/findCollectionGroup.js';

// ─── 1. LocalState collection-derivation ──────────────────────────────────

describe('LocalState.listRootCollections', () => {
  test('returns deduped first-segment IDs from stored paths', () => {
    const s = new LocalState({
      'users/u1': { name: 'A' },
      'users/u2': { name: 'B' },
      'articles/a1': { headline: 'x' },
    });
    expect(s.listRootCollections().sort()).toEqual(['articles', 'users']);
  });

  test('surfaces root collection from phantom-parent descendants', () => {
    const s = new LocalState({
      'users/u1/posts/p1': { title: 'hello' },
    });
    // `users/u1` is not stored, but `users` should still surface because a
    // descendant lives under it.
    expect(s.listRootCollections()).toEqual(['users']);
  });

  test('empty state returns empty array', () => {
    expect(new LocalState().listRootCollections()).toEqual([]);
  });
});

describe('LocalState.listSubcollections', () => {
  test('returns deduped child-collection IDs under a doc path', () => {
    const s = new LocalState({
      'users/u1/posts/p1': { title: 'a' },
      'users/u1/posts/p2': { title: 'b' },
      'users/u1/sessions/s1': { token: 't' },
      'users/u2/posts/p1': { title: 'other' },
    });
    expect(s.listSubcollections('users/u1').sort()).toEqual(['posts', 'sessions']);
  });

  test('returns empty when the doc path has no descendants', () => {
    const s = new LocalState({ 'users/u1': { name: 'A' } });
    expect(s.listSubcollections('users/u1')).toEqual([]);
  });

  test('does not match sibling paths sharing a prefix', () => {
    const s = new LocalState({
      'usersExtra/u1/posts/p1': { x: 1 },
      'users/u1': { x: 1 },
    });
    expect(s.listSubcollections('users/u1')).toEqual([]);
  });
});

// ─── 2. wire-encoder ──────────────────────────────────────────────────────

describe('wire-encoder', () => {
  test('encodes scalars to the right discriminator keys', () => {
    expect(encodeValue(null)).toEqual({ nullValue: null });
    expect(encodeValue(true)).toEqual({ booleanValue: true });
    expect(encodeValue(42)).toEqual({ integerValue: '42' });
    expect(encodeValue(3.14)).toEqual({ doubleValue: 3.14 });
    expect(encodeValue('hi')).toEqual({ stringValue: 'hi' });
  });

  test('integer encoding uses string form (matches admin SDK int64)', () => {
    expect(encodeValue(0)).toEqual({ integerValue: '0' });
    expect(encodeValue(-7)).toEqual({ integerValue: '-7' });
  });

  test('encodes arrays and maps recursively', () => {
    expect(encodeValue(['a', 1])).toEqual({
      arrayValue: { values: [{ stringValue: 'a' }, { integerValue: '1' }] },
    });
    expect(encodeValue({ nested: { x: 1 } })).toEqual({
      mapValue: {
        fields: {
          nested: { mapValue: { fields: { x: { integerValue: '1' } } } },
        },
      },
    });
  });

  test('encodeFieldsProto produces the expected top-level shape', () => {
    const proto = encodeFieldsProto({ name: 'A', age: 30, active: true });
    expect(proto).toEqual({
      name: { stringValue: 'A' },
      age: { integerValue: '30' },
      active: { booleanValue: true },
    });
  });

  test('throws on unsupported types', () => {
    expect(() => encodeValue(BigInt(10))).toThrow('unsupported value type');
  });
});

// ─── 3. Adapter end-to-end with discover_paths ────────────────────────────

describe('LocalEnvironmentCrawlerAdapter + discover_paths', () => {
  function setup() {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; }}}`,
      documents: {
        'users/u1': { name: 'Alice', age: 30, active: true },
        'users/u2': { name: 'Bob', age: 25, active: false },
        'users/u1/posts/p1': { title: 'hello', published: true },
        'users/u1/posts/p2': { title: 'world', published: false },
        'articles/a1': { headline: 'first', wordCount: 100 },
        'articles/a2': { headline: 'second', wordCount: 250 },
      },
    });
    return new LocalEnvironmentCrawlerAdapter(env);
  }

  test('crawl() discovers all root collections', async () => {
    const adapter = setup();
    const result = await crawl(adapter);
    const paths = Array.from(result.finalizedSchemas.keys());
    expect(paths).toContain('users');
    expect(paths).toContain('articles');
    expect(paths).toContain('users/{userId}/posts');
  });

  test('crawl() captures field types from the encoded wire data', async () => {
    const adapter = setup();
    const result = await crawl(adapter);
    const usersSchema = result.finalizedSchemas.get('users');
    expect(usersSchema).toBeDefined();
    expect(usersSchema!.schema.fields['name']).toBeDefined();
    const nameTypes = usersSchema!.schema.fields['name']!.types;
    expect(nameTypes.some((t) => t.kind === 'scalar' && t.type === 'string')).toBe(true);
    const ageTypes = usersSchema!.schema.fields['age']!.types;
    // Plain JS integer 30 → integerValue → 'integer' field type.
    expect(ageTypes.some((t) => t.kind === 'scalar' && t.type === 'integer')).toBe(true);
  });

  test('crawl() emits per-doc reads — readOps > 0', async () => {
    const adapter = setup();
    const result = await crawl(adapter);
    expect(result.readOps).toBeGreaterThan(0);
    expect(result.listOps).toBeGreaterThan(0);
  });

  // Item 4 — phantom parent docs.
  test('crawl() reports deeper template paths even when parent docs are unstored', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; }}}`,
      // Only the deep doc — no `users/u1` stored.
      documents: { 'users/u1/posts/p1': { title: 'hello', published: true } },
    });
    const adapter = new LocalEnvironmentCrawlerAdapter(env);
    const result = await crawl(adapter);
    const paths = Array.from(result.finalizedSchemas.keys());
    expect(paths).toContain('users');
    // The phantom parent must surface the subcollection template.
    expect(paths).toContain('users/{userId}/posts');
  });

  test('phantom parent doc.get() returns an empty _fieldsProto', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; }}}`,
      documents: { 'users/u1/posts/p1': { title: 'hello' } },
    });
    const adapter = new LocalEnvironmentCrawlerAdapter(env);
    const refs = await adapter.collection('users').listDocuments();
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toBe('users/u1');
    const snap = await refs[0]!.get();
    // Phantom doc materializes as the structural empty fieldsProto live
    // Firestore would expose for a parent with only subcollections.
    expect(snap._fieldsProto).toEqual({});
    expect(snap.ref?.path).toBe('users/u1');
  });
});

// ─── 4. Adapter collectionGroup() with findCollectionGroup ────────────────

describe('LocalEnvironmentCrawlerAdapter + findCollectionGroup', () => {
  test('finds parent paths whose penultimate segment matches the id', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; }}}`,
      documents: {
        'users/u1/posts/p1': { t: 'a' },
        'users/u1/posts/p2': { t: 'b' },
        'users/u2/posts/p1': { t: 'c' },
        'users/u1/sessions/s1': { x: 1 }, // unrelated subcollection
      },
    });
    const adapter = new LocalEnvironmentCrawlerAdapter(env);
    const result = await findCollectionGroup(adapter, 'posts');
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]!.templatePath).toBe('users/{userId}/posts');
    expect(result.hosts[0]!.sampleDocCount).toBe(3);
    expect(result.limitWasReached).toBe(false);
  });

  test('honors limit and reports limitWasReached', async () => {
    const env = new LocalEnvironment();
    const docs: Record<string, { x: number }> = {};
    for (let i = 0; i < 10; i++) docs[`users/u${i}/posts/p1`] = { x: i };
    env.seed({
      rules: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; }}}`,
      documents: docs,
    });
    const adapter = new LocalEnvironmentCrawlerAdapter(env);
    const result = await findCollectionGroup(adapter, 'posts', { limit: 5 });
    expect(result.reads).toBe(5);
    expect(result.limitWasReached).toBe(true);
  });

  test('returns empty for unknown collection IDs', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; }}}`,
      documents: { 'users/u1': { x: 1 } },
    });
    const adapter = new LocalEnvironmentCrawlerAdapter(env);
    const result = await findCollectionGroup(adapter, 'nonexistent');
    expect(result.hosts).toEqual([]);
    expect(result.reads).toBe(0);
  });
});

// ─── 5. LocalEnvironment surface mirror ──────────────────────────────────

describe('LocalEnvironment.listRootCollections + listSubcollections', () => {
  test('mirrors LocalState methods through the environment surface', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; }}}`,
      documents: {
        'users/u1': { x: 1 },
        'users/u1/posts/p1': { y: 2 },
        'articles/a1': { z: 3 },
      },
    });
    expect(env.listRootCollections().sort()).toEqual(['articles', 'users']);
    expect(env.listSubcollections('users/u1')).toEqual(['posts']);
  });
});
