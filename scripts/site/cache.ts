#!/usr/bin/env bun
/**
 * Content-keyed site build cache.
 *
 * Caches compiled Astro site outputs under `node_modules/.cache/pyric-site/<fingerprint>/`
 * to avoid re-compiling static site assets when source content has not changed.
 */
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const DEFAULT_CACHE_ROOT = join(ROOT, 'node_modules', '.cache', 'pyric-site');
const SITE_CACHE_REV = 1;

export interface SiteCacheOptions {
  base?: string;
  studioStatic?: boolean;
  cacheRoot?: string;
  cacheRev?: number;
}

export interface BuildSiteOptions extends SiteCacheOptions {
  outDir?: string;
  forceRebuild?: boolean;
}

/**
 * Returns list of source paths relevant to static site asset compilation.
 */
export function getSiteSourceFiles(root = ROOT): string[] {
  const targets = [
    'packages/site-docs',
    'packages/studio',
    'packages/ui',
    'packages/conformance',
    'packages/pyric/docs',
    'packages/cli/docs',
    'bun.lock',
  ];

  try {
    const stdout = execSync(
      `git ls-files -c -o --exclude-standard -- ${targets.join(' ')}`,
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && isCacheableSourceFile(s));
  } catch {
    // Fallback if git command fails (e.g. not a git repo)
    const files: string[] = [];
    for (const target of targets) {
      const fullPath = join(root, target);
      if (!existsSync(fullPath)) continue;
      const stat = statSync(fullPath);
      if (stat.isFile()) {
        if (isCacheableSourceFile(target)) files.push(target);
      } else if (stat.isDirectory()) {
        walkDir(fullPath, (filePath) => {
          const rel = relative(root, filePath);
          if (isCacheableSourceFile(rel)) files.push(rel);
        });
      }
    }
    return files;
  }
}

function isCacheableSourceFile(relPath: string): boolean {
  // Exclude build outputs, astro caches, and temp test artifacts
  if (
    relPath.includes('/dist/') ||
    relPath.includes('/.astro/') ||
    relPath.includes('/node_modules/') ||
    relPath.includes('/test-results/') ||
    relPath.endsWith('.log')
  ) {
    return false;
  }
  return true;
}

function walkDir(dir: string, callback: (filePath: string) => void): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'dist' ||
        entry.name === '.astro' ||
        entry.name === 'node_modules' ||
        entry.name === '.git'
      ) {
        continue;
      }
      walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

/**
 * Calculates a SHA256 fingerprint key based on source content and environment configuration.
 */
export function computeFingerprint(opts: SiteCacheOptions = {}, root = ROOT): string {
  const base = opts.base ?? '/__pyric/ui/';
  const studioStatic = opts.studioStatic ?? false;
  const cacheRev = opts.cacheRev ?? SITE_CACHE_REV;

  const files = getSiteSourceFiles(root).sort();
  const fileHash = createHash('sha256');

  for (const file of files) {
    const fullPath = join(root, file);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath);
      fileHash.update(file);
      fileHash.update('\0');
      fileHash.update(content);
      fileHash.update('\0');
    } catch {
      // Ignore unreadable file
    }
  }

  const finalHash = createHash('sha256');
  finalHash.update(`REV=${cacheRev}\n`);
  finalHash.update(`BASE=${base}\n`);
  finalHash.update(`STUDIO_STATIC=${studioStatic ? '1' : '0'}\n`);
  finalHash.update(fileHash.digest('hex'));

  return finalHash.digest('hex');
}

export function getCacheDir(key: string, cacheRoot = DEFAULT_CACHE_ROOT): string {
  return join(cacheRoot, key);
}

export function isCacheValid(key: string, cacheRoot = DEFAULT_CACHE_ROOT): boolean {
  const cacheDir = getCacheDir(key, cacheRoot);
  const completeFile = join(cacheDir, '.complete');
  const distDir = join(cacheDir, 'site-dist');
  return existsSync(completeFile) && existsSync(distDir);
}

export function restoreSiteCache(
  key: string,
  targetDir: string,
  cacheRoot = DEFAULT_CACHE_ROOT,
): boolean {
  if (!isCacheValid(key, cacheRoot)) return false;
  const srcDist = join(getCacheDir(key, cacheRoot), 'site-dist');

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  cpSync(srcDist, targetDir, { recursive: true });
  return true;
}

