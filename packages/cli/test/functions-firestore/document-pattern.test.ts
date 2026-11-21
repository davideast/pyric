import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  firestoreDocumentPathParts,
  isConcreteFirestoreDocumentPath,
  matchFirestoreDocument,
  normalizeFirestoreDocumentPath,
  parseFirestoreDocumentPattern,
  supportsFirestoreDocumentPattern,
} from '../../src/functions/firestore/document-pattern.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const { PathPattern } = requireFromConformance(
  './node_modules/firebase-functions/lib/common/utilities/path-pattern.js',
) as {
  PathPattern: new (raw: string) => {
    hasWildcards(): boolean;
    extractMatches(path: string): Record<string, string>;
  };
};

describe('normalizeFirestoreDocumentPath', () => {
  test('strips leading and trailing slashes and collapses repeated slashes', () => {
    expect(normalizeFirestoreDocumentPath('/users//alice/orders/o1/')).toBe(
      'users/alice/orders/o1',
    );
    expect(normalizeFirestoreDocumentPath('')).toBe('');
    expect(normalizeFirestoreDocumentPath('///')).toBe('');
    expect(firestoreDocumentPathParts('/users/alice/')).toEqual(['users', 'alice']);
    expect(firestoreDocumentPathParts('/')).toEqual([]);
  });
});

describe('isConcreteFirestoreDocumentPath', () => {
  test('accepts even-depth document paths and rejects odd collection or relative segments', () => {
    expect(isConcreteFirestoreDocumentPath('users/alice')).toBe(true);
    expect(isConcreteFirestoreDocumentPath('/users/alice/orders/ord-1/')).toBe(true);
    expect(isConcreteFirestoreDocumentPath('users')).toBe(false);
    expect(isConcreteFirestoreDocumentPath('users/alice/orders')).toBe(false);
    expect(isConcreteFirestoreDocumentPath('users/.')).toBe(false);
    expect(isConcreteFirestoreDocumentPath('users/..')).toBe(false);
    expect(isConcreteFirestoreDocumentPath('')).toBe(false);
  });
});

describe('parseFirestoreDocumentPattern and supportsFirestoreDocumentPattern', () => {
  test('classifies literal patterns without wildcards matching firebase-functions PathPattern', () => {
    const parsed = parseFirestoreDocumentPattern('/config/singleton/');
    const upstream = new PathPattern('config/singleton');
    expect(parsed).toEqual({
      normalized: 'config/singleton',
      segments: [
        { kind: 'literal', value: 'config' },
        { kind: 'literal', value: 'singleton' },
      ],
      hasWildcards: false,
      hasMultiSegmentWildcard: false,
    });
    expect(parsed?.hasWildcards).toBe(upstream.hasWildcards());
  });

  test('parses single-segment captures, explicit =* captures, and anonymous * wildcards', () => {
    const parsed = parseFirestoreDocumentPattern(
      'orgs/{org_1}/teams/*/members/{memberId=*}',
    );
    const upstream = new PathPattern('orgs/{org_1}/teams/*/members/{memberId=*}');
    expect(parsed).toEqual({
      normalized: 'orgs/{org_1}/teams/*/members/{memberId=*}',
      segments: [
        { kind: 'literal', value: 'orgs' },
        { kind: 'single-capture', param: 'org_1' },
        { kind: 'literal', value: 'teams' },
        { kind: 'single-wildcard' },
        { kind: 'literal', value: 'members' },
        { kind: 'single-capture', param: 'memberId' },
      ],
      hasWildcards: true,
      hasMultiSegmentWildcard: false,
    });
    expect(parsed?.hasWildcards).toBe(upstream.hasWildcards());
    expect(supportsFirestoreDocumentPattern('{_col}/{123}')).toBe(true);
  });

  test('parses multi-segment wildcards ** and {param=**}', () => {
    const captureMulti = parseFirestoreDocumentPattern('users/{rest=**}');
    expect(captureMulti?.hasWildcards).toBe(true);
    expect(captureMulti?.hasMultiSegmentWildcard).toBe(true);
    expect(supportsFirestoreDocumentPattern('{path=**}')).toBe(true);
    expect(supportsFirestoreDocumentPattern('orgs/{orgId}/**/items/{itemId}')).toBe(true);
  });

  test('rejects collection paths, duplicate captures, multiple ** wildcards, and partial globs', () => {
    const invalidPatterns = [
      '',
      '/',
      'users',
      'users/{userId}/orders',
      'users/{id}/orders/{id}',
      'orgs/**/teams/**',
      'orgs/{a=**}/teams/{b=**}',
      'users/prefix-*',
      'users/pre{id}',
      'users/{id}post',
      'users/{id=prefix/*}',
      'users/{}',
      'users/{unclosed',
      'users/unopened}',
      'users/{a/b}',
      'users/..',
    ];
    for (const pattern of invalidPatterns) {
      expect(supportsFirestoreDocumentPattern(pattern)).toBe(false);
    }
  });
});

