import { describe, expect, it } from 'bun:test';
import {
  coversPattern,
  matchesConcrete,
  overlapsPattern,
  parseResourcePattern,
  renderResourcePattern,
  resourceShapeKey,
  unifyPatterns,
} from '../../../src/sandbox/internal/index.js';

describe('ResourcePattern Slice 1.1: parsing, rendering, shape keys, and concrete matching', () => {
  it('normalizes Firestore headers and resourceId precedence', () => {
    const wildcardDb = parseResourcePattern(
      'firestore',
      '/databases/{database}/documents/orgs/{orgId}/items/{id}',
    );
    expect(wildcardDb).toEqual({
      service: 'firestore',
      resourceId: '(default)',
      segments: [
        { kind: 'lit', text: 'orgs' },
        { kind: 'var', name: 'orgId' },
        { kind: 'lit', text: 'items' },
        { kind: 'var', name: 'id' },
      ],
    });

    const dollarDb = parseResourcePattern(
      'firestore',
      'databases/$database/documents/users/$uid',
    );
    expect(dollarDb.resourceId).toBe('(default)');
    expect(dollarDb.segments).toEqual([
      { kind: 'lit', text: 'users' },
      { kind: 'var', name: 'uid' },
    ]);

    const namedDb = parseResourcePattern(
      'firestore',
      '/databases/analytics-db/documents/orgs/{orgId}/items/{id}',
    );
    expect(namedDb.resourceId).toBe('analytics-db');
    expect(namedDb.segments).toHaveLength(4);

    const explicitOverride = parseResourcePattern(
      'firestore',
      '/databases/{database}/documents/orgs/{orgId}',
      'analytics-db',
    );
    expect(explicitOverride.resourceId).toBe('analytics-db');

    const rootDocHeader = parseResourcePattern('firestore', '/databases/analytics-db/documents');
    expect(rootDocHeader).toEqual({
      service: 'firestore',
      resourceId: 'analytics-db',
      segments: [],
    });
  });

  it('normalizes Storage /b/<bucket>/o and gs://<bucket>/ headers and explicit bucket names', () => {
    const wildcardBucket = parseResourcePattern(
      'storage',
      '/b/{bucket}/o/files/{uid}/{allPaths=**}',
    );
    expect(wildcardBucket).toEqual({
      service: 'storage',
      resourceId: '(default)',
      segments: [
        { kind: 'lit', text: 'files' },
        { kind: 'var', name: 'uid' },
        { kind: 'rest', name: 'allPaths' },
      ],
    });

    const literalBucket = parseResourcePattern(
      'storage',
      'b/alpha.appspot.com/o/files/{uid}/{fileId}',
    );
    expect(literalBucket.resourceId).toBe('alpha.appspot.com');
    expect(literalBucket.segments).toEqual([
      { kind: 'lit', text: 'files' },
      { kind: 'var', name: 'uid' },
      { kind: 'var', name: 'fileId' },
    ]);

    const gsBucket = parseResourcePattern(
      'storage',
      'gs://alpha.appspot.com/files/{uid}/img_{id}.png',
    );
    expect(gsBucket.resourceId).toBe('alpha.appspot.com');
    expect(gsBucket.segments).toEqual([
      { kind: 'lit', text: 'files' },
      { kind: 'var', name: 'uid' },
      { kind: 'var', name: 'id', prefix: 'img_', suffix: '.png' },
    ]);

    const explicitBucket = parseResourcePattern(
      'storage',
      '/b/{bucket}/o/files/{uid}',
      'gs://beta.appspot.com/',
    );
    expect(explicitBucket.resourceId).toBe('beta.appspot.com');
  });

  it('normalizes RTDB paths, instance names, and affixed segment properties without empty keys', () => {
    const defaultRtdb = parseResourcePattern('rtdb', '/users/$uid/items/$itemId/');
    expect(defaultRtdb).toEqual({
      service: 'rtdb',
      resourceId: '(default)',
      segments: [
        { kind: 'lit', text: 'users' },
        { kind: 'var', name: 'uid' },
        { kind: 'lit', text: 'items' },
        { kind: 'var', name: 'itemId' },
      ],
    });

    const urlRtdb = parseResourcePattern(
      'rtdb',
      'https://secondary-rtdb.firebaseio.com/users/$uid',
    );
    expect(urlRtdb.resourceId).toBe('secondary-rtdb');
    expect(urlRtdb.segments).toEqual([
      { kind: 'lit', text: 'users' },
      { kind: 'var', name: 'uid' },
    ]);

    const nsQueryRtdb = parseResourcePattern(
      'rtdb',
      'users/$uid',
      'http://127.0.0.1:9000/?ns=primary-rtdb',
    );
    expect(nsQueryRtdb.resourceId).toBe('primary-rtdb');

    const affixVariants = parseResourcePattern(
      'storage',
      'files/{uid}/doc_{docId}/{fileId}.json',
      'alpha.appspot.com',
    );
    expect(affixVariants.segments).toEqual([
      { kind: 'lit', text: 'files' },
      { kind: 'var', name: 'uid' },
      { kind: 'var', name: 'docId', prefix: 'doc_' },
      { kind: 'var', name: 'fileId', suffix: '.json' },
    ]);
    expect(Object.hasOwn(affixVariants.segments[1]!, 'prefix')).toBe(false);
    expect(Object.hasOwn(affixVariants.segments[1]!, 'suffix')).toBe(false);
    expect(Object.hasOwn(affixVariants.segments[2]!, 'suffix')).toBe(false);
    expect(Object.hasOwn(affixVariants.segments[3]!, 'prefix')).toBe(false);
  });

  it('renders canonical service syntax and collapses variable names in resourceShapeKey', () => {
    const fsPattern = parseResourcePattern(
      'firestore',
      '/databases/analytics-db/documents/orgs/$orgId/items/{autoId}',
    );
    expect(renderResourcePattern(fsPattern)).toBe('orgs/{orgId}/items/{autoId}');

    const fsRenamed = parseResourcePattern(
      'firestore',
      'orgs/{tenant}/items/{itemId}',
      'analytics-db',
    );
    expect(resourceShapeKey(fsPattern)).toBe('firestore:analytics-db:orgs/*/items/*');
    expect(resourceShapeKey(fsRenamed)).toBe(resourceShapeKey(fsPattern));

    const rtdbPattern = parseResourcePattern('rtdb', 'users/{uid}/files/img_{fileId}.png');
    expect(renderResourcePattern(rtdbPattern)).toBe('users/$uid/files/img_{fileId}.png');
    expect(resourceShapeKey(rtdbPattern)).toBe('rtdb:(default):users/*/files/img_*.png');

    const storageRest = parseResourcePattern(
      'storage',
      '/b/alpha.appspot.com/o/files/{uid}/{allPaths=**}',
    );
    expect(renderResourcePattern(storageRest)).toBe('files/{uid}/{allPaths=**}');
    expect(resourceShapeKey(storageRest)).toBe('storage:alpha.appspot.com:files/*/**');
    const mixedSyntax = parseResourcePattern('firestore', '/a/$b/{c}/{d=**}');
    expect(mixedSyntax.segments).toEqual([
      { kind: 'lit', text: 'a' },
      { kind: 'var', name: 'b' },
      { kind: 'var', name: 'c' },
      { kind: 'rest', name: 'd' },
    ]);
    expect(renderResourcePattern(parseResourcePattern('rtdb', 'a/{b}'))).toBe('a/$b');
    expect(resourceShapeKey(parseResourcePattern('firestore', 'a/$b/{c=**}'))).toBe(
      resourceShapeKey(parseResourcePattern('firestore', 'a/{x}/{y=**}')),
    );
  });

  it('matches concrete paths including zero-segment recursive wildcards, affixes, and resourceId isolation', () => {
    const storageRule = parseResourcePattern(
      'storage',
      '/b/{bucket}/o/files/{uid}/{allPaths=**}',
    );
    expect(matchesConcrete(storageRule, 'files/u1')).toBe(true);
    expect(matchesConcrete(storageRule, '/files/u1/')).toBe(true);
    expect(matchesConcrete(storageRule, 'files/u1/a/b.png')).toBe(true);
    expect(matchesConcrete(storageRule, 'files')).toBe(false);
    expect(matchesConcrete(storageRule, 'files//u1')).toBe(false);

    const firestoreRest = parseResourcePattern(
      'firestore',
      '/databases/(default)/documents/orgs/{orgId}/{rest=**}',
    );
    expect(matchesConcrete(firestoreRest, 'orgs/o1')).toBe(true);
    expect(matchesConcrete(firestoreRest, 'orgs/o1/items/i1')).toBe(true);
    expect(matchesConcrete(firestoreRest, 'orgs/o1/items/i1', 'analytics-db')).toBe(false);

    const affixedStorage = parseResourcePattern(
      'storage',
      '/b/alpha.appspot.com/o/files/{uid}/img_{id}.png',
    );
    expect(matchesConcrete(affixedStorage, 'files/u1/img_42.png', 'alpha.appspot.com')).toBe(true);
    expect(matchesConcrete(affixedStorage, 'files/u1/img_.png', 'alpha.appspot.com')).toBe(true);
    expect(matchesConcrete(affixedStorage, 'gs://alpha.appspot.com/files/u1/img_42.png')).toBe(true);
    expect(matchesConcrete(affixedStorage, 'files/u1/img.png', 'alpha.appspot.com')).toBe(false);
    expect(matchesConcrete(affixedStorage, 'files/u1/avatar_42.png', 'alpha.appspot.com')).toBe(false);
    expect(matchesConcrete(affixedStorage, 'files/u1/img_42.png', 'beta.appspot.com')).toBe(false);
    expect(matchesConcrete(affixedStorage, 'files/u1/img_42.png')).toBe(false);
  });

  it('supports $(var) lookup interpolation, RTDB URL wildcards/hosts, header precedence, concrete conflicts, and shape-key * escaping', () => {
    // $(var) path interpolation in Firestore and Storage rules
    const lookupRule = parseResourcePattern(
      'firestore',
      '/databases/$(database)/documents/orgs/$(orgId)/members/$(uid)',
    );
    expect(lookupRule).toEqual({
      service: 'firestore',
      resourceId: '(default)',
      segments: [
        { kind: 'lit', text: 'orgs' },
        { kind: 'var', name: 'orgId' },
        { kind: 'lit', text: 'members' },
        { kind: 'var', name: 'uid' },
      ],
    });
    expect(renderResourcePattern(lookupRule)).toBe('orgs/{orgId}/members/{uid}');

    const storageAffixedLookup = parseResourcePattern(
      'storage',
      'files/$(uid)/img_$(id).png',
      'alpha.appspot.com',
    );
    expect(storageAffixedLookup.segments[2]).toEqual({
      kind: 'var',
      name: 'id',
      prefix: 'img_',
      suffix: '.png',
    });

    // RTDB URL with {var} braces and loopback / IPv4 / IPv6 / 2-label hosts
    const rtdbBraceUrl = parseResourcePattern(
      'rtdb',
      'https://Secondary-RTDB.firebaseio.com/users/{uid}/items/{id}',
    );
    expect(rtdbBraceUrl).toEqual({
      service: 'rtdb',
      resourceId: 'secondary-rtdb',
      segments: [
        { kind: 'lit', text: 'users' },
        { kind: 'var', name: 'uid' },
        { kind: 'lit', text: 'items' },
        { kind: 'var', name: 'id' },
      ],
    });
    expect(parseResourcePattern('rtdb', 'http://localhost:9000/users/$uid').resourceId).toBe('(default)');
    expect(parseResourcePattern('rtdb', 'http://127.0.0.1:9000/users/$uid').resourceId).toBe('(default)');
    expect(parseResourcePattern('rtdb', 'http://[::1]:9000/users/$uid').resourceId).toBe('(default)');
    expect(parseResourcePattern('rtdb', 'https://example.com/users/$uid').resourceId).toBe('(default)');
    expect(parseResourcePattern('rtdb', 'http://localhost:9000/users/$uid?ns=DB1').resourceId).toBe('DB1');
    expect(parseResourcePattern('rtdb', 'users/$uid', 'DEFAULT').resourceId).toBe('(default)');
    expect(parseResourcePattern('rtdb', 'users/$uid', 'Secondary-RTDB').resourceId).toBe('secondary-rtdb');

    // Wildcard explicit resourceIds normalize to (default); concrete header in rawPath wins over fallback resourceId
    expect(parseResourcePattern('storage', 'files/{uid}', 'gs://{bucket}/').resourceId).toBe('(default)');
    expect(parseResourcePattern('firestore', 'orgs/{id}', '{database}').resourceId).toBe('(default)');
    expect(parseResourcePattern('firestore', 'orgs/{id}', '$(database)').resourceId).toBe('(default)');
    expect(
      parseResourcePattern('storage', 'gs://beta.appspot.com/files/{uid}', 'alpha.appspot.com').resourceId,
    ).toBe('beta.appspot.com');

    // matchesConcrete rejects cross-resource header conflicts, malformed/wildcard headers, and interior // behind headers
    const alphaRule = parseResourcePattern('storage', '/b/alpha.appspot.com/o/files/{uid}/{fileId}');
    const defaultStorageRule = parseResourcePattern('storage', '/b/{bucket}/o/files/{uid}/{fileId}');
    const defaultFsRule = parseResourcePattern('firestore', '/databases/(default)/documents/orgs/{orgId}');

    expect(matchesConcrete(alphaRule, 'gs://beta.appspot.com/files/u1/f1', 'alpha.appspot.com')).toBe(false);
    expect(matchesConcrete(alphaRule, '/b/beta.appspot.com/o/files/u1/f1', 'alpha.appspot.com')).toBe(false);
    expect(matchesConcrete(defaultFsRule, '/databases/analytics-db/documents/orgs/o1', '(default)')).toBe(false);
    expect(matchesConcrete(defaultStorageRule, 'gs:///files/u1/f1')).toBe(false);
    expect(matchesConcrete(defaultStorageRule, '/b/{bucket}/o/files/u1/f1')).toBe(false);
    expect(matchesConcrete(alphaRule, 'files/u1/f1', '{bucket}')).toBe(false);
    expect(matchesConcrete(alphaRule, '/b/alpha.appspot.com/o/files//u1/f1')).toBe(false);
    expect(matchesConcrete(alphaRule, 'gs://alpha.appspot.com//files/u1/f1')).toBe(false);
    expect(matchesConcrete(defaultFsRule, '/databases/(default)/documents/orgs//o1')).toBe(false);
    expect(matchesConcrete(rtdbBraceUrl, 'https://secondary-rtdb.firebaseio.com/users//u1/items/i1')).toBe(false);

    // resourceShapeKey escapes literal * and % so literals and wildcards never collide
    const varKey = resourceShapeKey(parseResourcePattern('firestore', 'orgs/{orgId}'));
    const starLitKey = resourceShapeKey(parseResourcePattern('firestore', 'orgs/*'));
    const doubleStarLitKey = resourceShapeKey(parseResourcePattern('firestore', 'orgs/**'));
    const restKey = resourceShapeKey(parseResourcePattern('firestore', 'orgs/{rest=**}'));
    const pctLitKey = resourceShapeKey(parseResourcePattern('firestore', 'orgs/%2A'));
    expect(new Set([varKey, starLitKey, doubleStarLitKey, restKey, pctLitKey]).size).toBe(5);
  });
});