export function saveSiteCache(
  key: string,
  sourceDir: string,
  cacheRoot = DEFAULT_CACHE_ROOT,
): void {
  const cacheDir = getCacheDir(key, cacheRoot);
  const targetDist = join(cacheDir, 'site-dist');

  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(targetDist, { recursive: true });
  cpSync(sourceDir, targetDist, { recursive: true });
  writeFileSync(join(cacheDir, '.complete'), new Date().toISOString(), 'utf8');
}

export function clearSiteCache(cacheRoot = DEFAULT_CACHE_ROOT): void {
  rmSync(cacheRoot, { recursive: true, force: true });
}

export async function buildSiteWithCache(opts: BuildSiteOptions = {}): Promise<{
  cached: boolean;
  key: string;
}> {
  const base = opts.base ?? '/__pyric/ui/';
  const studioStatic = opts.studioStatic ?? false;
  const cacheRoot = opts.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const siteDocsDist = join(ROOT, 'packages', 'site-docs', 'dist');
  const targetOutDir = opts.outDir ? resolve(opts.outDir) : null;

  const key = computeFingerprint({ base, studioStatic, cacheRoot }, ROOT);

  if (!opts.forceRebuild && isCacheValid(key, cacheRoot)) {
    console.log(`▸ Restored site build from cache (key: ${key.slice(0, 12)})`);
    restoreSiteCache(key, siteDocsDist, cacheRoot);
    if (targetOutDir && targetOutDir !== siteDocsDist) {
      rmSync(targetOutDir, { recursive: true, force: true });
      mkdirSync(targetOutDir, { recursive: true });
      cpSync(siteDocsDist, targetOutDir, { recursive: true });
    }
    return { cached: true, key };
  }

  console.log(`▸ Building packages/site-docs (base: ${base})`);
  rmSync(siteDocsDist, { recursive: true, force: true });

  const { $ } = await import('bun');
  const siteDir = join(ROOT, 'packages', 'site-docs');
  await $`bun run --cwd ${siteDir} build`.env({
    ...process.env,
    DOCS_BASE: base,
    STUDIO_STATIC: studioStatic ? '1' : '0',
  });

  if (!existsSync(siteDocsDist)) {
    throw new Error(`Site build failed: ${siteDocsDist} was not created`);
  }

  saveSiteCache(key, siteDocsDist, cacheRoot);
  console.log(`▸ Cached site build (key: ${key.slice(0, 12)})`);

  if (targetOutDir && targetOutDir !== siteDocsDist) {
    rmSync(targetOutDir, { recursive: true, force: true });
    mkdirSync(targetOutDir, { recursive: true });
    cpSync(siteDocsDist, targetOutDir, { recursive: true });
  }

  return { cached: false, key };
}

// ── CLI Execution ────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'build';

  let base = '/__pyric/ui/';
  let studioStatic = false;
  let outDir: string | undefined;
  let force = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--base' && args[i + 1]) {
      base = args[++i];
    } else if (arg === '--out' && args[i + 1]) {
      outDir = args[++i];
    } else if (arg === '--studio-static') {
      studioStatic = true;
    } else if (arg === '--force' || arg === '--clean' || arg === '--no-cache') {
      force = true;
    }
  }

  switch (command) {
    case 'key': {
      console.log(computeFingerprint({ base, studioStatic }));
      break;
    }
    case 'clear': {
      clearSiteCache();
      console.log('✔ Site build cache cleared');
      break;
    }
    case 'restore': {
      const key = computeFingerprint({ base, studioStatic });
      const target = outDir ?? join(ROOT, 'packages', 'site-docs', 'dist');
      const restored = restoreSiteCache(key, target);
      if (restored) {
        console.log(`✔ Restored site build (key: ${key.slice(0, 12)}) → ${target}`);
      } else {
        console.log(`✗ Cache miss (key: ${key.slice(0, 12)})`);
        process.exit(1);
      }
      break;
    }
    case 'build': {
      if (force) {
        clearSiteCache();
      }
      await buildSiteWithCache({ base, studioStatic, outDir, forceRebuild: force });
      break;
    }
    default: {
      console.error(`Unknown site cache command: ${command}`);
      process.exit(1);
    }
  }
}
