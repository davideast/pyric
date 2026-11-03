/**
 * The places a server-side Google access token comes from (ADR-0022,
 * decision 2), which are the only destinations the network guard refuses.
 *
 * The last suite reads the auth libraries installed in this workspace
 * (google-auth-library 10 and 9, gtoken, gcp-metadata 8 and 6, as
 * firebase-admin and its Firestore client load them) and fails when one of
 * them names a token URL the list doesn't refuse. That is how the next
 * library release that adds a token endpoint shows up.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import {
  STATIC_TOKEN_ENDPOINTS,
  TOKEN_HOSTS,
  matchTokenEndpoint,
  tokenEndpoints,
} from '../src/google-token-endpoints.js';

const refuses = (host: string, path?: string): boolean =>
  matchTokenEndpoint(STATIC_TOKEN_ENDPOINTS, host, path) !== undefined;

describe('TOKEN_HOSTS', () => {
  it('is exactly the token hosts decision 2 names', () => {
    expect(TOKEN_HOSTS.map((entry) => entry.host).sort()).toEqual(
      [
        '169.254.169.254',
        'fd20:ce::254',
        'iamcredentials.googleapis.com',
        'metadata',
        'metadata.google.internal',
        'oauth2.googleapis.com',
        'sts.googleapis.com',
      ].sort(),
    );
    for (const entry of TOKEN_HOSTS) expect(entry.service.length).toBeGreaterThan(0);
  });
});

describe('matchTokenEndpoint on the static list', () => {
  it('refuses every token host, with or without a path', () => {
    for (const host of [
      'oauth2.googleapis.com',
      'sts.googleapis.com',
      'iamcredentials.googleapis.com',
      'metadata.google.internal',
      'metadata.google.internal.',
      'METADATA',
      'metadata',
    ]) {
      expect({ host, refused: refuses(host) }).toEqual({ host, refused: true });
      expect({ host, refused: refuses(host, '/anything') }).toEqual({ host, refused: true });
    }
  });

  it('refuses the metadata server however its address is written', () => {
    for (const host of [
      '169.254.169.254',
      '2852039166',
      '0xa9fea9fe',
      '169.254.43518',
      '0251.0376.0251.0376',
      '::ffff:169.254.169.254',
      '[::ffff:a9fe:a9fe]',
      'fd20:ce::254',
      '[fd20:ce::254]',
      'fd20:00ce:0000:0000:0000:0000:0000:0254',
      'FD20:CE:0:0:0:0:0:254',
    ]) {
      expect({ host, refused: refuses(host) }).toEqual({ host, refused: true });
    }
  });

  it('names the host it matched and the service behind it', () => {
    expect(matchTokenEndpoint(STATIC_TOKEN_ENDPOINTS, '0xa9fea9fe')).toEqual({
      host: '169.254.169.254',
      endpoint: '169.254.169.254',
      service: 'GCE metadata server',
    });
  });

  it('refuses only the token paths on www.googleapis.com', () => {
    expect(refuses('www.googleapis.com', '/oauth2/v4/token')).toBe(true);
    expect(refuses('www.googleapis.com', '/oauth2/v3/token')).toBe(true);
    expect(refuses('www.googleapis.com', '/oauth2/v4/token?grant_type=x')).toBe(true);
    expect(refuses('www.googleapis.com', '/oauth2/v4/token/')).toBe(true);
    expect(refuses('WWW.googleapis.com.', '/OAuth2/V4/Token')).toBe(true);
    expect(refuses('www.googleapis.com', '/oauth2/v4/%74oken')).toBe(true);
    expect(refuses('www.googleapis.com', '//oauth2//v4/token')).toBe(true);
    expect(refuses('www.googleapis.com', '/a/../oauth2/v4/token')).toBe(true);

    expect(refuses('www.googleapis.com')).toBe(false);
    expect(refuses('www.googleapis.com', '/oauth2/v1/certs')).toBe(false);
    expect(refuses('www.googleapis.com', '/oauth2/v3/certs')).toBe(false);
    expect(refuses('www.googleapis.com', '/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com')).toBe(false);
    expect(refuses('www.googleapis.com', '/drive/v3/files')).toBe(false);
    expect(refuses('fonts.googleapis.com', '/oauth2/v4/token')).toBe(false);
  });

  it('lets Firebase data hosts, Fonts, Cloud Run and the Auth SDK hosts through', () => {
    for (const host of [
      'firestore.googleapis.com',
      'identitytoolkit.googleapis.com',
      'securetoken.googleapis.com',
      'firebasestorage.googleapis.com',
      'demo-default-rtdb.firebaseio.com',
      'firebasevertexai.googleapis.com',
      'content-firebaseappcheck.googleapis.com',
      'fonts.googleapis.com',
      'fonts.gstatic.com',
      'my-service-abc123-uc.a.run.app',
      'firebaserules.googleapis.com',
      '127.0.0.1',
      'localhost',
    ]) {
      expect({ host, refused: refuses(host, '/v1/token') }).toEqual({ host, refused: false });
    }
  });

  it('leaves the destinations decision 2 keeps off the list', () => {
    expect(refuses('accounts.google.com', '/o/oauth2/v2/auth')).toBe(false);
    expect(refuses('accounts.google.com', '/o/oauth2/revoke')).toBe(false);
    expect(refuses('fd00:ec2::254')).toBe(false);
    expect(refuses('sts.us-east-1.amazonaws.com')).toBe(false);
  });

  it('matches whole labels only', () => {
    expect(refuses('notoauth2.googleapis.com')).toBe(false);
    expect(refuses('oauth2.googleapis.com.example.com')).toBe(false);
    expect(refuses('metadata.example.com')).toBe(false);
    expect(refuses('')).toBe(false);
  });
});

describe('tokenEndpoints from the environment', () => {
  const noFile = (): string => {
    throw new Error('no file');
  };

  it('adds the hosts GCE_METADATA_HOST and GCE_METADATA_IP name, port or not', () => {
    const endpoints = tokenEndpoints({
      env: { GCE_METADATA_HOST: 'metadata.corp.example:8080', GCE_METADATA_IP: '10.0.0.7' },
      readFile: noFile,
    });
    expect(matchTokenEndpoint(endpoints, 'metadata.corp.example')).toBeDefined();
    expect(matchTokenEndpoint(endpoints, '10.0.0.7')).toBeDefined();
    expect(matchTokenEndpoint(endpoints, '169.254.169.254')).toBeDefined();
    expect(matchTokenEndpoint(STATIC_TOKEN_ENDPOINTS, '10.0.0.7')).toBeUndefined();
  });

  it('reads a bracketed IPv6 or URL-shaped metadata host', () => {
    const endpoints = tokenEndpoints({
      env: { GCE_METADATA_HOST: '[fd00::7]:80', GCE_METADATA_IP: 'http://192.0.2.9' },
      readFile: noFile,
    });
    expect(matchTokenEndpoint(endpoints, 'fd00::7')).toBeDefined();
    expect(matchTokenEndpoint(endpoints, '192.0.2.9')).toBeDefined();
  });

  it('adds the hosts the GOOGLE_APPLICATION_CREDENTIALS file redirects the exchange to', () => {
    const files: Record<string, string> = {
      '/creds/external.json': JSON.stringify({
        type: 'external_account',
        token_url: 'https://sts.corp.example/v1/token',
        service_account_impersonation_url: 'https://iam.corp.example/v1/sa:generateAccessToken',
        universe_domain: 'cloud.example',
      }),
    };
    const endpoints = tokenEndpoints({
      env: { GOOGLE_APPLICATION_CREDENTIALS: '/creds/external.json' },
      readFile: (path) => files[path] ?? noFile(),
    });
    for (const host of ['sts.corp.example', 'iam.corp.example', 'sts.cloud.example', 'iamcredentials.cloud.example']) {
      expect({ host, refused: matchTokenEndpoint(endpoints, host) !== undefined }).toEqual({ host, refused: true });
    }
    expect(matchTokenEndpoint(endpoints, 'cloud.example')).toBeUndefined();
  });

  it('reads token_uri, and the source credentials of an impersonated account', () => {
    const endpoints = tokenEndpoints({
      env: { GOOGLE_APPLICATION_CREDENTIALS: '/creds/gdch.json' },
      readFile: () =>
        JSON.stringify({
          type: 'impersonated_service_account',
          token_uri: 'https://gdch-token.example/authenticate',
          source_credentials: { type: 'authorized_user', token_uri: 'https://refresh.example/token' },
        }),
    });
    expect(matchTokenEndpoint(endpoints, 'gdch-token.example')).toBeDefined();
    expect(matchTokenEndpoint(endpoints, 'refresh.example')).toBeDefined();
  });

  it('keeps the static list when the credentials file is missing or not JSON', () => {
    for (const readFile of [noFile, () => 'not json', () => '[1, 2]', () => 'null']) {
      const endpoints = tokenEndpoints({ env: { GOOGLE_APPLICATION_CREDENTIALS: '/nope.json' }, readFile });
      expect(endpoints).toEqual(STATIC_TOKEN_ENDPOINTS);
    }
  });

  it('ignores credential fields that are not strings or not URLs', () => {
    const endpoints = tokenEndpoints({
      env: { GOOGLE_APPLICATION_CREDENTIALS: '/creds.json' },
      readFile: () => JSON.stringify({ token_url: 42, token_uri: 'not a url', universe_domain: '' }),
    });
    expect(endpoints).toEqual(STATIC_TOKEN_ENDPOINTS);
  });
});

// ─── the installed auth libraries ─────────────────────────────────────────

const cliRoot = resolve(import.meta.dir, '..');

/** The directory of `name` as `fromDir` resolves it, following the store layout of whatever installed it. */
function packageDir(fromDir: string, name: string): string {
  const require = createRequire(join(fromDir, 'package.json'));
  let entry: string;
  try {
    entry = require.resolve(`${name}/package.json`);
    return dirname(entry);
  } catch {
    entry = require.resolve(name);
  }
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
    if (parsed.name === name) return dir;
  }
  throw new Error(`no package.json named ${name} above ${entry}`);
}