describe('ResourcePattern Slice 1.2: coversPattern, overlapsPattern, and resource isolation', () => {
  it('isolates patterns across distinct services and resourceIds', () => {
    const fsDefault = parseResourcePattern('firestore', 'orgs/{orgId}/items/{id}');
    const fsAnalytics = parseResourcePattern('firestore', 'orgs/{orgId}/items/{id}', 'analytics-db');
    const rtdbDefault = parseResourcePattern('rtdb', 'orgs/$orgId/items/$id');
    const rtdbPrimary = parseResourcePattern('rtdb', 'users/$uid', 'primary-rtdb');
    const rtdbSecondary = parseResourcePattern('rtdb', 'users/$uid', 'secondary-rtdb');
    const storageAlpha = parseResourcePattern('storage', 'files/{uid}/{fileId}', 'alpha.appspot.com');
    const storageBeta = parseResourcePattern('storage', 'files/{uid}/{fileId}', 'beta.appspot.com');

    expect(coversPattern(fsDefault, fsAnalytics)).toBe(false);
    expect(overlapsPattern(fsDefault, fsAnalytics)).toBe(false);

    expect(coversPattern(fsDefault, rtdbDefault)).toBe(false);
    expect(overlapsPattern(fsDefault, rtdbDefault)).toBe(false);

    expect(coversPattern(rtdbPrimary, rtdbSecondary, { cascade: true })).toBe(false);
    expect(overlapsPattern(rtdbPrimary, rtdbSecondary, { cascadeA: true, cascadeB: true })).toBe(false);

    expect(coversPattern(storageAlpha, storageBeta)).toBe(false);
    expect(overlapsPattern(storageAlpha, storageBeta)).toBe(false);
  });

  it('evaluates coversPattern across literals, affixed variables, recursive rest, and RTDB cascade', () => {
    const p = parseResourcePattern;

    // Rule literal only covers an equal target literal, never a target wildcard
    expect(coversPattern(p('firestore', 'orgs/acme'), p('firestore', 'orgs/acme'))).toBe(true);
    expect(coversPattern(p('firestore', 'orgs/acme'), p('firestore', 'orgs/other'))).toBe(false);
    expect(coversPattern(p('firestore', 'orgs/acme'), p('firestore', 'orgs/{orgId}'))).toBe(false);
    expect(coversPattern(p('firestore', 'orgs/acme'), p('firestore', 'orgs/{rest=**}'))).toBe(false);

    // Plain rule var covers literals and plain/affixed vars, but not rest
    expect(coversPattern(p('firestore', 'orgs/{orgId}'), p('firestore', 'orgs/acme'))).toBe(true);
    expect(coversPattern(p('firestore', 'orgs/{orgId}'), p('firestore', 'orgs/{id}'))).toBe(true);
    expect(coversPattern(p('firestore', 'orgs/{orgId}'), p('firestore', 'orgs/org_{id}'))).toBe(true);
    expect(coversPattern(p('firestore', 'orgs/{orgId}'), p('firestore', 'orgs/{rest=**}'))).toBe(false);

    // Affixed rule var coverage
    const imgRule = p('storage', 'files/{uid}/img_{id}.png', 'alpha.appspot.com');
    expect(coversPattern(imgRule, p('storage', 'files/u1/img_42.png', 'alpha.appspot.com'))).toBe(true);
    expect(coversPattern(imgRule, p('storage', 'files/u1/img_.png', 'alpha.appspot.com'))).toBe(true);
    expect(coversPattern(imgRule, p('storage', 'files/u1/img.png', 'alpha.appspot.com'))).toBe(false);
    expect(coversPattern(imgRule, p('storage', 'files/{uid}/img_thumb_{id}.v2.png', 'alpha.appspot.com'))).toBe(true);
    expect(coversPattern(imgRule, p('storage', 'files/{uid}/{fileId}', 'alpha.appspot.com'))).toBe(false);
    expect(coversPattern(imgRule, p('storage', 'files/{uid}/img_{id}.jpg', 'alpha.appspot.com'))).toBe(false);

    // Recursive rest covers 0..N trailing segments including vars and nested rest
    const restRule = p('storage', '/b/alpha.appspot.com/o/files/{uid}/{allPaths=**}');
    expect(coversPattern(restRule, p('storage', 'files/u1', 'alpha.appspot.com'))).toBe(true);
    expect(coversPattern(restRule, p('storage', 'files/{uid}', 'alpha.appspot.com'))).toBe(true);
    expect(coversPattern(restRule, p('storage', 'files/{uid}/{fileId}', 'alpha.appspot.com'))).toBe(true);
    expect(coversPattern(restRule, p('storage', 'files/{uid}/a/b/c.png', 'alpha.appspot.com'))).toBe(true);
    expect(coversPattern(restRule, p('storage', 'files/{uid}/sub/{more=**}', 'alpha.appspot.com'))).toBe(true);
    expect(coversPattern(restRule, p('storage', 'files', 'alpha.appspot.com'))).toBe(false);

    // Rule variable matches literal or variable; client variable never matches rule literal
    expect(coversPattern(p('firestore', 'orgs/{w}/msgs/{m}'), p('firestore', 'orgs/acme/msgs/{id}'))).toBe(true);
    expect(coversPattern(p('firestore', 'orgs/acme/msgs/{m}'), p('firestore', 'orgs/{w}/msgs/{id}'))).toBe(false);
    expect(coversPattern(p('firestore', 'items/{d=**}'), p('firestore', 'items/a/b/c'))).toBe(true);
    expect(coversPattern(p('rtdb', 'tokens/$uid'), p('rtdb', 'tokens/$u/$device'), { cascade: true })).toBe(true);
    expect(coversPattern(p('rtdb', 'tokens/$uid'), p('rtdb', 'tokens/$u/$device'), { cascade: false })).toBe(false);

    // RTDB cascade option
    const rtdbRule = p('rtdb', 'users/$uid', 'primary-rtdb');
    const rtdbChild = p('rtdb', 'users/$uid/items/$itemId', 'primary-rtdb');
    const rtdbRoot = p('rtdb', 'users', 'primary-rtdb');
    expect(coversPattern(rtdbRule, rtdbChild)).toBe(false);
    expect(coversPattern(rtdbRule, rtdbChild, { cascade: true })).toBe(true);
    expect(coversPattern(rtdbChild, rtdbRule, { cascade: true })).toBe(false);
    expect(coversPattern(rtdbRule, rtdbRoot, { cascade: true })).toBe(false);
  });

  it('evaluates symmetric overlapsPattern across affixes, recursive rest, and directional cascade', () => {
    const p = parseResourcePattern;

    const pairs: Array<{
      readonly a: ReturnType<typeof p>;
      readonly b: ReturnType<typeof p>;
      readonly cascadeA?: boolean;
      readonly cascadeB?: boolean;
      readonly expected: boolean;
    }> = [
      { a: p('firestore', 'orgs/acme/items/{id}'), b: p('firestore', 'orgs/{orgId}/items/i1'), expected: true },
      { a: p('firestore', 'orgs/acme/items/{id}'), b: p('firestore', 'orgs/other/items/{id}'), expected: false },
      { a: p('storage', 'files/{uid}/img_{a}.png', 'alpha.appspot.com'), b: p('storage', 'files/{uid}/img_thumb_{b}.png', 'alpha.appspot.com'), expected: true },
      { a: p('storage', 'files/{uid}/img_{a}', 'alpha.appspot.com'), b: p('storage', 'files/{uid}/{b}.png', 'alpha.appspot.com'), expected: true },
      { a: p('storage', 'files/{uid}/img_{a}.png', 'alpha.appspot.com'), b: p('storage', 'files/{uid}/avatar_{b}.png', 'alpha.appspot.com'), expected: false },
      { a: p('storage', 'files/{uid}/img_{a}.png', 'alpha.appspot.com'), b: p('storage', 'files/{uid}/img_{b}.jpg', 'alpha.appspot.com'), expected: false },
      { a: p('storage', 'files/{uid}/{allPaths=**}', 'alpha.appspot.com'), b: p('storage', 'files/u1', 'alpha.appspot.com'), expected: true },
      { a: p('firestore', '{prefix=**}/items'), b: p('firestore', 'orgs/{orgId}/{suffix=**}'), expected: true },
      { a: p('firestore', '{prefix=**}/items'), b: p('firestore', '{other=**}/members'), expected: false },
      { a: p('rtdb', 'users/$uid', 'primary-rtdb'), b: p('rtdb', 'users/u1/items/i1', 'primary-rtdb'), cascadeA: false, cascadeB: false, expected: false },
      { a: p('rtdb', 'users/$uid', 'primary-rtdb'), b: p('rtdb', 'users/u1/items/i1', 'primary-rtdb'), cascadeA: true, cascadeB: false, expected: true },
    ];

    for (const entry of pairs) {
      const forward = overlapsPattern(entry.a, entry.b, { cascadeA: entry.cascadeA, cascadeB: entry.cascadeB });
      const reverse = overlapsPattern(entry.b, entry.a, { cascadeA: entry.cascadeB, cascadeB: entry.cascadeA });
      expect(forward).toBe(entry.expected);
      expect(reverse).toBe(entry.expected);
    }
  });
});

