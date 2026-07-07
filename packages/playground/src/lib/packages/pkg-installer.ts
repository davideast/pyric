/**
 * ESM-CDN package installer. "Install" here means:
 *
 *   1. Resolve the user-supplied `name@range` to an exact pinned
 *      version through the esm.sh redirect chain.
 *   2. Record the package + canonical CDN URL in a registry file in
 *      the VFS (`/packages/registry.json`).
 *   3. Maintain a mirrored import map (`/packages/import-map.json`)
 *      that the esbuild CDN plugin (preview + deploy) reads at build
 *      time and the preview iframe injects at runtime.
 *
 * No package source is downloaded — the browser fetches the module
 * from esm.sh on demand the same way the deploy import map already
 * does for `react` / `firebase/*`.
 */

import { getVFS, type OPFSPromisesAPI } from '~/lib/vfs';

const REGISTRY_PATH = '/packages/registry.json';
const IMPORT_MAP_PATH = '/packages/import-map.json';
const ESM_CDN = 'https://esm.sh';

export interface InstalledPackage {
  name: string;
  /** Resolved exact version (no semver range). */
  version: string;
  /** Canonical CDN URL — what goes into the import map. */
  cdnUrl: string;
}

export interface PackageRegistry {
  packages: Record<string, InstalledPackage>;
}

export interface InstallSpec {
  name: string;
  /** Semver range or exact version. Defaults to `latest`. */
  version?: string;
}

async function readJsonFile<T>(promises: OPFSPromisesAPI, path: string): Promise<T | null> {
  try {
    const text = await promises.readFile(path, 'utf8');
    if (typeof text !== 'string') return null;
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJsonFile(
  promises: OPFSPromisesAPI,
  path: string,
  value: unknown,
): Promise<void> {
  try {
    await promises.mkdir('/packages', { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  await promises.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadRegistry(): Promise<PackageRegistry> {
  const adapter = getVFS();
  const existing = await readJsonFile<PackageRegistry>(adapter.promises, REGISTRY_PATH);
  return existing ?? { packages: {} };
}

async function saveRegistry(registry: PackageRegistry): Promise<void> {
  const adapter = getVFS();
  await writeJsonFile(adapter.promises, REGISTRY_PATH, registry);
  const importMap: Record<string, string> = {};
  for (const pkg of Object.values(registry.packages)) {
    importMap[pkg.name] = pkg.cdnUrl;
  }
  await writeJsonFile(adapter.promises, IMPORT_MAP_PATH, { imports: importMap });
}

/**
 * Parse the canonical pinned name + version from an esm.sh response
 * URL like `https://esm.sh/v135/lodash-es@4.17.21/es2022/lodash-es.mjs`.
 * esm.sh also serves direct URLs without the `/v{N}/` prefix; we
 * accept those too.
 */
function extractNameAndVersion(responseUrl: string, requestedName: string): string | null {
  // Try `/v{N}/{name}@{version}/`
  const versionedMatch = responseUrl.match(/\/v\d+\/(@[^/]+\/[^@]+|[^@/]+)@([^/]+)\//);
  if (versionedMatch && versionedMatch[1] === requestedName) {
    return versionedMatch[2];
  }
  // Try direct `/{name}@{version}` without `/v{N}/`
  const directMatch = responseUrl.match(/esm\.sh\/(@[^/]+\/[^@]+|[^@/]+)@([^/?]+)/);
  if (directMatch && directMatch[1] === requestedName) {
    return directMatch[2];
  }
  return null;
}

export async function installPackage(spec: InstallSpec): Promise<InstalledPackage> {
  const requested = spec.version ?? 'latest';
  const probeUrl = `${ESM_CDN}/${spec.name}@${requested}`;
  // HEAD follows redirects; the final URL pins the resolved version.
  const probe = await fetch(probeUrl, { method: 'HEAD', redirect: 'follow' });
  if (!probe.ok) {
    throw new Error(
      `Failed to resolve ${spec.name}@${requested} from esm.sh: ${probe.status} ${probe.statusText}`,
    );
  }
  const exact = extractNameAndVersion(probe.url, spec.name);
  if (!exact) {
    throw new Error(
      `Could not extract version for ${spec.name}@${requested} (resolved URL: ${probe.url})`,
    );
  }
  const cdnUrl = `${ESM_CDN}/${spec.name}@${exact}`;
  const entry: InstalledPackage = { name: spec.name, version: exact, cdnUrl };
  const registry = await loadRegistry();
  registry.packages[spec.name] = entry;
  await saveRegistry(registry);
  return entry;
}

export async function uninstallPackage(name: string): Promise<void> {
  const registry = await loadRegistry();
  if (!(name in registry.packages)) return;
  delete registry.packages[name];
  await saveRegistry(registry);
}

export async function getRegistry(): Promise<Record<string, InstalledPackage>> {
  const registry = await loadRegistry();
  return registry.packages;
}

export async function getImportMap(): Promise<Record<string, string>> {
  const adapter = getVFS();
  const map = await readJsonFile<{ imports?: Record<string, string> }>(
    adapter.promises,
    IMPORT_MAP_PATH,
  );
  return map?.imports ?? {};
}
