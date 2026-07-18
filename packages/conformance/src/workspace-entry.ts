import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface PackageManifest {
  name: string;
  private?: boolean;
  exports?: Record<string, string | ExportConditions>;
  pyricUnreleasedExports?: string[];
}

interface ExportConditions {
  import?: string;
  node?: string | ExportConditions;
  default?: string | ExportConditions;
}

export interface WorkspaceEntryPaths {
  source: string;
  built: string;
}

function importTarget(value: string | ExportConditions | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (!value) return undefined;
  if (value.import) return value.import;
  return importTarget(value.node) ?? importTarget(value.default);
}

function workspacePackages(): Array<{ directory: string; manifest: PackageManifest }> {
  const packagesRoot = join(REPO_ROOT, 'packages');
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, 'package.json')))
    .map((entry) => ({
      directory: join(packagesRoot, entry.name),
      manifest: JSON.parse(readFileSync(join(packagesRoot, entry.name, 'package.json'), 'utf8')) as PackageManifest,
    }))
    .filter(({ manifest }) => typeof manifest.name === 'string' && manifest.private !== true)
    .sort((left, right) => right.manifest.name.length - left.manifest.name.length);
}

/**
 * Resolve a workspace package export to its TypeScript source entry.
 *
 * The conformance model is generated during the clean-checkout bootstrap,
 * before workspace `dist/` JavaScript exists. Published package specifiers
 * remain the canonical contract; this maps their manifest export target back
 * to the corresponding source barrel instead of maintaining a second list.
 */
export function workspaceEntryPaths(specifier: string): WorkspaceEntryPaths | null {
  const pkg = workspacePackages().find(({ manifest }) =>
    specifier === manifest.name || specifier.startsWith(`${manifest.name}/`),
  );
  if (!pkg) return null;
  const { directory, manifest } = pkg;
  const subpath = specifier === manifest.name ? '.' : `.${specifier.slice(manifest.name.length)}`;
  if (manifest.pyricUnreleasedExports?.includes(subpath)) return null;
  const published = importTarget(manifest.exports?.[subpath]);
  if (!published?.startsWith('./dist/') || !published.endsWith('.js')) return null;

  const sourceBase = join(directory, published.replace('./dist/', 'src/').replace(/\.js$/, ''));
  const source = ['.ts', '.tsx'].map((extension) => `${sourceBase}${extension}`).find(existsSync);
  return source ? { source, built: join(directory, published) } : null;
}

export function workspaceSourceEntry(specifier: string): string | null {
  return workspaceEntryPaths(specifier)?.source ?? null;
}
