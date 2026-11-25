/**
 * Adversarial negative and positive security tests for Storage byte-route,
 * avatar-route, and Studio workspace XSS hardening:
 *   1. Storage byte route and avatar route emit `Content-Security-Policy: sandbox; default-src 'none'`
 *      and `X-Content-Type-Options: nosniff` on every response, and force
 *      `Content-Disposition: attachment` on active document MIME types (`text/html`,
 *      `application/xhtml+xml`, `image/svg+xml`, XML/JS/MHTML, regardless of casing,
 *      MIME parameters, or attacker-supplied `contentDisposition: "inline"`).
 *   2. Non-active media and binary responses (`image/png`, `audio/wav`, `text/plain`)
 *      keep `<img>`, `fetch()`, and `Range` reads working cleanly without forcing
 *      `Content-Disposition: attachment`.
 *   3. Asset resolver rejects manifest entries declaring non-image MIME types such
 *      as `text/html`.
 *   4. End-to-end JSDOM + HTTP negative security test proving uploaded HTML/SVG
 *      under `/__pyric/storage` or `/__pyric/assets/avatar` cannot execute scripts
 *      under `/__pyric`, read `/__pyric/init.json`, or mutate `.git/hooks` / `.npmrc`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { saveManifest } from '../../src/serve/assets/manifest.js';
import { createAssetResolver, type AssetResolver } from '../../src/serve/assets/resolver.js';
import { createStorageByteRoute } from '../../src/serve/hosted/storage-byte-route.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { diskWorkspace } from '../../src/serve/studio/disk-workspace.js';
import { createStudioRoutes } from '../../src/serve/studio/routes.js';
import { untrustedContentHeaders } from '../../src/serve/untrusted-content-headers.js';

const EXPECTED_CSP = "sandbox; default-src 'none'";

const handles: ServeHandle[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) {
      await handle.stop();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface StoredFixtureObject {
  file: string;
  mime: string;
  body: string;
  contentDisposition?: string;
}

async function startHardenedFixtureServer(opts: {
  objects: Record<string, StoredFixtureObject>;
  avatarAsset?: { data: Uint8Array; contentType: string };
  sessionToken: string;
  downloadToken: string;
}): Promise<{ server: ServeHandle; projectDir: string }> {
  const root = makeTempDir('pyric-xss-hardening-');
  const projectDir = join(root, 'project');
  const siteDir = join(root, 'public');
  const sdkDir = join(root, 'sdk');
  mkdirSync(join(projectDir, '.git', 'hooks'), { recursive: true });
  mkdirSync(siteDir, { recursive: true });
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');

  const byteRoute = createStorageByteRoute({
    storage: {
      async objectFile(bucket, path) {
        if (bucket !== 'demo-bucket') {
          return undefined;
        }
        const entry = opts.objects[path];
        if (entry === undefined) {
          return undefined;
        }
        const size = Buffer.byteLength(entry.body);
        const metadata: {
          fullPath: string;
          name: string;
          bucket: string;
          generation: string;
          metageneration: string;
          contentType: string;
          contentDisposition?: string;
          size: number;
          timeCreated: string;
          updated: string;
          downloadTokens: string;
        } = {
          fullPath: path,
          name: path.split('/').pop() ?? path,
          bucket,
          generation: '1',
          metageneration: '1',
          contentType: entry.mime,
          size,
          timeCreated: '2026-01-01T00:00:00.000Z',
          updated: '2026-01-01T00:00:00.000Z',
          downloadTokens: opts.downloadToken,
        };
        if (entry.contentDisposition !== undefined) {
          metadata.contentDisposition = entry.contentDisposition;
        }
        return {
          file: entry.file,
          size,
          mime: entry.mime,
          metadata,
        };
      },
      async appendUpload() {
        throw new Error('unexpected appendUpload');
      },
      async uploadProgress() {
        return undefined;
      },
    },
    sessionToken: opts.sessionToken,
    uploadToken: () => undefined,
  });

  const studioRoutes = createStudioRoutes({
    workspace: diskWorkspace(projectDir),
    sessionToken: opts.sessionToken,
  });

  let avatars: AssetResolver | undefined;
  if (opts.avatarAsset !== undefined) {
    const resolved = opts.avatarAsset;
    avatars = {
      async resolve() {
        return {
          data: resolved.data,
          contentType: resolved.contentType,
          origin: 'source',
        };
      },
    };
  }

  const namespaceOptions: Parameters<typeof createPyricNamespace>[0] = {
    sdkDir,
    initPayload: () => ({
      rules: null,
      rulesHash: null,
      bridgeUrl: null,
      sessionToken: opts.sessionToken,
    }),
  };
  if (avatars !== undefined) {
    namespaceOptions.avatars = avatars;
  }
  const namespace = createPyricNamespace(namespaceOptions);

  const server = await startStaticServer({
    publicDir: siteDir,
    port: 0,
    host: '127.0.0.1',
    logger: silentServeLogger(),
    namespaceHandler: async (req, res, url) => {
      if (await byteRoute(req, res, url)) return true;
      if (await studioRoutes(req, res, url)) return true;
      return namespace(req, res, url);
    },
  });
  handles.push(server);
  return { server, projectDir };
}

describe('untrustedContentHeaders', () => {
  const activeTypes = [
    'text/html',
    'TEXT/HTML; charset=utf-8',
    'application/xhtml+xml',
    'image/svg+xml',
    'image/svg+xml; charset=utf-8',
    'text/xml',
    'application/xml',
    'application/rss+xml',
    'text/javascript',
    'application/javascript',
    'multipart/related',
  ];

  for (const mime of activeTypes) {
    it(`forces sandbox CSP, nosniff, and attachment disposition for active type ${mime}`, () => {
      const overridden = untrustedContentHeaders(mime, 'inline; filename="payload.html"');
      expect(overridden['content-security-policy']).toBe(EXPECTED_CSP);
      expect(overridden['x-content-type-options']).toBe('nosniff');
      expect(overridden['content-disposition']).toBe('attachment');

      const missing = untrustedContentHeaders(mime);
      expect(missing['content-disposition']).toBe('attachment');

      const preservedAttachment = untrustedContentHeaders(mime, 'attachment; filename="safe.svg"');
      expect(preservedAttachment['content-disposition']).toBe('attachment; filename="safe.svg"');
    });
  }

  it('rejects CR/LF in requested disposition on both active and non-active MIME types', () => {
    const poisonedActive = untrustedContentHeaders(
      'text/html',
      'attachment; filename="x"\r\nX-Injected: 1',
    );
    expect(poisonedActive['content-disposition']).toBe('attachment');

    const poisonedNonActive = untrustedContentHeaders(
      'image/png',
      'inline; filename="x"\r\nX-Injected: 1',
    );
    expect(poisonedNonActive['content-security-policy']).toBe(EXPECTED_CSP);
    expect(poisonedNonActive['x-content-type-options']).toBe('nosniff');
    expect(poisonedNonActive['content-disposition']).toBeUndefined();
  });

  it('forces attachment on comma-separated Content-Type lists containing an active MIME type', () => {
    const htmlComma = untrustedContentHeaders('text/plain, text/html', 'inline');
    expect(htmlComma['content-security-policy']).toBe(EXPECTED_CSP);
    expect(htmlComma['x-content-type-options']).toBe('nosniff');
    expect(htmlComma['content-disposition']).toBe('attachment');

    const svgComma = untrustedContentHeaders('image/png, image/svg+xml; charset=utf-8', 'inline');
    expect(svgComma['content-disposition']).toBe('attachment');
  });

  it('keeps non-active media and binary types free of forced attachment while setting CSP and nosniff', () => {
    const png = untrustedContentHeaders('image/png');
    expect(png['content-security-policy']).toBe(EXPECTED_CSP);
    expect(png['x-content-type-options']).toBe('nosniff');
    expect(png['content-disposition']).toBeUndefined();

    const inlineAudio = untrustedContentHeaders('audio/wav', 'inline');
    expect(inlineAudio['content-security-policy']).toBe(EXPECTED_CSP);
    expect(inlineAudio['x-content-type-options']).toBe('nosniff');
    expect(inlineAudio['content-disposition']).toBe('inline');
  });
});

describe('storage byte-route and avatar-route XSS hardening', () => {
  it('hardens uploaded HTML and SVG on storage byte route while preserving fetch and Range reads', async () => {
    const objDir = makeTempDir('pyric-xss-objs-');
    const htmlBody = '<!doctype html><script>window.__xss = 1;</script>';
    const svgBody = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svg = 1;</script></svg>';
    const pngBody = 'PNGDATA0123456789';
    const htmlFile = join(objDir, 'page.html');
    const svgFile = join(objDir, 'badge.svg');
    const pngFile = join(objDir, 'photo.png');
    writeFileSync(htmlFile, htmlBody, 'utf8');
    writeFileSync(svgFile, svgBody, 'utf8');
    writeFileSync(pngFile, pngBody, 'utf8');

    const { server } = await startHardenedFixtureServer({
      sessionToken: 'sess-tok',
      downloadToken: 'dl-tok',
      objects: {
        'uploads/page.html': {
          file: htmlFile,
          mime: 'TEXT/HTML; charset=utf-8',
          body: htmlBody,
          contentDisposition: 'inline',
        },
        'uploads/badge.svg': {
          file: svgFile,
          mime: 'image/svg+xml',
          body: svgBody,
          contentDisposition: 'inline; filename="badge.svg"',
        },
        'uploads/photo.png': {
          file: pngFile,
          mime: 'image/png',
          body: pngBody,
        },
        'uploads/comma.html': {
          file: htmlFile,
          mime: 'text/plain, text/html',
          body: htmlBody,
          contentDisposition: 'inline',
        },
        'uploads/poisoned-disposition.png': {
          file: pngFile,
          mime: 'image/png',
          body: pngBody,
          contentDisposition: 'inline\r\nX-Injected: 1',
        },
      },
    });

    const htmlRes = await fetch(
      `${server.url}/__pyric/storage/v0/b/demo-bucket/o/uploads%2Fpage.html?alt=media&token=dl-tok`,
    );
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(htmlRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(htmlRes.headers.get('content-disposition')).toBe('attachment');
    expect(await htmlRes.text()).toBe(htmlBody);

    const svgRes = await fetch(
      `${server.url}/__pyric/storage/v0/b/demo-bucket/o/uploads%2Fbadge.svg?alt=media&token=dl-tok`,
    );
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(svgRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(svgRes.headers.get('content-disposition')).toBe('attachment');
    expect(await svgRes.text()).toBe(svgBody);

    const pngRes = await fetch(
      `${server.url}/__pyric/storage/v0/b/demo-bucket/o/uploads%2Fphoto.png?alt=media&token=dl-tok`,
    );
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(pngRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(pngRes.headers.get('content-disposition')).toBeNull();
    expect(await pngRes.text()).toBe(pngBody);

    const rangeRes = await fetch(
      `${server.url}/__pyric/storage/v0/b/demo-bucket/o/uploads%2Fphoto.png?alt=media&token=dl-tok`,
      { headers: { range: 'bytes=0-6' } },
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(rangeRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await rangeRes.text()).toBe('PNGDATA');

    const commaRes = await fetch(
      `${server.url}/__pyric/storage/v0/b/demo-bucket/o/uploads%2Fcomma.html?alt=media&token=dl-tok`,
    );
    expect(commaRes.status).toBe(200);
    expect(commaRes.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(commaRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(commaRes.headers.get('content-disposition')).toBe('attachment');

    const poisonedPngRes = await fetch(
      `${server.url}/__pyric/storage/v0/b/demo-bucket/o/uploads%2Fpoisoned-disposition.png?alt=media&token=dl-tok`,
    );
    expect(poisonedPngRes.status).toBe(200);
    expect(poisonedPngRes.headers.get('content-disposition')).toBeNull();
    expect(poisonedPngRes.headers.get('x-injected')).toBeNull();
    expect(await poisonedPngRes.text()).toBe(pngBody);
  });

  it('hardens SVG and raster responses on the avatar route', async () => {
    const svgBytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const svgFixture = await startHardenedFixtureServer({
      sessionToken: 'sess-tok',
      downloadToken: 'dl-tok',
      objects: {},
      avatarAsset: { data: svgBytes, contentType: 'image/svg+xml' },
    });

    const svgRes = await fetch(`${svgFixture.server.url}/__pyric/assets/avatar/alice`);
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get('content-type')).toBe('image/svg+xml');
    expect(svgRes.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(svgRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(svgRes.headers.get('content-disposition')).toBe('attachment');
    expect(await svgRes.text()).toContain('<svg');

    const pngBytes = new TextEncoder().encode('png-avatar-bytes');
    const pngFixture = await startHardenedFixtureServer({
      sessionToken: 'sess-tok',
      downloadToken: 'dl-tok',
      objects: {},
      avatarAsset: { data: pngBytes, contentType: 'image/png' },
    });

    const pngRes = await fetch(`${pngFixture.server.url}/__pyric/assets/avatar/bob`);
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get('content-type')).toBe('image/png');
    expect(pngRes.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(pngRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(pngRes.headers.get('content-disposition')).toBeNull();
    expect(Buffer.from(await pngRes.arrayBuffer())).toEqual(Buffer.from(pngBytes));
  });

  it('rejects manifest entries declaring non-image content types in createAssetResolver', async () => {
    const dir = makeTempDir('pyric-avatar-manifest-');
    writeFileSync(join(dir, 'evil.html'), '<script>alert(1)</script>', 'utf8');
    saveManifest(dir, {
      version: 1,
      images: [{ file: 'evil.html', contentType: 'text/html', key: 'alice' }],
    });

    const resolver = createAssetResolver({
      dir,
      fallback: () => ({
        data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        contentType: 'image/svg+xml',
      }),
    });

    const resolved = await resolver.resolve({ key: 'alice', seed: 'alice', context: {} });
    expect(resolved.origin).toBe('fallback');
    expect(resolved.contentType).toBe('image/svg+xml');
  });

  it('blocks uploaded HTML/SVG XSS from executing JS under /__pyric, reading /__pyric/init.json, or mutating .git/hooks and .npmrc', async () => {
    const objDir = makeTempDir('pyric-xss-chain-');
    const sessionToken = 'synthetic-session-secret';
    const downloadToken = 'dl-tok-chain';
    const xssHtml = [
      '<!doctype html><html><body><script>',
      'window.__executed = true;',
      "fetch('/__pyric/init.json').then(r => r.json()).then(d => { window.__init = d; });",
      '</script></body></html>',
    ].join('');
    const xssSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>',
      'window.__svgExecuted = true;',
      '</script></svg>',
    ].join('');
    const htmlFile = join(objDir, 'exploit.html');
    const svgFile = join(objDir, 'exploit.svg');
    writeFileSync(htmlFile, xssHtml, 'utf8');
    writeFileSync(svgFile, xssSvg, 'utf8');

    const { server, projectDir } = await startHardenedFixtureServer({
      sessionToken,
      downloadToken,
      objects: {
        'uploads/exploit.html': {
          file: htmlFile,
          mime: 'text/html',
          body: xssHtml,
          contentDisposition: 'inline',
        },
        'uploads/exploit.svg': {
          file: svgFile,
          mime: 'image/svg+xml',
          body: xssSvg,
          contentDisposition: 'inline',
        },
      },
      avatarAsset: {
        data: new TextEncoder().encode(xssSvg),
        contentType: 'image/svg+xml',
      },
    });

    const targets = [
      `${server.url}/__pyric/storage/v0/b/demo-bucket/o/uploads%2Fexploit.html?alt=media&token=${downloadToken}`,
      `${server.url}/__pyric/storage/v0/b/demo-bucket/o/uploads%2Fexploit.svg?alt=media&token=${downloadToken}`,
      `${server.url}/__pyric/assets/avatar/attacker`,
    ];

    for (const targetUrl of targets) {
      const response = await fetch(targetUrl);
      expect(response.status).toBe(200);
      const csp = response.headers.get('content-security-policy') ?? '';
      const disposition = response.headers.get('content-disposition') ?? '';
      const nosniff = response.headers.get('x-content-type-options') ?? '';
      expect(csp).toBe(EXPECTED_CSP);
      expect(nosniff).toBe('nosniff');
      expect(disposition).toBe('attachment');

      // Browser enforcement: `CSP: sandbox` (without allow-scripts / allow-same-origin)
      // disables inline script execution and isolates the document into an opaque origin.
      const scriptsAllowedByCsp = csp.includes('allow-scripts');
      expect(scriptsAllowedByCsp).toBe(false);
      const body = await response.text();
      let runScripts: 'dangerously' | 'outside-only' = 'outside-only';
      if (scriptsAllowedByCsp) {
        runScripts = 'dangerously';
      }
      const dom = new JSDOM(body, {
        url: 'about:blank',
        runScripts,
      });
      const win = dom.window as unknown as {
        __executed?: boolean;
        __svgExecuted?: boolean;
        __init?: unknown;
      };
      expect(win.__executed).toBeUndefined();
      expect(win.__svgExecuted).toBeUndefined();
      expect(win.__init).toBeUndefined();
      expect(dom.window.origin).toBe('null');
      dom.window.close();
    }

    // Defense-in-depth layer: even an authenticated caller holding the session
    // token cannot write or read `.git/hooks/*` or `.npmrc` via `/__pyric/workspace`,
    // while writing an ordinary project file succeeds (proving 403 is WorkspaceDeniedPathError).
    const allowedPut = await fetch(`${server.url}/__pyric/workspace?path=ok.txt`, {
      method: 'PUT',
      headers: { 'x-pyric-session-token': sessionToken },
      body: 'allowed-workspace-write\n',
    });
    expect(allowedPut.status).toBe(204);
    expect(existsSync(join(projectDir, 'ok.txt'))).toBe(true);

    const hookPut = await fetch(`${server.url}/__pyric/workspace?path=.git/hooks/post-checkout`, {
      method: 'PUT',
      headers: { 'x-pyric-session-token': sessionToken },
      body: '#!/bin/sh\necho blocked\n',
    });
    expect(hookPut.status).toBe(403);
    expect(await hookPut.text()).toContain('not served');
    expect(existsSync(join(projectDir, '.git', 'hooks', 'post-checkout'))).toBe(false);

    const npmrcPut = await fetch(`${server.url}/__pyric/workspace?path=.npmrc`, {
      method: 'PUT',
      headers: { 'x-pyric-session-token': sessionToken },
      body: '//registry.example.test/:_authToken=blocked\n',
    });
    expect(npmrcPut.status).toBe(403);
    expect(await npmrcPut.text()).toContain('not served');
    expect(existsSync(join(projectDir, '.npmrc'))).toBe(false);
  });
});
