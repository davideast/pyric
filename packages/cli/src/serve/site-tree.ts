import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import {
  contentTypeFor,
  decodeStaticPathname,
  pipeFileToResponse,
  resolveStaticFile,
  resolveStaticPath,
} from './server.js';

interface StudioRoutesManifest {
  routes: string[];
}

function studioRoutesFromSite(root: string): ReadonlySet<string> {
  const manifestPath = join(root, 'studio-routes.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as StudioRoutesManifest;
  if (!Array.isArray(parsed.routes) || parsed.routes.some((route) => typeof route !== 'string')) {
    throw new Error(`pyric: invalid Studio route manifest at ${manifestPath}`);
  }
  return new Set(parsed.routes);
}

function withWorkerVersion(html: string, workerVersion: string | undefined): string {
  if (!workerVersion || html.includes('name="pyric-worker-v"')) return html;
  if (!/^[a-f0-9]{16}$/.test(workerVersion)) {
    throw new Error(`pyric: invalid SharedWorker epoch '${workerVersion}'`);
  }
  const meta = `<meta name="pyric-worker-v" content="${workerVersion}" data-pyric-serve>`;
  const head = html.match(/<head[^>]*>/i);
  if (!head || head.index === undefined) return meta + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + meta + html.slice(at);
}

/** Serve the one Astro tree with SPA fallback limited to generated Studio entries. */
export function createSiteTreeHandler(root: string, workerVersion?: string) {
  const studioRoutes = studioRoutesFromSite(root);

  return (_req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (url.pathname !== '/__pyric/ui' && !url.pathname.startsWith('/__pyric/ui/')) {
      return false;
    }
    if (url.pathname === '/__pyric/ui') {
      res.writeHead(301, { location: '/__pyric/ui/' }).end();
      return true;
    }

    const rel = url.pathname.slice('/__pyric/ui'.length) || '/';
    const decodedRel = decodeStaticPathname(rel);
    if (decodedRel === null) {
      res.writeHead(404).end('not found');
      return true;
    }
    if (!rel.endsWith('/') && !extname(rel)) {
      const dir = resolveStaticPath(root, rel);
      if (dir && existsSync(dir) && statSync(dir).isDirectory()) {
        res.writeHead(301, { location: `${url.pathname}/` }).end();
        return true;
      }
    }

    const first = rel.split('/').filter(Boolean)[0];
    const studioRequest = first === undefined || studioRoutes.has(first);
    let file = resolveStaticFile(root, rel);
    if (!file && studioRequest) {
      const entry = first === undefined ? '/index.html' : `/${first}/index.html`;
      file = resolveStaticFile(root, entry);
    }
    if (!file) {
      res.writeHead(404).end('not found');
      return true;
    }

    const contentType = contentTypeFor(file);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    if (studioRequest && contentType.includes('text/html')) {
      res.end(withWorkerVersion(readFileSync(file, 'utf8'), workerVersion));
    } else {
      pipeFileToResponse(file, res);
    }
    return true;
  };
}
