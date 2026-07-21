import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSiteTreeHandler } from '../../src/serve/site-tree.js';
import {
  silentServeLogger,
  startStaticServer,
  type ServeHandle,
} from '../../src/serve/server.js';

const handles: ServeHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
});

function siteFixture(): { publicDir: string; siteRoot: string } {
  const publicDir = mkdtempSync(join(tmpdir(), 'pyric-site-tree-'));
  const siteRoot = join(publicDir, 'site');
  mkdirSync(join(siteRoot, 'firestore'), { recursive: true });
  mkdirSync(join(siteRoot, 'storage'), { recursive: true });
  mkdirSync(join(siteRoot, 'docs', 'overview'), { recursive: true });
  mkdirSync(join(siteRoot, '_astro'), { recursive: true });
  writeFileSync(join(siteRoot, 'index.html'), '<!doctype html><head></head>HOME');
  writeFileSync(
    join(siteRoot, 'firestore', 'index.html'),
    '<!doctype html><head></head>FIRESTORE',
  );
  writeFileSync(join(siteRoot, 'storage', 'index.html'), '<!doctype html><head></head>STORAGE');
  writeFileSync(join(siteRoot, 'docs', 'overview', 'index.html'), '<!doctype html>DOCS');
  writeFileSync(join(siteRoot, 'docs', 'overview.md'), '# Overview');
  writeFileSync(join(siteRoot, 'docs', 'index.json'), '{"pages":[]}');
  writeFileSync(join(siteRoot, '_astro', 'app.js'), '// app');
  writeFileSync(
    join(siteRoot, 'studio-routes.json'),
    JSON.stringify({ routes: ['firestore', 'storage'] }),
  );
  return { publicDir, siteRoot };
}

function invokeRawPath(
  handler: ReturnType<typeof createSiteTreeHandler>,
  path: string,
): {
  status: number;
  location: string | undefined;
} {
  let status = 0;
  let location: string | undefined;
  const response = {
    writeHead(code: number, headers?: Record<string, string>) {
      status = code;
      location = headers?.location;
      return response;
    },
    end() { return response; },
  };
  const handled = handler(
    { url: path } as IncomingMessage,
    response as unknown as ServerResponse,
    new URL(path, 'http://localhost'),
  );
  expect(handled).toBe(true);
  return { status, location };
}

describe('Astro site tree', () => {
  it('limits SPA fallbacks to generated Studio entries', async () => {
    const { publicDir, siteRoot } = siteFixture();
    const h = await startStaticServer({
      publicDir,
      port: 0,
      host: '127.0.0.1',
      portScanLimit: 200,
      logger: silentServeLogger(),
      namespaceHandler: createSiteTreeHandler(siteRoot, '0123456789abcdef'),
    });
    handles.push(h);

    const deep = await fetch(h.url + '/__pyric/ui/firestore/users/alice');
    const deepHtml = await deep.text();
    expect(deep.status).toBe(200);
    expect(deepHtml).toContain('FIRESTORE');
    expect(deepHtml).toContain('name="pyric-worker-v" content="0123456789abcdef"');
    expect(await (await fetch(h.url + '/__pyric/ui/storage/uploads/logo.png')).text()).toContain('STORAGE');

    expect((await fetch(h.url + '/__pyric/ui/')).status).toBe(200);
    expect((await fetch(h.url + '/__pyric/ui/home/anything')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/ui/_astro/app.js')).status).toBe(200);
    expect((await fetch(h.url + '/__pyric/ui/_astro/missing.js')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/ui/firestore/missing.js')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/ui/firestore/missing.css')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/ui/docs/missing')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/ui/docs/%E0%A4%A')).status).toBe(404);
    const handler = createSiteTreeHandler(siteRoot, '0123456789abcdef');
    const traversal = invokeRawPath(
      handler,
      '/__pyric/ui/%2e%2e%2f%2e%2e%2f%2e%2e%2ftmp',
    );
    expect(traversal.status).toBe(404);
    expect(traversal.location).toBeUndefined();
    expect(invokeRawPath(
      handler,
      '/__pyric/ui/firestore/%2e%2e/docs/index.json',
    ).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/ui/not-a-service')).status).toBe(404);

    const docsTwin = await fetch(h.url + '/__pyric/ui/docs/overview.md');
    expect(docsTwin.status).toBe(200);
    expect(await docsTwin.text()).toContain('# Overview');
    expect((await fetch(h.url + '/__pyric/ui/docs/index.json')).headers.get('content-type')).toContain('application/json');

    const docs = await (await fetch(h.url + '/__pyric/ui/docs/overview/')).text();
    expect(docs).toContain('DOCS');
    expect(docs).not.toContain('pyric-worker-v');
  });
});
