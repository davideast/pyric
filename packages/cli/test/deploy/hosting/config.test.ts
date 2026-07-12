/**
 * Pure mapping tests for the firebase.json → versions.create config
 * builder. No network. Every REST shape is pinned against
 * firebase-tools' convertConfig
 * (clones/firebase-tools/src/deploy/hosting/convertConfig.ts):
 *
 *   pattern extraction  convertConfig.ts:19-41  (extractPattern)
 *   destination → path  convertConfig.ts:137-141
 *   function → scalar   convertConfig.ts:184-187, 203-207
 *   legacy fn string    clones/firebase-tools/src/hosting/config.ts:262-289 (normalize)
 *   run rewrite         convertConfig.ts:248-260 (region default :252)
 *   dynamicLinks        convertConfig.ts:240-244 (pyric: rejected — sunset)
 *   redirects           convertConfig.ts:279-288
 *   headers array→map   convertConfig.ts:289-299
 *   scalars             convertConfig.ts:301-304 (trailingSlash → trailingSlashBehavior)
 *   REST ServingConfig  clones/firebase-tools/src/hosting/api.ts:128-162
 */
import { describe, expect, test } from 'bun:test';
import { buildVersionConfig } from '../../../src/deploy/hosting/config.js';
import type { HostingJsonConfig } from '../../../src/deploy/hosting/spec.js';

function expectOk(hosting?: HostingJsonConfig) {
  const result = buildVersionConfig(hosting);
  if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
  return result;
}

function expectFail(hosting: HostingJsonConfig) {
  const result = buildVersionConfig(hosting);
  if (result.ok) throw new Error('expected failure, got ok');
  return result;
}

describe('buildVersionConfig — base cases', () => {
  test('returns empty config when hosting is undefined', () => {
    const r = expectOk(undefined);
    expect(r.config).toEqual({});
    expect(r.warnings).toEqual([]);
  });

  test('returns empty config for an empty hosting block', () => {
    const r = expectOk({});
    expect(r.config).toEqual({});
    expect(r.warnings).toEqual([]);
  });
});

describe('buildVersionConfig — rewrites', () => {
  test('maps source → glob and emits scalar function + sibling functionRegion (convertConfig.ts:203-207)', () => {
    const r = expectOk({
      rewrites: [
        { source: '/api/stitch/**', function: { functionId: 'stitchProxy', region: 'us-central1' } },
        { source: '/api/stitch-asset', function: { functionId: 'stitchAsset' } },
      ],
    });
    expect(r.config.rewrites).toEqual([
      { glob: '/api/stitch/**', function: 'stitchProxy', functionRegion: 'us-central1' },
      { glob: '/api/stitch-asset', function: 'stitchAsset' },
    ]);
  });

  test('omits functionRegion when region not provided (matches REST optionality)', () => {
    const r = expectOk({ rewrites: [{ source: '/api/**', function: { functionId: 'api' } }] });
    const entry = r.config.rewrites?.[0];
    expect(entry).toEqual({ glob: '/api/**', function: 'api' });
    expect(entry).not.toHaveProperty('functionRegion');
  });

  test('accepts the `glob` spelling and the `regex` source (extractPattern, convertConfig.ts:19-41)', () => {
    const r = expectOk({
      rewrites: [
        { glob: '/app/**', destination: '/index.html' },
        { regex: '^/u/\\d+$', destination: '/user.html' },
      ],
    });
    expect(r.config.rewrites).toEqual([
      { glob: '/app/**', path: '/index.html' },
      { regex: '^/u/\\d+$', path: '/user.html' },
    ]);
  });

  test('static rewrite: destination → REST `path` (convertConfig.ts:137-141)', () => {
    const r = expectOk({ rewrites: [{ source: '**', destination: '/index.html' }] });
    expect(r.config.rewrites).toEqual([{ glob: '**', path: '/index.html' }]);
  });

  test('legacy string function form normalizes to scalar + functionRegion (hosting/config.ts:262-289)', () => {
    const r = expectOk({
      rewrites: [
        { source: '/api/**', function: 'api', region: 'europe-west1' },
        { source: '/fn/**', function: 'plain' },
      ],
    });
    expect(r.config.rewrites).toEqual([
      { glob: '/api/**', function: 'api', functionRegion: 'europe-west1' },
      { glob: '/fn/**', function: 'plain' },
    ]);
  });

  test('run rewrite: serviceId + region, region defaults to us-central1 (convertConfig.ts:248-260, :252)', () => {
    const r = expectOk({
      rewrites: [
        { source: '/svc/**', run: { serviceId: 'api-svc', region: 'europe-west1' } },
        { source: '/default/**', run: { serviceId: 'plain-svc' } },
      ],
    });
    expect(r.config.rewrites).toEqual([
      { glob: '/svc/**', run: { serviceId: 'api-svc', region: 'europe-west1' } },
      { glob: '/default/**', run: { serviceId: 'plain-svc', region: 'us-central1' } },
    ]);
  });

  test('rejects glob + regex on one rewrite (extractPattern, convertConfig.ts:30-32)', () => {
    const r = expectFail({
      rewrites: [{ glob: '/a/**', regex: '^/a/.*$', destination: '/index.html' } as never],
    });
    expect(r.message).toContain('both a glob and regex');
  });

  test('rejects a rewrite with no pattern (extractPattern, convertConfig.ts:38-40)', () => {
    const r = expectFail({ rewrites: [{ destination: '/index.html' } as never] });
    expect(r.message).toContain('needs a pattern');
  });

  test('rejects a rewrite with no target (convertConfig.ts:263-271)', () => {
    const r = expectFail({ rewrites: [{ source: '/a/**' } as never] });
    expect(r.message).toContain("must specify one of 'destination', 'function' or 'run'");
  });

  test('rejects dynamicLinks rewrites with the sunset reason (upstream shape convertConfig.ts:240-244)', () => {
    const r = expectFail({ rewrites: [{ source: '/l/**', dynamicLinks: true }] });
    expect(r.message).toContain('dynamicLinks');
    expect(r.message).toContain('sunset');
  });

  test('rejects pinTag on function rewrites — deferred to Track C, never silently dropped', () => {
    const r = expectFail({
      rewrites: [{ source: '/api/**', function: { functionId: 'api', pinTag: true } }],
    });
    expect(r.message).toContain('pinTag');
    expect(r.message).toContain('Track C');
  });

  test('rejects pinTag on run rewrites — deferred to Track C, never silently dropped', () => {
    const r = expectFail({
      rewrites: [{ source: '/svc/**', run: { serviceId: 'svc', pinTag: true } }],
    });
    expect(r.message).toContain('pinTag');
  });

  test('rejects a function object missing functionId', () => {
    const r = expectFail({
      rewrites: [{ source: '/api/**', function: { region: 'us-central1' } } as never],
    });
    expect(r.message).toContain('functionId');
  });
});

