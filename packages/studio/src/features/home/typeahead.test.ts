/** Pure typeahead matcher + index builder (specs/home.md command input). */
import { describe, expect, it } from 'bun:test';
import { ROUTES } from '../../shell/routes.js';
import {
  bfsFirestoreSubcollections,
  bfsStorageObjectPaths,
  buildResourceIndex,
  collectionEntry,
  documentEntry,
  drillScore,
  flattenSuggestions,
  fuzzyScore,
  matchTypeahead,
  objectEntry,
  ownIdScore,
  rtdbKeyEntry,
  subcollectionEntry,
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
    // Firestore and rtdb are independent, concurrent tasks now (see
    // `buildResourceIndex`'s doc comment) — their relative arrival order
    // isn't guaranteed, only that both landed and nothing else did.
    expect(entries.map((e) => e.kind).sort()).toEqual(['collection', 'rtdb-key']);
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

describe('drillScore', () => {
  it('completes the last leg when every earlier segment matches exactly', () => {
    expect(drillScore('users/da', 'users/david')).toBeGreaterThan(0);
    expect(drillScore('users/da', 'users/dana')).toBeGreaterThan(0);
  });

  it('rejects a document whose earlier segment differs, even if the tail matches', () => {
    // A plain fuzzyScore would fail this too (no 'd' after 'users/' in
    // "alice"), but drillScore should reject it for the RIGHT reason: the
    // parent segment ("users") is fine here — this case is about a mismatched
    // parent, e.g. completing under the wrong collection.
    expect(drillScore('orders/da', 'users/david')).toBe(0);
  });

  it('lists everything directly under an exact parent on a trailing slash', () => {
    expect(drillScore('users/', 'users/david')).toBeGreaterThan(0);
    expect(drillScore('users/', 'orders/1001')).toBe(0);
  });

  it('drills through a nested subcollection path at every segment', () => {
    expect(drillScore('users/david/orders/or', 'users/david/orders/ord1')).toBeGreaterThan(0);
    expect(drillScore('users/dana/orders/or', 'users/david/orders/ord1')).toBe(0);
  });

  it('returns 0 for a query with no path (nothing to drill into)', () => {
    expect(drillScore('', 'users/david')).toBe(0);
  });
});

describe('ownIdScore', () => {
  it('matches a subcollection by its own trailing id, regardless of parent', () => {
    expect(ownIdScore('users', 'customers/acme/users')).toBeGreaterThan(0);
    expect(ownIdScore('users/', 'customers/acme/users')).toBeGreaterThan(0);
  });

  it('requires an exact own-id match on a trailing slash', () => {
    expect(ownIdScore('user/', 'customers/acme/users')).toBe(0);
  });

  it('does not apply once the query names an explicit parent', () => {
    expect(ownIdScore('customers/acme/us', 'customers/acme/users')).toBe(0);
  });
});

describe('bfsFirestoreSubcollections', () => {
  it('discovers subcollections under known documents and their own documents', async () => {
    const listSubcollections = async (docPath: string) =>
      docPath === 'customers/acme' ? ['users'] : [];
    const listDocumentPaths = async (collectionPath: string) =>
      collectionPath === 'customers/acme/users' ? ['customers/acme/users/dana'] : [];

    const result = await bfsFirestoreSubcollections(
      ['customers/acme'],
      listSubcollections,
      listDocumentPaths,
      { maxSubcollections: 10, maxRpcCalls: 10, docsPerCollection: 10 },
    );
    expect(result.subcollections).toEqual(['customers/acme/users']);
    expect(result.documents).toEqual(['customers/acme/users/dana']);
  });

  it('recurses into documents found in a discovered subcollection', async () => {
    // customers/acme -> users/dana -> orders/or1 (three levels deep).
    const listSubcollections = async (docPath: string) => {
      if (docPath === 'customers/acme') return ['users'];
      if (docPath === 'customers/acme/users/dana') return ['orders'];
      return [];
    };
    const listDocumentPaths = async (collectionPath: string) => {
      if (collectionPath === 'customers/acme/users') return ['customers/acme/users/dana'];
      if (collectionPath === 'customers/acme/users/dana/orders') {
        return ['customers/acme/users/dana/orders/or1'];
      }
      return [];
    };

    const result = await bfsFirestoreSubcollections(
      ['customers/acme'],
      listSubcollections,
      listDocumentPaths,
      { maxSubcollections: 10, maxRpcCalls: 10, docsPerCollection: 10 },
    );
    expect(result.subcollections).toEqual([
      'customers/acme/users',
      'customers/acme/users/dana/orders',
    ]);
    expect(result.documents).toEqual(['customers/acme/users/dana', 'customers/acme/users/dana/orders/or1']);
  });

  it('stops at maxSubcollections', async () => {
    const listSubcollections = async () => ['a', 'b', 'c', 'd'];
    const listDocumentPaths = async () => [];
    const result = await bfsFirestoreSubcollections(
      ['root/doc'],
      listSubcollections,
      listDocumentPaths,
      { maxSubcollections: 2, maxRpcCalls: 100, docsPerCollection: 10 },
    );
    expect(result.subcollections.length).toBe(2);
  });

  it('stops at maxRpcCalls even when few subcollections matched (a deep/wide tree cannot fan out)', async () => {
    let calls = 0;
    // Every document has one subcollection with one document, forever.
    const listSubcollections = async () => {
      calls++;
      return ['child'];
    };
    const listDocumentPaths = async (collectionPath: string) => [`${collectionPath}/d`];
    const result = await bfsFirestoreSubcollections(
      ['root/doc'],
      listSubcollections,
      listDocumentPaths,
      { maxSubcollections: 1000, maxRpcCalls: 5, docsPerCollection: 10 },
    );
    expect(calls).toBe(5);
    expect(result.subcollections.length).toBe(5);
  });

  it('skips a document whose listSubcollections call fails, without throwing', async () => {
    const listSubcollections = async (docPath: string) => {
      if (docPath === 'a') throw new Error('gone');
      return ['ok'];
    };
    const listDocumentPaths = async () => [];
    const result = await bfsFirestoreSubcollections(
      ['a', 'b'],
      listSubcollections,
      listDocumentPaths,
      { maxSubcollections: 10, maxRpcCalls: 10, docsPerCollection: 10 },
    );
    expect(result.subcollections).toEqual(['b/ok']);
  });
});

describe('subcollectionEntry', () => {
  it('labels the full path and targets Firestore with every segment', () => {
    const entry = subcollectionEntry('customers/acme/users');
    expect(entry.kind).toBe('subcollection');
    expect(entry.label).toBe('customers/acme/users');
    expect(entry.alt).toBe('customers/acme');
    expect(entry.target).toEqual({ tab: 'firestore', rest: ['customers', 'acme', 'users'] });
  });
});

describe('matchTypeahead: subcollections and deep-path drilling', () => {
  const TREE: ResourceEntry[] = [
    collectionEntry('users'),
    documentEntry('users/david'),
    documentEntry('users/dana'),
    documentEntry('users/alice'),
    subcollectionEntry('customers/acme/users'),
    documentEntry('customers/acme/users/dana'),
    subcollectionEntry('users/david/orders'),
    documentEntry('users/david/orders/ord1'),
    documentEntry('users/david/orders/ord2'),
  ];

  it('completes a document id under a known collection (users/da -> david, dana)', () => {
    const groups = matchTypeahead('users/da', ROUTES, TREE);
    const documents = groups.find((g) => g.kind === 'document');
    const labels = documents!.results.map((r) => r.label);
    expect(labels).toContain('users/david');
    expect(labels).toContain('users/dana');
    expect(labels).not.toContain('users/alice');
  });

  it('completes a bare collection prefix (use -> users)', () => {
    const groups = matchTypeahead('use', ROUTES, TREE);
    const collections = groups.find((g) => g.kind === 'collection');
    expect(collections!.results.map((r) => r.label)).toEqual(['users']);
  });

  it('surfaces subcollections anywhere in the tree as a collection group (users/)', () => {
    const groups = matchTypeahead('users/', ROUTES, TREE);
    const subcollections = groups.find((g) => g.kind === 'subcollection');
    const found = subcollections!.results.find((r) => r.label === 'customers/acme/users');
    expect(found).toBeDefined();
    expect(found!.hint).toBe('Subcollection of /customers/acme');
  });

  it('surfaces subcollections by bare id too (orders)', () => {
    const groups = matchTypeahead('orders', ROUTES, TREE);
    const subcollections = groups.find((g) => g.kind === 'subcollection');
    expect(subcollections!.results.map((r) => r.label)).toEqual(['users/david/orders']);
  });

  it('completes documents nested inside a subcollection at every segment', () => {
    const groups = matchTypeahead('users/david/orders/or', ROUTES, TREE);
    const documents = groups.find((g) => g.kind === 'document');
    expect(documents!.results.map((r) => r.label).sort()).toEqual([
      'users/david/orders/ord1',
      'users/david/orders/ord2',
    ]);
  });

  it('does not cross-match an unrelated parent (customers/acme/us should never surface users/david)', () => {
    const groups = matchTypeahead('customers/acme/us', ROUTES, TREE);
    const documents = groups.find((g) => g.kind === 'document');
    // The 3-segment query can only align against entries with a matching
    // "customers/acme/…" prefix — `users/david` (a different tree entirely)
    // is rejected outright by the segment-count/exact-prefix check.
    expect(documents?.results.map((r) => r.label) ?? []).not.toContain('users/david');
    const subcollections = groups.find((g) => g.kind === 'subcollection');
    expect(subcollections!.results.map((r) => r.label)).toEqual(['customers/acme/users']);
  });
});

describe('buildResourceIndex: subcollection walk wiring', () => {
  it('indexes subcollections and their documents when both seams are provided', async () => {
    const entries = await buildResourceIndex({
      listRootCollections: () => ['customers'],
      listDocumentPaths: async (collectionPath) => {
        if (collectionPath === 'customers') return ['customers/acme'];
        if (collectionPath === 'customers/acme/users') return ['customers/acme/users/dana'];
        return [];
      },
      listSubcollections: async (docPath) => (docPath === 'customers/acme' ? ['users'] : []),
    });
    const subs = entries.filter((e) => e.kind === 'subcollection').map((e) => e.label);
    const docs = entries.filter((e) => e.kind === 'document').map((e) => e.label);
    expect(subs).toEqual(['customers/acme/users']);
    expect(docs).toEqual(['customers/acme', 'customers/acme/users/dana']);
  });

  it('adds no subcollections when `listSubcollections` is absent (opt-in seam)', async () => {
    const entries = await buildResourceIndex({
      listRootCollections: () => ['users'],
      listDocumentPaths: async () => ['users/david'],
    });
    expect(entries.some((e) => e.kind === 'subcollection')).toBe(false);
  });
});

describe('buildResourceIndex: progressive publication', () => {
  it('emits a batch per source as it resolves, not just once at the end', async () => {
    const batches: string[][] = [];
    await buildResourceIndex(
      {
        listRootCollections: () => ['users'],
        listUsers: async () => [{ uid: 'u1', email: 'u1@x.com' }],
        listRtdbTopLevelKeys: async () => ['a'],
      },
      {},
      (batch) => batches.push(batch.map((e) => e.kind)),
    );
    // At least one batch for collections and one for users/rtdb — never a
    // single batch holding everything (that would defeat the point of a
    // progressive callback: the palette couldn't show anything sooner).
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().sort()).toEqual(['collection', 'rtdb-key', 'user']);
  });

  it('publishes Firestore entries before a slow storage source resolves', async () => {
    const order: string[] = [];
    let releaseStorage!: () => void;
    const storageGate = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });

    const build = buildResourceIndex(
      {
        listRootCollections: () => ['users'],
        listStorageObjectPaths: async (cap) => {
          await storageGate; // resolves only when the test releases it
          return ['uploads/logo.png'].slice(0, cap);
        },
      },
      {},
      (batch) => {
        for (const e of batch) order.push(e.kind);
      },
    );

    // Give the firestore task a microtask/macrotask to land before storage.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['collection']);

    releaseStorage();
    await build;
    expect(order).toEqual(['collection', 'object']);
  });
});
