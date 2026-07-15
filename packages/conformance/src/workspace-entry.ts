import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface PackageManifest {
  name: string;
  exports?: Record<string, { import?: string }>;
}

/**
 * Resolve a workspace package export to its TypeScript source entry.
 *
 * The conformance model is generated during the clean-checkout bootstrap,
 * before workspace `dist/` JavaScript exists. Published package specifiers
 * remain the canonical contract; this maps their manifest export target back
 * to the corresponding source barrel instead of maintaining a second list.
 */
export function workspaceSourceEntry(specifier: string): string | null {
  const packageDir = specifier === 'pyric' || specifier.startsWith('pyric/')
    ? 'pyric'
    : specifier === 'pyric-admin' || specifier.startsWith('pyric-admin/')
      ? 'pyric-admin'
      : null;
  if (!packageDir) return null;

  const manifestPath = join(REPO_ROOT, 'packages', packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  const subpath = specifier === manifest.name ? '.' : `.${specifier.slice(manifest.name.length)}`;
  const published = manifest.exports?.[subpath]?.import;
  if (!published?.startsWith('./dist/') || !published.endsWith('.js')) return null;

  const source = join(REPO_ROOT, 'packages', packageDir, published.replace('./dist/', 'src/').replace(/\.js$/, '.ts'));
  return existsSync(source) ? source : null;
}
