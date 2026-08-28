import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KNOWN_ENTRIES: Record<string, string[]> = {
  firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'],
  'firebase-admin': ['firebase-admin', 'firebase-admin/app'],
  'firebase-functions': ['firebase-functions'],
};

const versionCache = new Map<string, string>();
const pathCache = new Map<string, string>();

/**
 * Ascends from a resolved entrypoint file path to locate the enclosing package.json
 * whose "name" matches `pkgName`.
 */
export function resolvePackageJsonPath(pkgName: string, parentUrl: string = import.meta.url): string {
  const cacheKey = `${pkgName}::${parentUrl}`;
  if (pathCache.has(cacheKey)) return pathCache.get(cacheKey)!;

  const candidates = KNOWN_ENTRIES[pkgName] ?? [pkgName, `${pkgName}/app`];
  let resolvedUrl: string | undefined;
  let lastError: Error | undefined;

  for (const entry of candidates) {
    try {
      resolvedUrl = import.meta.resolve(entry, parentUrl);
      if (resolvedUrl) break;
    } catch (err) {
      lastError = err as Error;
    }
  }

  if (!resolvedUrl) {
    throw new Error(
      `Could not resolve any public entrypoint for package "${pkgName}". Last error: ${lastError?.message}`,
    );
  }

  const filePath = fileURLToPath(resolvedUrl);
  let currentDir = dirname(filePath);

  while (currentDir !== dirname(currentDir)) {
    const candidate = join(currentDir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const content = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (content.name === pkgName) {
          pathCache.set(cacheKey, candidate);
          return candidate;
        }
      } catch {
        // Continue climbing if package.json is unparseable or irrelevant
      }
    }
    currentDir = dirname(currentDir);
  }

  throw new Error(`Walked up to filesystem root without finding matching package.json for "${pkgName}".`);
}

/**
 * Returns the parsed `version` string from the target package's `package.json`.
 */
export function resolvePackageVersion(pkgName: string, parentUrl: string = import.meta.url): string {
  const cacheKey = `${pkgName}::${parentUrl}`;
  if (versionCache.has(cacheKey)) return versionCache.get(cacheKey)!;

  const pkgJsonPath = resolvePackageJsonPath(pkgName, parentUrl);
  const meta = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: unknown };

  if (typeof meta.version !== 'string' || meta.version.length === 0) {
    throw new Error(`Package manifest at ${pkgJsonPath} missing valid "version" string.`);
  }

  versionCache.set(cacheKey, meta.version);
  return meta.version;
}

/** Resolved (installed) `firebase` client SDK version. */
export function resolvedFirebaseVersion(parentUrl?: string): string {
  return resolvePackageVersion('firebase', parentUrl);
}

/** Resolved (installed) `firebase-admin` server SDK version. */
export function resolvedAdminVersion(parentUrl?: string): string {
  return resolvePackageVersion('firebase-admin', parentUrl);
}

/** Resolved (installed) `firebase-functions` SDK version. */
export function resolvedFunctionsVersion(parentUrl?: string): string {
  return resolvePackageVersion('firebase-functions', parentUrl);
}
