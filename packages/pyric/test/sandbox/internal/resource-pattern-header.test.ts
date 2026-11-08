import { describe, expect, it } from 'bun:test';
import {
  extractServiceHeader,
  isWildcardToken,
  normalizeExplicitResourceId,
  resolveConcreteResourceId,
  resolvePatternResourceId,
} from '../../../src/sandbox/internal/resource-pattern-header.js';

describe('resource-pattern-header: service headers and resourceId resolution', () => {
  it('recognizes brace, dollar, dollar-paren, and recursive wildcard tokens', () => {
    expect(isWildcardToken('{database}')).toBe(true);
    expect(isWildcardToken('$database')).toBe(true);
    expect(isWildcardToken('$(database)')).toBe(true);
    expect(isWildcardToken('img_$(id).png')).toBe(true);
    expect(isWildcardToken('{allPaths=**}')).toBe(true);

    expect(isWildcardToken('(default)')).toBe(false);
    expect(isWildcardToken('analytics-db')).toBe(false);
    expect(isWildcardToken('alpha.appspot.com')).toBe(false);
    expect(isWildcardToken('$()')).toBe(false);
    expect(isWildcardToken('{}')).toBe(false);
  });

  it('parses RTDB URLs without percent-encoding braces and aligns host/ns rules with instances.ts', () => {
    const braceUrl = extractServiceHeader(
      'rtdb',
      'https://Secondary-RTDB.firebaseio.com/users/{uid}/items/{id}#frag',
    );
    expect(braceUrl).toEqual({
      headerKind: 'concrete',
      headerResourceId: 'secondary-rtdb',
      bodyPath: '/users/{uid}/items/{id}',
    });

    const regionalUrl = extractServiceHeader(
      'rtdb',
      'WSS://My-Instance.Europe-West1.Firebasedatabase.App/users/$uid/a%20b+c',
    );
    expect(regionalUrl).toEqual({
      headerKind: 'concrete',
      headerResourceId: 'my-instance',
      bodyPath: '/users/$uid/a b c',
    });

    // Preserves interior empty segments so concrete matching rejects //
    const doubleSlashUrl = extractServiceHeader(
      'rtdb',
      'https://secondary-rtdb.firebaseio.com/users//u1',
    );
    expect(doubleSlashUrl.headerKind).toBe('concrete');
    expect(doubleSlashUrl.bodyPath).toBe('/users//u1');

    // Case-sensitive ?ns= preserves exact namespace case and overrides host
    expect(extractServiceHeader('rtdb', 'http://localhost:9000/users/$uid?ns=DB1')).toEqual({
      headerKind: 'concrete',
      headerResourceId: 'DB1',
      bodyPath: '/users/$uid',
    });
    expect(extractServiceHeader('rtdb', 'http://localhost:9000/users/$uid?NS=DB1')).toEqual({
      headerKind: 'none',
      bodyPath: '/users/$uid',
    });
    expect(extractServiceHeader('rtdb', 'http://[::1]:9000/users/$uid?ns=primary-rtdb')).toEqual({
      headerKind: 'concrete',
      headerResourceId: 'primary-rtdb',
      bodyPath: '/users/$uid',
    });

    // Loopback, IPv4, IPv6, and <= 2-label hosts without ?ns= carry no concrete headerResourceId
    for (const hostUrl of [
      'http://localhost:9000/users/$uid',
      'http://127.0.0.1:9000/users/$uid',
      'http://[::1]:9000/users/$uid',
      'https://example.com/users/$uid',
    ]) {
      const extracted = extractServiceHeader('rtdb', hostUrl);
      expect(extracted.headerKind).toBe('none');
      expect(extracted.headerResourceId).toBeUndefined();
      expect(extracted.bodyPath).toBe('/users/$uid');
    }

    // Wildcard and malformed RTDB URL headers
    expect(extractServiceHeader('rtdb', 'https://{instance}.firebaseio.com/users/$uid')).toEqual({
      headerKind: 'wildcard',
      bodyPath: '/users/$uid',
    });
    expect(extractServiceHeader('rtdb', 'https://secondary-rtdb.firebaseio.com/users/u1?ns=')).toEqual({
      headerKind: 'malformed',
      bodyPath: '/users/u1',
    });
  });

  it('classifies Firestore and Storage concrete, wildcard, and malformed headers while preserving raw //', () => {
    expect(
      extractServiceHeader('firestore', '/databases/analytics-db/documents/orgs//o1'),
    ).toEqual({
      headerKind: 'concrete',
      headerResourceId: 'analytics-db',
      bodyPath: '/orgs//o1',
    });

    expect(
      extractServiceHeader('firestore', '/databases/$(database)/documents/teams/$(teamId)'),
    ).toEqual({
      headerKind: 'wildcard',
      bodyPath: '/teams/$(teamId)',
    });

    expect(extractServiceHeader('firestore', '/databases//documents/orgs/o1').headerKind).toBe(
      'malformed',
    );
    expect(
      extractServiceHeader('firestore', '/databases/analytics-db//documents/orgs/o1').headerKind,
    ).toBe('malformed');

    expect(
      extractServiceHeader('storage', '/b/alpha.appspot.com/o/files//u1/f1'),
    ).toEqual({
      headerKind: 'concrete',
      headerResourceId: 'alpha.appspot.com',
      bodyPath: '/files//u1/f1',
    });

    expect(extractServiceHeader('storage', 'gs://alpha.appspot.com/files//u1')).toEqual({
      headerKind: 'concrete',
      headerResourceId: 'alpha.appspot.com',
      bodyPath: '/files//u1',
    });

    expect(extractServiceHeader('storage', 'gs://{bucket}/files/{uid}')).toEqual({
      headerKind: 'wildcard',
      bodyPath: '/files/{uid}',
    });

    expect(extractServiceHeader('storage', 'gs:///files/u1').headerKind).toBe('malformed');
    expect(extractServiceHeader('storage', '/b//o/files/u1').headerKind).toBe('malformed');
    expect(extractServiceHeader('storage', '/b/alpha.appspot.com//o/files/u1').headerKind).toBe(
      'malformed',
    );
  });

  it('normalizes explicit resourceIds and distinguishes pattern vs concrete resolution', () => {
    expect(normalizeExplicitResourceId('storage', 'gs://{bucket}/')).toBeUndefined();
    expect(normalizeExplicitResourceId('firestore', '{database}')).toBeUndefined();
    expect(normalizeExplicitResourceId('firestore', '$(database)')).toBeUndefined();

    expect(normalizeExplicitResourceId('rtdb', 'default')).toBe('(default)');
    expect(normalizeExplicitResourceId('rtdb', '  DEFAULT  ')).toBe('(default)');
    expect(normalizeExplicitResourceId('rtdb', '(default)')).toBe('(default)');
    expect(normalizeExplicitResourceId('rtdb', 'Secondary-RTDB')).toBe('secondary-rtdb');
    expect(normalizeExplicitResourceId('rtdb', 'My-Instance.firebaseio.com')).toBe('my-instance');
    expect(normalizeExplicitResourceId('rtdb', 'http://localhost:9000')).toBe('(default)');
    expect(normalizeExplicitResourceId('rtdb', 'http://localhost:9000/?ns=DB1')).toBe('DB1');

    // Pattern resolution: concrete header in rawPath wins over fallback resourceId
    const betaHeader = extractServiceHeader('storage', 'gs://beta.appspot.com/files/{uid}');
    expect(resolvePatternResourceId('storage', 'alpha.appspot.com', betaHeader)).toBe(
      'beta.appspot.com',
    );

    // Concrete resolution: conflicting concrete header and explicit resourceId returns null
    expect(resolveConcreteResourceId('storage', 'alpha.appspot.com', betaHeader)).toBeNull();
    expect(resolveConcreteResourceId('storage', '{bucket}', betaHeader)).toBeNull();
  });
});