describe('ResourcePattern Slice 1.3: unifyPatterns variable bindings and invariants', () => {
  it('rejects cross-service, cross-resource, and client-wildcard-against-rule-literal collisions', () => {
    const p = parseResourcePattern;
    expect(unifyPatterns(p('firestore', 'orgs/{orgId}/items/{id}'), p('rtdb', 'orgs/acme/items/i1'))).toBeNull();
    expect(unifyPatterns(p('storage', 'files/{uid}/{fileId}', 'alpha.appspot.com'), p('storage', 'files/u1/f1', 'beta.appspot.com'))).toBeNull();
    expect(unifyPatterns(p('firestore', 'orgs/acme/items/{id}'), p('firestore', 'orgs/{orgId}/items/i1'))).toBeNull();
    expect(unifyPatterns(p('firestore', 'orgs/acme/items/{id}'), p('firestore', 'orgs/{rest=**}'))).toBeNull();
  });

  it('binds plain, affixed, and recursive rest segments and honors RTDB cascade', () => {
    const p = parseResourcePattern;

    const plainLit = unifyPatterns(p('firestore', 'orgs/{orgId}/items/{id}'), p('firestore', 'orgs/acme/items/i1'));
    expect(plainLit).not.toBeNull();
    expect(Array.from(plainLit!.entries())).toEqual([
      ['orgId', { kind: 'lit', text: 'acme' }],
      ['id', { kind: 'lit', text: 'i1' }],
    ]);

    const plainVar = unifyPatterns(p('firestore', 'orgs/{orgId}/items/{id}'), p('firestore', 'orgs/{tenant}/items/{itemKey}'));
    expect(Array.from(plainVar!.entries())).toEqual([
      ['orgId', { kind: 'var', name: 'tenant' }],
      ['id', { kind: 'var', name: 'itemKey' }],
    ]);

    const affixedRule = p('storage', 'files/{uid}/img_{id}.png', 'alpha.appspot.com');
    const affixedLit = unifyPatterns(affixedRule, p('storage', 'files/u1/img_42.png', 'alpha.appspot.com'));
    expect(Array.from(affixedLit!.entries())).toEqual([
      ['uid', { kind: 'lit', text: 'u1' }],
      ['id', { kind: 'lit', text: '42' }],
    ]);

    const affixedNarrowVar = unifyPatterns(affixedRule, p('storage', 'files/{callerUid}/img_thumb_{photoId}.png', 'alpha.appspot.com'));
    expect(Array.from(affixedNarrowVar!.entries())).toEqual([
      ['uid', { kind: 'var', name: 'callerUid' }],
      ['id', { kind: 'var', name: 'photoId', prefix: 'thumb_' }],
    ]);

    expect(unifyPatterns(affixedRule, p('storage', 'files/u1/avatar_42.png', 'alpha.appspot.com'))).toBeNull();
    expect(unifyPatterns(affixedRule, p('storage', 'files/u1/{anyFile}', 'alpha.appspot.com'))).toBeNull();

    const restRule = p('storage', '/b/alpha.appspot.com/o/files/{uid}/{allPaths=**}');
    expect(Array.from(unifyPatterns(restRule, p('storage', 'files/u1', 'alpha.appspot.com'))!.entries())).toEqual([
      ['uid', { kind: 'lit', text: 'u1' }],
      ['allPaths', { kind: 'lit', text: '' }],
    ]);
    expect(Array.from(unifyPatterns(restRule, p('storage', 'files/u1/a/b.png', 'alpha.appspot.com'))!.entries())).toEqual([
      ['uid', { kind: 'lit', text: 'u1' }],
      ['allPaths', { kind: 'lit', text: 'a/b.png' }],
    ]);
    expect(Array.from(unifyPatterns(restRule, p('storage', 'files/{callerUid}/{fileId}', 'alpha.appspot.com'))!.entries())).toEqual([
      ['uid', { kind: 'var', name: 'callerUid' }],
      ['allPaths', { kind: 'var', name: 'fileId' }],
    ]);
    expect(Array.from(unifyPatterns(restRule, p('storage', 'files/{callerUid}/{sub=**}', 'alpha.appspot.com'))!.entries())).toEqual([
      ['uid', { kind: 'var', name: 'callerUid' }],
      ['allPaths', { kind: 'rest', name: 'sub' }],
    ]);
    expect(Array.from(unifyPatterns(restRule, p('storage', 'files/{callerUid}/avatars/{photoId}.png', 'alpha.appspot.com'))!.entries())).toEqual([
      ['uid', { kind: 'var', name: 'callerUid' }],
      ['allPaths', { kind: 'var', name: 'photoId', prefix: 'avatars/', suffix: '.png' }],
    ]);

    const prefixRestRule = p('firestore', '{scope=**}/items/{id}');
    expect(Array.from(unifyPatterns(prefixRestRule, p('firestore', 'orgs/acme/projects/p1/items/i1'))!.entries())).toEqual([
      ['scope', { kind: 'lit', text: 'orgs/acme/projects/p1' }],
      ['id', { kind: 'lit', text: 'i1' }],
    ]);
    expect(unifyPatterns(prefixRestRule, p('firestore', 'orgs/acme/projects/p1/{dynamicCollection}/i1'))).toBeNull();

    const rtdbRule = p('rtdb', 'users/$uid', 'primary-rtdb');
    const rtdbDeepSite = p('rtdb', 'users/u1/items/i1', 'primary-rtdb');
    expect(unifyPatterns(rtdbRule, rtdbDeepSite)).toBeNull();
    expect(Array.from(unifyPatterns(rtdbRule, rtdbDeepSite, { cascade: true })!.entries())).toEqual([
      ['uid', { kind: 'lit', text: 'u1' }],
    ]);
    expect(unifyPatterns(rtdbRule, p('rtdb', 'users', 'primary-rtdb'), { cascade: true })).toBeNull();
  });

  it('applies lexical shadowing when a rule repeats the same variable name across nested segments', () => {
    const p = parseResourcePattern;
    const repeatedRule = p('firestore', 'orgs/{id}/mirrors/{id}');

    expect(Array.from(unifyPatterns(repeatedRule, p('firestore', 'orgs/o1/mirrors/o1'))!.entries())).toEqual([
      ['id', { kind: 'lit', text: 'o1' }],
    ]);
    expect(Array.from(unifyPatterns(repeatedRule, p('firestore', 'orgs/o1/mirrors/o2'))!.entries())).toEqual([
      ['id', { kind: 'lit', text: 'o2' }],
    ]);
    expect(Array.from(unifyPatterns(repeatedRule, p('firestore', 'orgs/{orgId}/mirrors/{orgId}'))!.entries())).toEqual([
      ['id', { kind: 'var', name: 'orgId' }],
    ]);
    expect(Array.from(unifyPatterns(repeatedRule, p('firestore', 'orgs/{orgId}/mirrors/{otherId}'))!.entries())).toEqual([
      ['id', { kind: 'var', name: 'otherId' }],
    ]);
    expect(Array.from(unifyPatterns(repeatedRule, p('firestore', 'orgs/o1/mirrors/{otherId}'))!.entries())).toEqual([
      ['id', { kind: 'var', name: 'otherId' }],
    ]);

    const repeatedRest = p('firestore', 'orgs/{r=**}/sep/{r=**}');
    expect(Array.from(unifyPatterns(repeatedRest, p('firestore', 'orgs/{u}/{v}/sep/{u}/{w}'))!.entries())).toEqual([
      ['r', { kind: 'rest', name: 'u' }],
    ]);
    expect(Array.from(unifyPatterns(repeatedRest, p('firestore', 'orgs/{u}/{v}/sep/tail'))!.entries())).toEqual([
      ['r', { kind: 'lit', text: 'tail' }],
    ]);

    const mixedVarAndRest = p('firestore', 'orgs/{r}/sep/{r=**}');
    expect(Array.from(unifyPatterns(mixedVarAndRest, p('firestore', 'orgs/acme/sep'))!.entries())).toEqual([
      ['r', { kind: 'lit', text: '' }],
    ]);
    expect(Array.from(unifyPatterns(mixedVarAndRest, p('firestore', 'orgs/acme/sep/acme/extra'))!.entries())).toEqual([
      ['r', { kind: 'lit', text: 'acme/extra' }],
    ]);
    expect(Array.from(unifyPatterns(mixedVarAndRest, p('firestore', 'orgs/acme/sep/acme'))!.entries())).toEqual([
      ['r', { kind: 'lit', text: 'acme' }],
    ]);
  });
});