describe('buildVersionConfig — redirects', () => {
  test('destination → location, type → statusCode (convertConfig.ts:279-288)', () => {
    const r = expectOk({
      redirects: [
        { source: '/old/**', destination: '/new', type: 302 },
        { regex: '^/gone$', destination: 'https://example.com/', type: 301 },
      ],
    });
    expect(r.config.redirects).toEqual([
      { glob: '/old/**', location: '/new', statusCode: 302 },
      { regex: '^/gone$', location: 'https://example.com/', statusCode: 301 },
    ]);
  });

  test('omits statusCode when type absent — Hosting serves 301 by default (convertConfig.ts:284-286)', () => {
    const r = expectOk({ redirects: [{ source: '/old', destination: '/new' }] });
    expect(r.config.redirects).toEqual([{ glob: '/old', location: '/new' }]);
    expect(r.config.redirects?.[0]).not.toHaveProperty('statusCode');
  });

  test('rejects a redirect missing destination', () => {
    const r = expectFail({ redirects: [{ source: '/old' } as never] });
    expect(r.message).toContain('destination');
  });
});

describe('buildVersionConfig — headers', () => {
  test('firebase.json {key,value} array → REST headers MAP (convertConfig.ts:289-299)', () => {
    const r = expectOk({
      headers: [
        {
          source: '**/*.@(js|css)',
          headers: [
            { key: 'Cache-Control', value: 'max-age=604800' },
            { key: 'X-Frame-Options', value: 'DENY' },
          ],
        },
      ],
    });
    expect(r.config.headers).toEqual([
      {
        glob: '**/*.@(js|css)',
        headers: { 'Cache-Control': 'max-age=604800', 'X-Frame-Options': 'DENY' },
      },
    ]);
  });

  test('rejects a malformed header entry', () => {
    const r = expectFail({
      headers: [{ source: '**', headers: [{ key: 'X', value: 5 }] } as never],
    });
    expect(r.message).toContain('headers[0]');
  });
});

describe('buildVersionConfig — scalars', () => {
  test('cleanUrls / appAssociation / i18n pass through; trailingSlash → trailingSlashBehavior (convertConfig.ts:301-304, api.ts:154-161)', () => {
    const r = expectOk({
      cleanUrls: true,
      trailingSlash: true,
      appAssociation: 'NONE',
      i18n: { root: '/localized' },
    });
    expect(r.config).toEqual({
      cleanUrls: true,
      trailingSlashBehavior: 'ADD',
      appAssociation: 'NONE',
      i18n: { root: '/localized' },
    });
  });

  test('trailingSlash: false → REMOVE (convertConfig.ts:302-304)', () => {
    const r = expectOk({ trailingSlash: false });
    expect(r.config).toEqual({ trailingSlashBehavior: 'REMOVE' });
  });

  test('rejects an invalid appAssociation value', () => {
    const r = expectFail({ appAssociation: 'SOMETIMES' as never });
    expect(r.message).toContain('appAssociation');
  });
});

describe('buildVersionConfig — unknown keys warn loudly, never silently drop', () => {
  test('unknown keys produce a warning naming the key', () => {
    const r = expectOk({ cleanUrls: true, sparkles: true } as HostingJsonConfig);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("'sparkles'");
    expect(r.config).toEqual({ cleanUrls: true });
  });

  test('deploy-layer keys (public/site/target/ignore) warn with a pointer to the right input', () => {
    const r = expectOk({
      public: 'dist',
      site: 'my-site',
      target: 'web',
      ignore: ['firebase.json'],
    } as HostingJsonConfig);
    expect(r.warnings.length).toBe(4);
    expect(r.warnings.join('\n')).toContain('localDir');
    expect(r.warnings.join('\n')).toContain('siteId');
    expect(r.warnings.join('\n')).toContain('ignore');
  });

  test('predeploy/postdeploy hooks and frameworksBackend warn as unsupported', () => {
    const r = expectOk({
      predeploy: ['npm run build'],
      frameworksBackend: { region: 'us-central1' },
    } as HostingJsonConfig);
    expect(r.warnings.join('\n')).toContain('predeploy');
    expect(r.warnings.join('\n')).toContain('frameworksBackend');
  });
});