function versionOf(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
}

/** Every `.js` file under `dir`. */
function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...jsFiles(path));
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

/** The auth libraries firebase-admin loads: its own google-auth-library, and the one its Firestore client loads. */
function installedAuthLibraries(): Array<{ label: string; dir: string }> {
  const admin = packageDir(cliRoot, 'firebase-admin');
  const gal10 = packageDir(admin, 'google-auth-library');
  const firestore = packageDir(admin, '@google-cloud/firestore');
  const gax = packageDir(firestore, 'google-gax');
  const gal9 = packageDir(gax, 'google-auth-library');
  const libraries = [
    { name: 'google-auth-library', dir: gal10 },
    { name: 'gcp-metadata', dir: packageDir(gal10, 'gcp-metadata') },
    { name: 'google-auth-library', dir: gal9 },
    { name: 'gtoken', dir: packageDir(gal9, 'gtoken') },
    { name: 'gcp-metadata', dir: packageDir(gal9, 'gcp-metadata') },
  ];
  return libraries.map(({ name, dir }) => ({ label: `${name}@${versionOf(dir)}`, dir }));
}

/** A URL literal in a library source, with its template holes filled where the hole is a known host part. */
const URL_LITERAL = /https?:\/\/[^\s'"`)\]]+/g;

/** Fills `${this.universeDomain}`-style holes; `undefined` when a hole names a host this test can't know. */
function fillHoles(literal: string): string | undefined {
  let unknownHost = false;
  const filled = literal.replace(/\$?\{([^}]*)\}/g, (_hole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.includes('universe')) return 'googleapis.com';
    if (lower.includes('region')) return 'us-east-1';
    unknownHost = true;
    return 'hole';
  });
  if (!unknownHost) return filled;
  // A hole in the path is harmless; a hole in the host is a host read from
  // config or the environment, which the env suite above covers.
  const host = /^https?:\/\/([^/]*)/.exec(filled)?.[1] ?? '';
  return host.includes('hole') ? undefined : filled;
}

