import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assembleEmulatorPathRewrite,
  translateHostingFunctionRewrites,
  type NextRewriteRule,
} from '../../src/next/hosting-rewrites.js';

const TARGET = 'http://127.0.0.1:4000';

const repoRoot = resolve(import.meta.dir, '../../../..');
const nextPkgDir = resolve(repoRoot, 'examples/nextjs-sandbox-app/node_modules/next');
const hasInstalledNext = existsSync(resolve(nextPkgDir, 'package.json'));

function loadNextRouteHelpers(): {
  checkCustomRoutes: (routes: NextRewriteRule[], type: 'rewrite') => void;
  getPathMatch: (path: string) => (pathname: string) => false | Record<string, string | string[]>;
  prepareDestination: (args: {
    appendParamsToQuery: boolean;
    destination: string;
    params: Record<string, string | string[]>;
    query: Record<string, string>;
  }) => { newUrl: string };
} | null {
  if (!hasInstalledNext) return null;
  const req = createRequire(import.meta.url);
  const { checkCustomRoutes } = req(resolve(nextPkgDir, 'dist/lib/load-custom-routes.js'));
  const { getPathMatch } = req(resolve(nextPkgDir, 'dist/shared/lib/router/utils/path-match.js'));
  const { prepareDestination } = req(resolve(nextPkgDir, 'dist/shared/lib/router/utils/prepare-destination.js'));
  return { checkCustomRoutes, getPathMatch, prepareDestination };
}

