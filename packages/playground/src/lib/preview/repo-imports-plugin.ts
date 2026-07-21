import type { Loader, Plugin } from 'esbuild-wasm';

import { listAllFiles } from '~/lib/files/file-tree';
import { getVFS } from '~/lib/vfs';

import { pickVfsFile } from './vfs-load-plugin';

const CDN_NAMESPACE = 'pyric-repo-cdn';
const CDN_ORIGIN = 'https://esm.sh';

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] ?? specifier;
}

function packageSubpath(specifier: string, name: string): string {
  return specifier === name ? '' : specifier.slice(name.length);
}

function cleanVersion(version: string): string {
  return version.trim() || 'latest';
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await getVFS().promises.readFile(path, 'utf8');
    return JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

function importTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return importTarget(record.browser) ?? importTarget(record.import) ?? importTarget(record.default);
}

async function sourceForExport(packageRoot: string, target: string): Promise<string | null> {
  const relative = target.replace(/^\.\//, '').replace(/^dist\//, 'src/');
  const absolute = `${packageRoot}/${relative}`;
  return pickVfsFile([
    absolute,
    ...(absolute.endsWith('.js')
      ? [`${absolute.slice(0, -3)}.ts`, `${absolute.slice(0, -3)}.tsx`]
      : []),
  ]);
}

/** Resolve workspace package exports to their cloned source modules. */
export async function discoverWorkspacePackageExports(): Promise<Map<string, string>> {
  const files = await listAllFiles('/workspace');
  const manifests = files.filter((path) =>
    /^\/workspace\/(?:packages|examples)\/[^/]+\/package\.json$/.test(path),
  );
  const resolved = new Map<string, string>();
  await Promise.all(manifests.map(async (manifestPath) => {
    const manifest = await readJson(manifestPath);
    const name = typeof manifest?.name === 'string' ? manifest.name : null;
    const exports = manifest?.exports;
    if (!name || !exports || typeof exports !== 'object') return;
    const root = manifestPath.slice(0, -'/package.json'.length);
    await Promise.all(Object.entries(exports as Record<string, unknown>).map(async ([key, value]) => {
      const target = importTarget(value);
      if (!target) return;
      const source = await sourceForExport(root, target);
      if (!source) return;
      resolved.set(key === '.' ? name : `${name}${key.slice(1)}`, source);
    }));
  }));
  return resolved;
}

/** Read dependency versions from the package that owns the selected entry. */
export async function dependenciesForEntry(entryPath: string): Promise<Map<string, string>> {
  const srcAt = entryPath.lastIndexOf('/src/');
  const root = srcAt >= 0 ? entryPath.slice(0, srcAt) : '/workspace';
  const files = await listAllFiles('/workspace');
  const manifestPaths = files.filter((path) => path.endsWith('/package.json'));
  const manifests = await Promise.all(manifestPaths.map(readJson));
  const dependencies: Record<string, string> = {};
  for (const manifest of manifests) {
    Object.assign(
      dependencies,
      (manifest?.dependencies as Record<string, string> | undefined) ?? {},
      (manifest?.devDependencies as Record<string, string> | undefined) ?? {},
    );
  }
  const entryManifest = await readJson(`${root}/package.json`);
  Object.assign(
    dependencies,
    (entryManifest?.dependencies as Record<string, string> | undefined) ?? {},
    (entryManifest?.devDependencies as Record<string, string> | undefined) ?? {},
  );
  return new Map(Object.entries(dependencies).filter(([, version]) => !version.startsWith('workspace:')));
}

function cdnUrl(specifier: string, dependencies: ReadonlyMap<string, string>): string | null {
  const name = packageName(specifier);
  const version = dependencies.get(name) ?? 'latest';
  const subpath = packageSubpath(specifier, name);
  return `${CDN_ORIGIN}/${name}@${cleanVersion(version)}${subpath}?bundle&external=react,react-dom`;
}

function loaderForResponse(url: string, contentType: string | null): Loader {
  if (contentType?.includes('text/css') || new URL(url).pathname.endsWith('.css')) return 'css';
  return 'js';
}

/** Fetch and bundle normal package dependencies while React stays host-virtualized. */
export function repoCdnPlugin(dependencies: ReadonlyMap<string, string>): Plugin {
  return {
    name: 'pyric-repo-cdn',
    setup(build) {
      build.onResolve({ filter: /^node:/ }, (args) => ({
        path: args.path,
        namespace: `${CDN_NAMESPACE}-node`,
      }));
      build.onResolve({ filter: /^[^./~]/ }, (args) => {
        if (args.path === 'react' || args.path.startsWith('react/')) return null;
        if (args.path === 'react-dom' || args.path.startsWith('react-dom/')) return null;
        if (args.path.endsWith('?url')) {
          const withoutQuery = args.path.slice(0, -'?url'.length);
          const url = cdnUrl(withoutQuery, dependencies);
          return url ? { path: url, namespace: `${CDN_NAMESPACE}-url` } : null;
        }
        const url = cdnUrl(args.path, dependencies);
        return url ? { path: url, namespace: CDN_NAMESPACE } : null;
      });
      build.onResolve({ filter: /^https:\/\/esm\.sh\// }, (args) => ({
        path: args.path,
        namespace: CDN_NAMESPACE,
      }));
      build.onResolve({ filter: /^\/node\/process\.mjs$/ }, (args) => {
        if (args.namespace !== CDN_NAMESPACE) return null;
        return { path: 'node:process', namespace: `${CDN_NAMESPACE}-node` };
      });
      build.onResolve({ filter: /^\// }, (args) => {
        if (args.namespace !== CDN_NAMESPACE) return null;
        return { path: new URL(args.path, CDN_ORIGIN).href, namespace: CDN_NAMESPACE };
      });
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.namespace !== CDN_NAMESPACE) return null;
        return { path: new URL(args.path, args.importer).href, namespace: CDN_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: `${CDN_NAMESPACE}-node` }, (args) => ({
        contents: args.path === 'node:dns/promises'
          ? 'export async function lookup() { throw new Error("DNS is unavailable in browser preview"); } export default { lookup };'
          : args.path === 'node:process'
            ? 'export const env = {}; export const argv = []; export const cwd = () => "/workspace"; const process = { env, argv, cwd, browser: true }; export default process;'
            : 'const unavailable = new Proxy({}, { get() { throw new Error("Node built-in unavailable in browser preview"); } }); export default unavailable;',
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: `${CDN_NAMESPACE}-url` }, (args) => ({
        contents: `export default ${JSON.stringify(args.path.replace(/\?.*$/, ''))};`,
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: CDN_NAMESPACE }, async (args) => {
        const response = await fetch(args.path);
        if (!response.ok) throw new Error(`esm.sh ${response.status} for ${args.path}`);
        return {
          contents: await response.text(),
          loader: loaderForResponse(args.path, response.headers.get('content-type')),
        };
      });
    },
  };
}