/** Whether a URL names a place a token comes from, judged without the list under test. */
function namesTokenSource(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const tokenPath =
    /(^|\/)(token|oauthtoken|tokeninfo|revoke)(\/|$)/.test(path) ||
    /:(generateaccesstoken|generateidtoken|signblob|signjwt)$/.test(path) ||
    path.includes('computemetadata');
  const tokenHost = /^(oauth2|sts|iamcredentials)\./.test(host) || host.startsWith('metadata') || host.startsWith('169.254.');
  return tokenPath || tokenHost;
}

/** Decision 2 leaves these off on purpose: a consent page for a browser, and AWS credentials. */
function deliberatelyAllowed(url: URL): boolean {
  return url.hostname === 'accounts.google.com' || url.hostname.endsWith('.amazonaws.com');
}

describe('the installed auth libraries name no token URL the list lets through', () => {
  const libraries = installedAuthLibraries();

  it('finds every library firebase-admin loads, at the versions decision 2 checked or later', () => {
    expect(libraries.map((library) => library.label.split('@')[0])).toEqual([
      'google-auth-library',
      'gcp-metadata',
      'google-auth-library',
      'gtoken',
      'gcp-metadata',
    ]);
  });

  const found = new Map<string, string>();
  for (const library of libraries) {
    for (const file of jsFiles(join(library.dir, 'build'))) {
      for (const literal of readFileSync(file, 'utf8').match(URL_LITERAL) ?? []) {
        const filled = fillHoles(literal);
        if (filled === undefined) continue;
        let url: URL;
        try {
          url = new URL(filled);
        } catch {
          continue;
        }
        if (!namesTokenSource(url) || deliberatelyAllowed(url)) continue;
        found.set(url.href, `${library.label} ${file.slice(library.dir.length + 1)}`);
      }
    }
  }

  it('reads the token URLs decision 2 cites, so the scan is not empty', () => {
    const hrefs = [...found.keys()];
    for (const expected of [
      'https://oauth2.googleapis.com/token',
      'https://www.googleapis.com/oauth2/v4/token',
      'https://sts.googleapis.com/v1/token',
      'http://169.254.169.254/',
      'http://metadata.google.internal./',
    ]) {
      expect({ expected, found: hrefs.includes(expected) }).toEqual({ expected, found: true });
    }
  });

  it('refuses every one of them', () => {
    const letThrough = [...found.entries()]
      .filter(([href]) => {
        const url = new URL(href);
        return matchTokenEndpoint(STATIC_TOKEN_ENDPOINTS, url.hostname, url.pathname + url.search) === undefined;
      })
      .map(([href, where]) => `${href} (${where})`);
    expect(letThrough).toEqual([]);
  });
});
