/**
 * The token sources the network guard refuses (ADR 0022, decision 2).
 *
 * The fixed list is pinned literally, so widening or narrowing it is a
 * deliberate edit to this file. The last block reads the installed
 * google-auth-library, gtoken and gcp-metadata, the versions firebase-admin
 * loads, and fails when one names a token URL the list doesn't refuse. That
 * catches the next library release.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { normalizeHostname, matchesHostSuffix } from '../src/google-endpoints.js';
import {
  GOOGLE_TOKEN_HOSTS,
  GOOGLE_TOKEN_PATH_HOST,
  comparablePath,
  findTokenSource,
  tokenEndpointsFrom,
  type TokenEndpoints,
} from '../src/google-token-endpoints.js';

const fixed = (): TokenEndpoints => tokenEndpointsFrom({ env: {} });

/** Whether `host` (any spelling) with `path` is refused. */
function refused(endpoints: TokenEndpoints, host: string, path?: string): boolean {
  return findTokenSource(endpoints, normalizeHostname(host), path) !== undefined;
}

describe('GOOGLE_TOKEN_HOSTS', () => {
  it('is exactly the hosts refused whole', () => {
    expect(GOOGLE_TOKEN_HOSTS.map((source) => source.host).sort()).toEqual(
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
  });

  it('is written in normalizeHostname\'s spelling, so a lookup can match it', () => {
    for (const source of GOOGLE_TOKEN_HOSTS) expect(normalizeHostname(source.host)).toBe(source.host);
  });

  it('refuses each one on any path', () => {
    for (const source of GOOGLE_TOKEN_HOSTS) {
      expect(refused(fixed(), source.host)).toBe(true);
      expect(refused(fixed(), source.host, '/anything')).toBe(true);
    }
  });

  it('refuses the metadata server however it is spelled', () => {
    const spellings = [
      '2852039166',
      '0xa9fea9fe',
      '169.254.43518',
      '0251.0376.0251.0376',
      '::ffff:169.254.169.254',
      '[::ffff:a9fe:a9fe]',
      '::ffff:a9fe:a9fe%lo',
      'METADATA.google.internal.',
      'metadata.',
      'fd20:00ce:0000:0000:0000:0000:0000:0254',
      '[FD20:CE::254]',
    ];
    for (const spelling of spellings) expect({ spelling, refused: refused(fixed(), spelling) }).toEqual({ spelling, refused: true });
  });
});

describe('the token paths on www.googleapis.com', () => {
  it('refuses /oauth2/<version>/token in every spelling a server may read as it', () => {
    for (const path of ['/oauth2/v4/token', '/oauth2/v3/token', '/oauth2/v4/token?grant_type=x', '//oauth2//v4/token', '/OAuth2/V4/%74oken']) {
      expect({ path, refused: refused(fixed(), GOOGLE_TOKEN_PATH_HOST, path) }).toEqual({ path, refused: true });
    }
  });

  it('lets public keys and the host\'s other APIs through', () => {
    for (const path of ['/oauth2/v1/certs', '/oauth2/v3/certs', '/oauth2/v3/tokeninfo', '/drive/v3/files', '/', undefined]) {
      expect({ path, refused: refused(fixed(), GOOGLE_TOKEN_PATH_HOST, path) }).toEqual({ path, refused: false });
    }
  });

  it('applies only to www.googleapis.com', () => {
    expect(refused(fixed(), 'storage.googleapis.com', '/oauth2/v4/token')).toBe(false);
  });

  it('comparablePath drops the query, decodes, collapses slashes and lowercases', () => {
    expect(comparablePath('//OAuth2/V4/%74oken?x=1#y')).toBe('/oauth2/v4/token');
    expect(comparablePath('oauth2/v4/token')).toBe('/oauth2/v4/token');
    expect(comparablePath('/bad%escape')).toBe('/bad%escape');
  });
});

describe('hosts the guard lets through without a report', () => {
  it('passes Firebase data hosts, Auth, AI Logic, Fonts, Cloud Run and the browser consent host', () => {
    for (const host of [
      'firestore.googleapis.com',
      'identitytoolkit.googleapis.com',
      'securetoken.googleapis.com',
      'firebasevertexai.googleapis.com',
      'firebasestorage.googleapis.com',
      'demo-default-rtdb.firebaseio.com',
      'fonts.googleapis.com',
      'my-service-abc.a.run.app',
      'accounts.google.com',
      'firebaserules.googleapis.com',
      'example.com',
      '127.0.0.1',
    ]) {
      expect({ host, refused: refused(fixed(), host, '/v1/token') }).toEqual({ host, refused: false });
    }
  });
});

describe('hosts the environment adds', () => {
  it('refuses the hosts GCE_METADATA_HOST and GCE_METADATA_IP name, with or without a port', () => {
    const endpoints = tokenEndpointsFrom({
      env: { GCE_METADATA_HOST: 'metadata.example.internal:8080', GCE_METADATA_IP: '10.1.2.3' },
    });
    expect(refused(endpoints, 'metadata.example.internal')).toBe(true);
    expect(refused(endpoints, '10.1.2.3')).toBe(true);
    expect(refused(fixed(), 'metadata.example.internal')).toBe(false);
  });

  it('reads a bracketed or bare IPv6 metadata address', () => {
    expect(refused(tokenEndpointsFrom({ env: { GCE_METADATA_IP: '[fd00::5]:80' } }), 'fd00::5')).toBe(true);
    expect(refused(tokenEndpointsFrom({ env: { GCE_METADATA_HOST: 'fd00::6' } }), 'fd00::6')).toBe(true);
  });

  it('never adds a loopback host, which would refuse the sandbox itself', () => {
    const endpoints = tokenEndpointsFrom({
      env: { GCE_METADATA_HOST: 'localhost:8080', GCE_METADATA_IP: '127.0.0.1:9000' },
    });
    expect(refused(endpoints, 'localhost')).toBe(false);
    expect(refused(endpoints, '127.0.0.1')).toBe(false);
  });

  /** The token sources with `json` as the file in GOOGLE_APPLICATION_CREDENTIALS. */
  function withCredentials(json: unknown): TokenEndpoints {
    return tokenEndpointsFrom({
      env: { GOOGLE_APPLICATION_CREDENTIALS: '/creds.json' },
      readFile: (path) => {
        expect(path).toBe('/creds.json');
        return JSON.stringify(json);
      },
    });
  }

  it('refuses the token URLs an external account file names', () => {
    const endpoints = withCredentials({
      type: 'external_account',
      token_url: 'https://sts.example-universe.test/v1/token',
      service_account_impersonation_url: 'https://iam.example.test/v1/sa:generateAccessToken',
    });
    expect(refused(endpoints, 'sts.example-universe.test')).toBe(true);
    expect(refused(endpoints, 'iam.example.test')).toBe(true);
  });

  it('refuses sts. and iamcredentials. under the file\'s universe_domain', () => {
    const endpoints = withCredentials({ type: 'service_account', universe_domain: 'example-universe.test' });
    expect(refused(endpoints, 'sts.example-universe.test')).toBe(true);
    expect(refused(endpoints, 'iamcredentials.example-universe.test')).toBe(true);
    expect(refused(endpoints, 'firestore.example-universe.test')).toBe(false);
  });

  it('refuses the token_uri a service account or GDCH file names', () => {
    expect(refused(withCredentials({ type: 'gdch_service_account', token_uri: 'https://gdch.example.test/token' }), 'gdch.example.test')).toBe(true);
  });

  it('refuses only the named path when the file points at www.googleapis.com', () => {
    const endpoints = withCredentials({ token_uri: 'https://www.googleapis.com/custom/token' });
    expect(refused(endpoints, 'www.googleapis.com', '/custom/token')).toBe(true);
    expect(refused(endpoints, 'www.googleapis.com', '/drive/v3/files')).toBe(false);
  });

  it('reads the source credentials an impersonated service account file starts from', () => {
    const endpoints = withCredentials({
      type: 'impersonated_service_account',
      service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/x:generateAccessToken',
      source_credentials: { type: 'external_account', token_url: 'https://sts.nested.test/v1/token' },
    });
    expect(refused(endpoints, 'sts.nested.test')).toBe(true);
  });

  it('skips a loopback URL in the file, and a file that is missing or not JSON', () => {
    expect(refused(withCredentials({ token_url: 'http://127.0.0.1:9000/token' }), '127.0.0.1')).toBe(false);
    const missing = tokenEndpointsFrom({
      env: { GOOGLE_APPLICATION_CREDENTIALS: '/nope.json' },
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(missing.hosts).toEqual(fixed().hosts);
    const notJson = tokenEndpointsFrom({ env: { GOOGLE_APPLICATION_CREDENTIALS: '/x' }, readFile: () => 'not json' });
    expect(notJson.hosts).toEqual(fixed().hosts);
  });
});

// ─── the installed auth libraries name no token URL the list misses ──────────

/** The libraries that ask for tokens, and the packages through which firebase-admin reaches them. */
const AUTH_LIBRARIES = new Set(['google-auth-library', 'gtoken', 'gcp-metadata']);
const WALKED = new Set([...AUTH_LIBRARIES, '@google-cloud/firestore', '@google-cloud/storage', 'google-gax']);

/**
 * Hosts whose URLs in these libraries are documentation, or are left off the
 * list on purpose: `accounts.google.com` builds a browser consent URL and
 * revokes, and the AWS hosts give AWS credentials, which become a Google token
 * only at `sts.googleapis.com`.
 */
const NOT_TOKEN_SOURCES = [
  'cloud.google.com',
  'developers.google.com',
  'github.com',
  'ietf.org',
  'amazon.com',
  'amazonaws.com',
  'accounts.google.com',
];

/** The root of the package `name` resolves to from `fromDir`, or `undefined`. */
function packageRoot(name: string, fromDir: string): string | undefined {
  let entry: string;
  try {
    entry = createRequire(join(fromDir, 'noop.js')).resolve(name);
  } catch {
    return undefined;
  }
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    try {
      if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === name) return dir;
    } catch {
      // No manifest here: keep climbing.
    }
  }
  return undefined;
}

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Every auth library firebase-admin reaches, keyed `name@version`, to its root. */
function installedAuthLibraries(): Map<string, string> {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (dir: string): void => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
    if (AUTH_LIBRARIES.has(manifest.name)) found.set(`${manifest.name}@${manifest.version}`, dir);
    // firebase-admin lists Firestore and Storage as optional dependencies.
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const dependency of Object.keys(dependencies)) {
      if (!WALKED.has(dependency)) continue;
      const root = packageRoot(dependency, dir);
      if (root !== undefined) visit(root);
    }
  };
  const admin = packageRoot('firebase-admin', import.meta.dir);
  if (admin !== undefined) visit(admin);
  return found;
}

function jsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...jsFiles(path));
    else if (name.endsWith('.js')) files.push(path);
  }
  return files;
}

/** URL string literals in `source`, comments left out, placeholders written as the default universe. */
function urlLiterals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const urls: string[] = [];
  for (const match of code.matchAll(/['"`](https?:\/\/[^'"`\s]+)/g)) {
    urls.push(match[1]!.replace(/\$\{[^}]*\}|\{[^}]*\}/g, 'googleapis.com'));
  }
  return urls;
}

/** A URL a library asks for a token at: a token path, or the metadata server. */
function isTokenUrl(url: URL): boolean {
  const asksForToken = /token|computemetadata/i.test(url.pathname);
  const isMetadata = findTokenSource(fixed(), normalizeHostname(url.hostname))?.service === 'GCE metadata server';
  return asksForToken || isMetadata;
}

describe('the installed auth libraries', () => {
  const libraries = installedAuthLibraries();

  it('are found through firebase-admin, the versions the list was checked against among them', () => {
    const names = [...libraries.keys()];
    for (const name of AUTH_LIBRARIES) expect(names.some((key) => key.startsWith(`${name}@`))).toBe(true);
  });

  it('name no token URL whose host and path the list does not refuse', () => {
    const missed: string[] = [];
    const checked = new Set<string>();
    for (const [library, root] of libraries) {
      for (const file of jsFiles(join(root, 'build'))) {
        for (const literal of urlLiterals(readFileSync(file, 'utf8'))) {
          let url: URL;
          try {
            url = new URL(literal);
          } catch {
            continue;
          }
          const host = normalizeHostname(url.hostname);
          if (NOT_TOKEN_SOURCES.some((suffix) => matchesHostSuffix(host, suffix))) continue;
          if (!isTokenUrl(url)) continue;
          checked.add(literal);
          if (!refused(fixed(), host, url.pathname)) missed.push(`${library} ${file.slice(root.length)}: ${literal}`);
        }
      }
    }
    expect(missed).toEqual([]);
    // The scan reaches each library's own token URL, so a pass means something.
    for (const url of ['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v4/token', 'http://169.254.169.254', 'http://metadata.google.internal.']) {
      expect(checked).toContain(url);
    }
  });
});
