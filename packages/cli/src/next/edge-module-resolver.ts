/**
 * Filesystem, `package.json#imports`, `tsconfig.json`, and `node_modules`
 * specifier resolution for static Next.js Edge runtime module analysis.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

function tryRealFile(candidate: string): string | null {
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return realpathSync(candidate);
    }
  } catch {
    // Ignore broken links or unreadable entries.
  }
  return null;
}

function resolveCandidateFile(baseTarget: string): string | null {
  const direct = tryRealFile(baseTarget);
  if (direct !== null) return direct;
  const strippedExt = baseTarget.replace(/\.[cm]?[jt]sx?$/, '');
  for (const ext of SOURCE_EXTENSIONS) {
    const withExt = tryRealFile(`${baseTarget}${ext}`);
    if (withExt !== null) return withExt;
    if (strippedExt !== baseTarget) {
      const swappedExt = tryRealFile(`${strippedExt}${ext}`);
      if (swappedExt !== null) return swappedExt;
    }
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const indexFile = tryRealFile(join(baseTarget, `index${ext}`));
    if (indexFile !== null) return indexFile;
  }
  return null;
}

function defaultCompilerOptions(baseDir: string): ts.CompilerOptions {
  return {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    baseUrl: baseDir,
  };
}

function selectImportConditionTarget(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const map = entry as Record<string, unknown>;
  for (const key of ['import', 'module', 'node', 'default']) {
    if (key in map) {
      const hit = selectImportConditionTarget(map[key]);
      if (hit !== null) return hit;
    }
  }
  for (const val of Object.values(map)) {
    const hit = selectImportConditionTarget(val);
    if (hit !== null) return hit;
  }
  return null;
}

function resolveImportsMapTarget(baseDir: string, manifestPath: string, target: string): string | null {
  if (target.startsWith('.')) {
    return resolveCandidateFile(resolve(baseDir, target));
  }
  return resolveFromNodeModules(manifestPath, target);
}

function resolvePackageSubpathImport(fromFile: string, specifier: string): string | null {
  let current = dirname(resolve(fromFile));
  for (;;) {
    const manifestPath = join(current, 'package.json');
    if (tryRealFile(manifestPath) !== null) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          imports?: Record<string, unknown>;
        };
        const importsMap = manifest.imports;
        if (importsMap !== undefined && typeof importsMap === 'object' && importsMap !== null) {
          if (specifier in importsMap) {
            const target = selectImportConditionTarget(importsMap[specifier]);
            if (target !== null) {
              const resolvedTarget = resolveImportsMapTarget(current, manifestPath, target);
              if (resolvedTarget !== null) return resolvedTarget;
            }
          }
          for (const [pattern, rawTarget] of Object.entries(importsMap)) {
            const starIdx = pattern.indexOf('*');
            if (starIdx === -1) continue;
            const prefix = pattern.slice(0, starIdx);
            const suffix = pattern.slice(starIdx + 1);
            if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
            const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
            const target = selectImportConditionTarget(rawTarget);
            if (target === null) continue;
            const substituted = target.replaceAll('*', captured);
            const resolvedTarget = resolveImportsMapTarget(current, manifestPath, substituted);
            if (resolvedTarget !== null) return resolvedTarget;
          }
        }
      } catch {
        // Unreadable or invalid package.json; continue walking upward.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveFromNodeModules(fromFile: string, specifier: string): string | null {
  try {
    const resolved = createRequire(fromFile).resolve(specifier);
    return resolveCandidateFile(resolved);
  } catch {
    // Package entry may point to an uncompiled .ts file in a workspace package.
  }
  let current = dirname(resolve(fromFile));
  for (;;) {
    const pkgDir = join(current, 'node_modules', specifier);
    const directHit = resolveCandidateFile(pkgDir);
    if (directHit !== null) return directHit;
    const manifestPath = join(pkgDir, 'package.json');
    if (tryRealFile(manifestPath) !== null) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          exports?: unknown;
          module?: string;
          main?: string;
        };
        let entryRel: string | null = null;
        if (manifest.exports !== undefined && typeof manifest.exports === 'object' && manifest.exports !== null) {
          const exportsRec = manifest.exports as Record<string, unknown>;
          entryRel = selectImportConditionTarget('.' in exportsRec ? exportsRec['.'] : manifest.exports);
        }
        if (entryRel === null && typeof manifest.module === 'string') {
          entryRel = manifest.module;
        }
        if (entryRel === null && typeof manifest.main === 'string') {
          entryRel = manifest.main;
        }
        if (entryRel !== null) {
          const candidate = resolveCandidateFile(resolve(pkgDir, entryRel));
          if (candidate !== null) return candidate;
        }
      } catch {
        // Ignore invalid workspace manifest.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function createProjectModuleResolver(
  projectRoot: string,
): (fromFile: string, specifier: string) => string | null {
  const rootDir = resolve(projectRoot);
  const configMemo = new Map<string, ts.CompilerOptions>();

  const moduleHost: ts.ModuleResolutionHost = {
    fileExists: (filePath) => existsSync(filePath),
    readFile: (filePath) => {
      try {
        return readFileSync(filePath, 'utf8');
      } catch {
        return undefined;
      }
    },
    directoryExists: (dirPath) => {
      try {
        return existsSync(dirPath) && statSync(dirPath).isDirectory();
      } catch {
        return false;
      }
    },
    realpath: (filePath) => {
      try {
        return realpathSync(filePath);
      } catch {
        return filePath;
      }
    },
    getCurrentDirectory: () => rootDir,
    useCaseSensitiveFileNames: true,
  };

  const parseConfigAt = (configFile: string): ts.CompilerOptions => {
    const cached = configMemo.get(configFile);
    if (cached !== undefined) return cached;
    const configDir = dirname(configFile);
    const fallback = defaultCompilerOptions(configDir);
    const read = ts.readConfigFile(configFile, (filePath) => moduleHost.readFile(filePath));
    if (read.error !== undefined || !read.config) {
      configMemo.set(configFile, fallback);
      return fallback;
    }
    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [],
      fileExists: (filePath) => moduleHost.fileExists(filePath),
      readFile: (filePath) => moduleHost.readFile(filePath),
    };
    const parsed = ts.parseJsonConfigFileContent(read.config, parseHost, configDir, undefined, configFile);
    const merged: ts.CompilerOptions = {
      ...parsed.options,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
    };
    configMemo.set(configFile, merged);
    return merged;
  };

  const compilerOptionsForDir = (startDir: string): ts.CompilerOptions => {
    let current = resolve(startDir);
    for (;;) {
      for (const configName of ['tsconfig.json', 'jsconfig.json']) {
        const candidate = join(current, configName);
        if (tryRealFile(candidate) !== null) {
          return parseConfigAt(candidate);
        }
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return defaultCompilerOptions(rootDir);
  };

  return (fromFile: string, specifier: string): string | null => {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      return resolveCandidateFile(resolve(dirname(fromFile), specifier));
    }
    if (specifier.startsWith('#')) {
      const subpathHit = resolvePackageSubpathImport(fromFile, specifier);
      if (subpathHit !== null) return subpathHit;
    }
    const options = compilerOptionsForDir(dirname(fromFile));
    const resolved = ts.resolveModuleName(specifier, fromFile, options, moduleHost).resolvedModule;
    if (resolved !== undefined) {
      const realResolved = resolveCandidateFile(resolved.resolvedFileName);
      if (realResolved !== null) return realResolved;
    }
    return resolveFromNodeModules(fromFile, specifier);
  };
}