describe('translateHostingFunctionRewrites', () => {
  it('translates common firebase.json Hosting function globs and object/region forms', () => {
    const firebaseJson = {
      hosting: {
        public: 'public',
        rewrites: [
          { source: '/hello', function: 'hello' },
          { source: '/api/**', function: 'api' },
          { source: '/east/**', function: { functionId: 'east', region: 'us-east1' } },
          { source: '/legacy/**', function: 'legacy', region: 'europe-west1' },
          { source: '/users/*/posts', function: 'userPosts' },
          { source: '/v?/ping', function: 'versionedPing' },
          { source: '/*.html', function: 'htmlHandler' },
          { source: '/a.b', function: 'dotted' },
        ],
      },
    };

    const result = translateHostingFunctionRewrites(firebaseJson, TARGET);
    expect(result.fallback).toEqual([]);
    expect(result.afterFiles).toEqual([
      { source: '/hello', destination: `${TARGET}/hello`, basePath: false },
      { source: '/api/:path*', destination: `${TARGET}/api/:path*`, basePath: false },
      { source: '/east/:path*', destination: `${TARGET}/east/:path*`, basePath: false },
      { source: '/legacy/:path*', destination: `${TARGET}/legacy/:path*`, basePath: false },
      { source: '/users/:seg0/posts', destination: `${TARGET}/users/:seg0/posts`, basePath: false },
      { source: '/:seg0(v[^/])/ping', destination: `${TARGET}/:seg0/ping`, basePath: false },
      { source: '/:seg0([^/]*\\.html)', destination: `${TARGET}/:seg0`, basePath: false },
      { source: '/a.b', destination: `${TARGET}/a.b`, basePath: false },
    ]);
  });

  it('expands brace expressions and deduplicates redundant prefix rules', () => {
    const firebaseJson = {
      hosting: {
        rewrites: [
          { source: '/api{,/**}', function: 'api' },
          { source: '/{v1,v2}/**', function: 'versioned' },
        ],
      },
    };

    const result = translateHostingFunctionRewrites(firebaseJson, TARGET);
    expect(result.afterFiles).toEqual([
      { source: '/api/:path*', destination: `${TARGET}/api/:path*`, basePath: false },
      { source: '/v1/:path*', destination: `${TARGET}/v1/:path*`, basePath: false },
      { source: '/v2/:path*', destination: `${TARGET}/v2/:path*`, basePath: false },
    ]);
  });

  it('routes catch-all function rewrites (** and catch-all regex) into fallback', () => {
    const firebaseJson = {
      hosting: {
        rewrites: [
          { source: '/api/**', function: 'api' },
          { source: '**', function: 'ssr' },
        ],
      },
    };
    const result = translateHostingFunctionRewrites(firebaseJson, TARGET);
    expect(result.afterFiles).toEqual([
      { source: '/api/:path*', destination: `${TARGET}/api/:path*`, basePath: false },
    ]);
    expect(result.fallback).toEqual([
      { source: '/:path*', destination: `${TARGET}/:path*`, basePath: false },
    ]);

    const regexCatchAll = translateHostingFunctionRewrites(
      { hosting: { rewrites: [{ regex: '^/.*$', function: 'ssr' }] } },
      TARGET,
    );
    expect(regexCatchAll.afterFiles).toEqual([]);
    expect(regexCatchAll.fallback).toEqual([
      { source: '/:path*', destination: `${TARGET}/:path*`, basePath: false },
    ]);
  });

  it('respects Hosting first-match-wins: non-function catch-all shadows later function rewrites', () => {
    const firebaseJson = {
      hosting: {
        rewrites: [
          { source: '/static/**', destination: '/static.html' },
          { source: '/api/**', function: 'api' },
          { source: '**', destination: '/index.html' },
          { source: '/unreachable/**', function: 'late' },
        ],
      },
    };

    const result = translateHostingFunctionRewrites(firebaseJson, TARGET);
    expect(result.afterFiles).toEqual([
      { source: '/api/:path*', destination: `${TARGET}/api/:path*`, basePath: false },
    ]);
    expect(result.fallback).toEqual([]);
  });

  it('translates regex Hosting function rewrites including capturing groups, exact root, and Unicode fallback', () => {
    const firebaseJson = {
      hosting: {
        rewrites: [
          { regex: '^/rx/\\d+$', function: 'byRegex' },
          { regex: '^/api/(v1|v2)/.+$', function: 'versionedApi' },
          { regex: '^/v1/', function: 'v1Prefix' },
          { regex: '^/$', function: 'rootFn' },
          { regex: '^/unicode/\\p{L}+$', function: 'unicodeFn' },
        ],
      },
    };

    const result = translateHostingFunctionRewrites(firebaseJson, TARGET);
    expect(result.afterFiles).toEqual([
      { source: '/:match(rx/\\d+)', destination: `${TARGET}/:match`, basePath: false },
      { source: '/:match(api/(?:v1|v2)/.+)', destination: `${TARGET}/:match`, basePath: false },
      { source: '/:match(v1/.*)', destination: `${TARGET}/:match`, basePath: false },
      { source: '/', destination: `${TARGET}/`, basePath: false },
      { source: '/unicode/:path*', destination: `${TARGET}/unicode/:path*`, basePath: false },
    ]);
  });

  it('skips invalid regexes with a single warning and keeps valid rewrites', () => {
    const warnings: string[] = [];
    const result = translateHostingFunctionRewrites(
      {
        hosting: {
          rewrites: [
            { regex: '(', function: 'broken' },
            { source: 'api/**', function: 'unanchoredNeverMatches' },
            { source: '/ok/**', function: 'ok' },
          ],
        },
      },
      TARGET,
      { onWarning: (msg) => warnings.push(msg) },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('hosting.rewrites[0]');
    expect(result.afterFiles).toEqual([
      { source: '/ok/:path*', destination: `${TARGET}/ok/:path*`, basePath: false },
    ]);
  });

  it('supports multi-site hosting array (first entry) and adds locale: false only when i18n is configured', () => {
    const firebaseJson = {
      hosting: [
        { rewrites: [{ source: '/first/**', function: 'first' }] },
        { rewrites: [{ source: '/second/**', function: 'second' }] },
      ],
    };

    const withI18n = translateHostingFunctionRewrites(firebaseJson, TARGET, { hasI18n: true });
    expect(withI18n.afterFiles).toEqual([
      { source: '/first/:path*', destination: `${TARGET}/first/:path*`, basePath: false, locale: false },
    ]);

    const withoutI18n = translateHostingFunctionRewrites(firebaseJson, TARGET, { hasI18n: false });
    expect(withoutI18n.afterFiles[0]).not.toHaveProperty('locale');
  });

  it('assembles a valid emulator-path rewrite requiring a function name and rejects unsafe project IDs', () => {
    expect(assembleEmulatorPathRewrite('demo-project', TARGET)).toEqual({
      source: '/demo-project/:region([a-z]+-[a-z]+\\d+)/:fn/:path*',
      destination: `${TARGET}/demo-project/:region/:fn/:path*`,
      basePath: false,
    });
    expect(assembleEmulatorPathRewrite('demo-project', TARGET, true)).toEqual({
      source: '/demo-project/:region([a-z]+-[a-z]+\\d+)/:fn/:path*',
      destination: `${TARGET}/demo-project/:region/:fn/:path*`,
      basePath: false,
      locale: false,
    });
    expect(assembleEmulatorPathRewrite('bad/project', TARGET)).toBeNull();
    expect(assembleEmulatorPathRewrite('bad:project', TARGET)).toBeNull();
  });

  it('produces rewrite rules accepted by Next.js router validation and destination compiler, including adversarial regex and glob metacharacters', () => {
    const next = loadNextRouteHelpers();
    if (next === null) return;

    const translated = translateHostingFunctionRewrites(
      {
        hosting: {
          rewrites: [
            { source: '/hello', function: 'hello' },
            { source: '/api/**', function: 'api' },
            { source: '/users/*/posts', function: 'posts' },
            { source: '/v?/ping', function: 'ping' },
            { source: '/*.html', function: 'html' },
            { source: '/v1:beta/**', function: 'colonLiteral' },
            { source: '/api/v(1)/**', function: 'parenLiteral' },
            { regex: '^/rx/\\d+$', function: 'rx' },
            { regex: '^/api/(v1|v2)/.+$', function: 'versioned' },
            { regex: '^/?optapi/.*', function: 'optionalSlash' },
            { regex: '^/items/(?<id>[0-9]+)$', function: 'namedGroup' },
            { regex: '^/bracket/[(]1[)]$', function: 'parenInClass' },
            { regex: '^(?:/alt1|/alt2)/.*$', function: 'leadingAlt' },
            { source: '**', function: 'ssr' },
          ],
        },
      },
      TARGET,
    );
    const emulator = assembleEmulatorPathRewrite('demo-project', TARGET)!;
    const allRules = [emulator, ...translated.afterFiles, ...translated.fallback];

    expect(() => next.checkCustomRoutes(allRules, 'rewrite')).not.toThrow();

    const checkMatch = (rule: NextRewriteRule, pathname: string): string | null => {
      const params = next.getPathMatch(rule.source)(pathname);
      if (!params) return null;
      return next.prepareDestination({
        appendParamsToQuery: false,
        destination: rule.destination,
        params,
        query: {},
      }).newUrl;
    };

    expect(checkMatch(emulator, '/demo-project/us-central1')).toBeNull();
    expect(checkMatch(emulator, '/demo-project/us-central1/greet')).toBe('/demo-project/us-central1/greet');
    expect(checkMatch(emulator, '/demo-project/us-central1/api/items')).toBe('/demo-project/us-central1/api/items');
    expect(checkMatch(emulator, '/demo-project/not-a-region/greet')).toBeNull();

    const matchAnyAfter = (pathname: string): string | null => {
      for (const rule of translated.afterFiles) {
        const hit = checkMatch(rule, pathname);
        if (hit !== null) return hit;
      }
      return null;
    };

    expect(matchAnyAfter('/api/items/42')).toBe('/api/items/42');
    expect(matchAnyAfter('/users/ada/posts')).toBe('/users/ada/posts');
    expect(matchAnyAfter('/v1/ping')).toBe('/v1/ping');
    expect(matchAnyAfter('/index.html')).toBe('/index.html');
    expect(matchAnyAfter('/v1:beta/test')).toBe('/v1:beta/test');
    expect(matchAnyAfter('/api/v(1)/run')).toBe('/api/v(1)/run');
    expect(matchAnyAfter('/rx/99')).toBe('/rx/99');
    expect(matchAnyAfter('/rx/abc')).toBeNull();
    expect(matchAnyAfter('/api/v2/users')).toBe('/api/v2/users');
    expect(matchAnyAfter('/optapi/hello')).toBe('/optapi/hello');
    expect(matchAnyAfter('/items/42')).toBe('/items/42');
    expect(matchAnyAfter('/items/abc')).toBeNull();
    expect(matchAnyAfter('/bracket/(1)')).toBe('/bracket/(1)');
    expect(matchAnyAfter('/alt1/foo')).toBe('/alt1/foo');
    expect(matchAnyAfter('/alt2/bar')).toBe('/alt2/bar');
  });
});
