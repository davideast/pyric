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

  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    // URL parsing normalizes encoded dot segments before `url.pathname`
    // reaches us. Route and validate against the raw request target so an
    // encoded traversal cannot cross from Studio into docs or static assets.
    const rawPathname = (req.url ?? url.pathname).split('?', 1)[0] ?? url.pathname;
    if (rawPathname !== '/__pyric/ui' && !rawPathname.startsWith('/__pyric/ui/')) {
      return false;
    }
    if (rawPathname === '/__pyric/ui') {
      res.writeHead(301, { location: '/__pyric/ui/' }).end();
      return true;
    }

    const rel = rawPathname.slice('/__pyric/ui'.length) || '/';
    const decodedRel = decodeStaticPathname(rel);
    if (decodedRel === null || decodedRel.includes('\\')) {
      res.writeHead(404).end('not found');
      return true;
    }
    const decodedSegments = decodedRel.split('/').filter(Boolean);
    if (decodedSegments.some((segment) => segment === '.' || segment === '..')) {
      res.writeHead(404).end('not found');
      return true;
    }
    if (!rel.endsWith('/') && !extname(rel)) {
      const dir = resolveStaticPath(root, rel);
      if (dir && existsSync(dir) && statSync(dir).isDirectory()) {
        res.writeHead(301, { location: `${rawPathname}/` }).end();
        return true;
      }
    }

    const first = decodedSegments[0];
    const studioRequest = first === undefined || studioRoutes.has(first);
    let file = resolveStaticFile(root, rel);
    // Storage object names commonly contain extensions (logo.png), while the
    // other Studio routes reserve extension-bearing misses for static assets.
    const allowsDottedState = first === 'storage';
    const hasDottedStateSegment = decodedSegments
      .slice(1)
      .some((segment) => segment.includes('.'));
    if (!file && studioRequest && (allowsDottedState || !hasDottedStateSegment)) {
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
