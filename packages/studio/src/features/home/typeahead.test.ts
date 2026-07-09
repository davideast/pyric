/** Pure typeahead matcher + index builder (specs/home.md command input). */
import { describe, expect, it } from 'bun:test';
import { ROUTES } from '../../shell/routes.js';
import {
  bfsStorageObjectPaths,
  buildResourceIndex,
  collectionEntry,
  documentEntry,
  flattenSuggestions,
  fuzzyScore,
  matchTypeahead,
  objectEntry,
  rtdbKeyEntry,
  userEntry,
  type ResourceEntry,
} from './typeahead.js';

describe('fuzzyScore', () => {
  it('ranks exact > prefix > substring > subsequence > none', () => {
    const exact = fuzzyScore('users', 'users');
    const prefix = fuzzyScore('use', 'users');
    const substring = fuzzyScore('ser', 'users');
    const subsequence = fuzzyScore('urs', 'users');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'users')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('ALICE', 'users/alice')).toBeGreaterThan(0);
  });

  it('prefers denser subsequence matches', () => {
    expect(fuzzyScore('ua', 'users/alice')).toBeGreaterThan(fuzzyScore('ua', 'u-x-x-x-x-a'));
  });

  it('returns 0 for empty needles/haystacks', () => {
    expect(fuzzyScore('', 'users')).toBe(0);
    expect(fuzzyScore('u', '')).toBe(0);
  });
});

const INDEX: ResourceEntry[] = [
  collectionEntry('users'),
  collectionEntry('orders'),
  documentEntry('users/alice'),
  documentEntry('users/bob'),
  documentEntry('orders/1001'),
  userEntry({ uid: 'uid-alice-1', email: 'alice@example.com' }),
  userEntry({ uid: 'uid-bob-2', email: 'bob@example.com' }),
  userEntry({ uid: 'anon-3' }),
  objectEntry('uploads/logo.png'),
  objectEntry('uploads/avatars/alice.png'),
  rtdbKeyEntry('presence'),
  rtdbKeyEntry('scores'),
];

describe('matchTypeahead', () => {
  it('returns nothing for empty input', () => {
    expect(matchTypeahead('', ROUTES, INDEX)).toEqual([]);
    expect(matchTypeahead('   ', ROUTES, INDEX)).toEqual([]);
  });

  it('keeps tab-navigation matches as the top group', () => {
    const groups = matchTypeahead('fire', ROUTES, INDEX);
    expect(groups[0].kind).toBe('navigate');
    expect(groups[0].results[0].label).toBe('Go to Firestore');
  });

  it('groups resource suggestions by type, in the fixed order', () => {
    const groups = matchTypeahead('alice', ROUTES, INDEX);
    const kinds = groups.map((g) => g.kind);
    // document (users/alice), user (email), object (avatars/alice.png)
    expect(kinds).toEqual(['document', 'user', 'object']);
    expect(groups.find((g) => g.kind === 'user')!.results[0].label).toBe('alice@example.com');
  });

  it('matches auth users by uid as well as email', () => {
    const groups = matchTypeahead('uid-bob', ROUTES, INDEX);
    const users = groups.find((g) => g.kind === 'user');
    expect(users).toBeDefined();
    expect(users!.results[0].label).toBe('bob@example.com');
    expect(users!.results[0].target).toEqual({ tab: 'auth', rest: ['uid-bob-2'] });
  });

  it('labels a mail-less user by uid', () => {
    const groups = matchTypeahead('anon', ROUTES, INDEX);
    const users = groups.find((g) => g.kind === 'user');
    expect(users!.results[0].label).toBe('anon-3');
  });

  it('suggests collections and documents with firestore deep-link targets', () => {
    const groups = matchTypeahead('users', ROUTES, INDEX);
    const collections = groups.find((g) => g.kind === 'collection');
    const documents = groups.find((g) => g.kind === 'document');
    expect(collections!.results[0].target).toEqual({ tab: 'firestore', rest: ['users'] });
    expect(documents!.results.map((r) => r.label)).toContain('users/alice');
    expect(documents!.results[0].target.tab).toBe('firestore');
  });

  it('suggests storage objects and rtdb keys with their deep links', () => {
    const logo = matchTypeahead('logo', ROUTES, INDEX).find((g) => g.kind === 'object');
    expect(logo!.results[0].target).toEqual({
      tab: 'storage',
      rest: ['uploads', 'logo.png'],
    });
    const rtdb = matchTypeahead('presence', ROUTES, INDEX).find((g) => g.kind === 'rtdb-key');
    expect(rtdb!.results[0].target).toEqual({ tab: 'rtdb', rest: ['presence'] });
  });

  it('caps each group', () => {
    const many = Array.from({ length: 20 }, (_, i) => documentEntry(`users/user-${i}`));
    const groups = matchTypeahead('user', ROUTES, many, 5);
    const documents = groups.find((g) => g.kind === 'document');
    expect(documents!.results).toHaveLength(5);
  });

  it('never surfaces settings (M4)', () => {
    const groups = matchTypeahead('settings', ROUTES, INDEX);
    for (const g of groups) {
      for (const r of g.results) expect(r.target.tab).not.toBe('settings');
    }
  });
});