describe('matchFirestoreDocument', () => {
  test('matches nested single-segment captures and URL-decodes captured values identically to PathPattern', () => {
    const pattern = 'users/{userId}/orders/{orderId}';
    const upstream = new PathPattern(pattern);

    const plainMatch = matchFirestoreDocument(pattern, 'users/alice/orders/ord-42');
    expect(plainMatch).toEqual({ userId: 'alice', orderId: 'ord-42' });
    expect(plainMatch).toEqual(upstream.extractMatches('users/alice/orders/ord-42'));

    const encodedDoc = 'users/user%2Fwith%3Aslash/orders/ord%201';
    const encodedMatch = matchFirestoreDocument(pattern, encodedDoc);
    expect(encodedMatch).toEqual({ userId: 'user/with:slash', orderId: 'ord 1' });
    expect(encodedMatch).toEqual(upstream.extractMatches(encodedDoc));

    const malformedPercent = 'users/bad%ZZescape/orders/ord-1';
    expect(matchFirestoreDocument(pattern, malformedPercent)).toEqual({
      userId: 'bad%ZZescape',
      orderId: 'ord-1',
    });
  });

  test('rejects mismatched literals, wrong segment counts, and odd-segment collection paths', () => {
    expect(matchFirestoreDocument('config/singleton', 'config/singleton')).toEqual({});
    expect(matchFirestoreDocument('config/singleton', 'config/other')).toBeNull();
    expect(
      matchFirestoreDocument('users/{userId}', 'users/alice/orders/ord-1'),
    ).toBeNull();
    expect(
      matchFirestoreDocument('users/{userId}/orders/{orderId}', 'users/alice'),
    ).toBeNull();
    expect(matchFirestoreDocument('users/{rest=**}', 'users/alice/orders')).toBeNull();
  });

  test('matches multi-segment {param=**} and ** patterns across multiple document depths', () => {
    const tailPattern = 'users/{rest=**}';
    const upstreamTail = new PathPattern(tailPattern);

    expect(matchFirestoreDocument(tailPattern, 'users/alice')).toEqual(
      upstreamTail.extractMatches('users/alice'),
    );
    expect(
      matchFirestoreDocument(tailPattern, 'users/alice/orders/ord-1/items/item-9'),
    ).toEqual(upstreamTail.extractMatches('users/alice/orders/ord-1/items/item-9'));

    const midPattern = 'orgs/{orgId}/{subpath=**}/items/{itemId}';
    const upstreamMid = new PathPattern(midPattern);
    const deepDoc = 'orgs/acme/projects/p1/ sprints/s2/items/i7'.replace(' ', '');
    expect(matchFirestoreDocument(midPattern, deepDoc)).toEqual(
      upstreamMid.extractMatches(deepDoc),
    );
    expect(matchFirestoreDocument(midPattern, 'orgs/acme/items/i7')).toBeNull();
    expect(
      matchFirestoreDocument('orgs/{orgId}/**/items/{itemId}', deepDoc),
    ).toEqual({ orgId: 'acme', itemId: 'i7' });
  });
});
