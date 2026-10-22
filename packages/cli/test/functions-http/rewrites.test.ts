import { describe, expect, test } from 'bun:test';
import { hostingGlob, hostingRewrites, rewriteTarget, sessionCookieOnly } from '../../src/functions/http/rewrites.js';

describe('hostingGlob', () => {
  test('** crosses segments and a trailing /** also matches the bare prefix', () => {
    const api = hostingGlob('/api/**');
    expect(['/api', '/api/', '/api/items', '/api/items/42'].map((path) => api.test(path))).toEqual([true, true, true, true]);
    expect(api.test('/apix')).toBe(false);
    expect(hostingGlob('**').test('/anything/at/all')).toBe(true);
  });

  test('* and ? stay inside one segment, {a,b} alternates, and a missing leading slash is added', () => {
    expect(hostingGlob('/users/*').test('/users/ada')).toBe(true);
    expect(hostingGlob('/users/*').test('/users/ada/posts')).toBe(false);
    expect(hostingGlob('/v?/ping').test('/v1/ping')).toBe(true);
    expect(hostingGlob('/{api,rpc}/**').test('/rpc/call')).toBe(true);
    expect(hostingGlob('api/**').test('/api/x')).toBe(true);
    expect(hostingGlob('/a.b').test('/aXb')).toBe(false);
  });
});

describe('hostingRewrites', () => {
  const rewrites = hostingRewrites({
    hosting: {
      public: 'public',
      rewrites: [
        { source: '/api/**', function: 'api' },
        { source: '/east/**', function: { functionId: 'east', region: 'us-east1' } },
        { source: '/legacy/**', function: 'legacy', region: 'europe-west1' },
        { regex: '^/rx/\\d+$', function: 'byRegex' },
        { source: '**', destination: '/index.html' },
        { source: '/late/**', function: 'unreachable' },
      ],
    },
  });

  test('reads every function destination form, with us-central1 by default', () => {
    expect(rewriteTarget(rewrites, '/api/items')).toEqual({ functionId: 'api', region: 'us-central1' });
    expect(rewriteTarget(rewrites, '/east/x')).toEqual({ functionId: 'east', region: 'us-east1' });
    expect(rewriteTarget(rewrites, '/legacy/x')).toEqual({ functionId: 'legacy', region: 'europe-west1' });
    expect(rewriteTarget(rewrites, '/rx/12')).toEqual({ functionId: 'byRegex', region: 'us-central1' });
  });

  test('the first matching rewrite wins, so a function after a ** destination is never reached', () => {
    expect(rewriteTarget(rewrites, '/late/x')).toBeNull();
    expect(rewriteTarget(rewrites, '/page')).toBeNull();
  });

  test('a multi-site array uses the first site, and no hosting config has no rewrites', () => {
    expect(hostingRewrites({ hosting: [{ rewrites: [{ source: '/a', function: 'a' }] }, { rewrites: [] }] })).toHaveLength(1);
    expect(hostingRewrites({})).toEqual([]);
    expect(hostingRewrites(null)).toEqual([]);
  });
});

describe('sessionCookieOnly', () => {
  test('keeps only __session', () => {
    expect(sessionCookieOnly('a=1; __session=abc; b=2')).toBe('__session=abc');
    expect(sessionCookieOnly('a=1; b=2')).toBeUndefined();
    expect(sessionCookieOnly(undefined)).toBeUndefined();
  });
});