describe('flattenSuggestions', () => {
  it('flattens groups in render order (the keyboard-nav list)', () => {
    const groups = matchTypeahead('alice', ROUTES, INDEX);
    const flat = flattenSuggestions(groups);
    expect(flat.length).toBe(groups.reduce((n, g) => n + g.results.length, 0));
    expect(flat[0]).toBe(groups[0].results[0]);
  });
});

describe('buildResourceIndex', () => {
  it('builds entries from every source, capped', async () => {
    const entries = await buildResourceIndex(
      {
        listRootCollections: () => ['users'],
        listDocumentPaths: async (id, cap) =>
          Array.from({ length: cap + 10 }, (_, i) => `${id}/d${i}`),
        listUsers: async (cap) =>
          Array.from({ length: cap + 10 }, (_, i) => ({ uid: `u${i}`, email: `u${i}@x.com` })),
        listStorageObjectPaths: async (cap) =>
          Array.from({ length: cap + 10 }, (_, i) => `f/${i}.png`),
        listRtdbTopLevelKeys: async () => ['a', 'b'],
      },
      { docsPerCollection: 3, users: 4, objects: 5 },
    );
    const byKind = (k: string) => entries.filter((e) => e.kind === k).length;
    expect(byKind('collection')).toBe(1);
    expect(byKind('document')).toBe(3);
    expect(byKind('user')).toBe(4);
    expect(byKind('object')).toBe(5);
    expect(byKind('rtdb-key')).toBe(2);
  });

  it('skips failing sources without throwing (degraded services)', async () => {
    const entries = await buildResourceIndex({
      listRootCollections: () => ['users'],
      listDocumentPaths: async () => {
        throw new Error('worker gone');
      },
      listUsers: async () => {
        throw new Error('no auth');
      },
      listRtdbTopLevelKeys: async () => ['ok'],
    });
    expect(entries.map((e) => e.kind)).toEqual(['collection', 'rtdb-key']);
  });
});

describe('buildResourceIndex: fetch caps (fan-out bounds)', () => {
  it('queries docs for at most `collectionsScanned` collections (all still get collection entries)', async () => {
    const queried: string[] = [];
    const entries = await buildResourceIndex(
      {
        listRootCollections: () => ['a', 'b', 'c', 'd', 'e'],
        listDocumentPaths: async (id) => {
          queried.push(id);
          return [`${id}/x`];
        },
      },
      { collectionsScanned: 2 },
    );
    expect(queried).toEqual(['a', 'b']);
    expect(entries.filter((e) => e.kind === 'collection').length).toBe(5);
    expect(entries.filter((e) => e.kind === 'document').length).toBe(2);
  });
});

describe('bfsStorageObjectPaths', () => {
  type FakeRef = { name: string };
  /** A prefix tree where every folder has one item and two subfolders —
   *  unbounded without the RPC cap. */
  const listAll = async (ref: FakeRef) => ({
    items: [{ fullPath: `${ref.name}/obj` }],
    prefixes: [{ name: `${ref.name}/p1` }, { name: `${ref.name}/p2` }],
  });

  it('stops at maxObjects', async () => {
    let calls = 0;
    const paths = await bfsStorageObjectPaths(
      { name: '' },
      async (r: FakeRef) => {
        calls++;
        return listAll(r);
      },
      { maxObjects: 3, maxListCalls: 100 },
    );
    expect(paths.length).toBe(3);
    expect(calls).toBe(3);
  });

  it('stops at maxListCalls even when few objects matched (deep/wide trees cannot fan out)', async () => {
    let calls = 0;
    const paths = await bfsStorageObjectPaths(
      { name: '' },
      async (r: FakeRef) => {
        calls++;
        return { items: [], prefixes: (await listAll(r)).prefixes };
      },
      { maxObjects: 100, maxListCalls: 5 },
    );
    expect(calls).toBe(5);
    expect(paths).toEqual([]);
  });
});
