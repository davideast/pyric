/**
 * Browser-clean filesystem builtins, project-root path containment, and
 * `rules_version = '2+modules'` source bundling for `rule-sources.ts`.
 */
import {
  resolveModulesBrowser,
  resolveModulesWithFiles,
} from '../../rules/internal/index.js';
import {
  expandBareModuleImports,
  isModularRulesSource,
  lookupInMemoryModule,
  preNormalizeModularSyntax,
  restoreDefaultDbSentinelText,
} from './rules-ast-utils.js';

export interface NodeFsBuiltin {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  lstatSync?: (path: string) => { isSymbolicLink(): boolean };
  realpathSync?: (path: string) => string;
}

export interface NodePathBuiltin {
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  sep: string;
}

export interface RuleSourceBuiltins {
  readonly fs: NodeFsBuiltin;
  readonly path: NodePathBuiltin;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homedir?: () => string;
}

export function acquireRuleSourceBuiltins(): RuleSourceBuiltins | null {
  const proc = (
    globalThis as {
      process?: {
        getBuiltinModule?: (id: string) => unknown;
        env?: Readonly<Record<string, string | undefined>>;
      };
    }
  ).process;
  const get = proc?.getBuiltinModule;
  if (typeof get !== 'function') return null;
  const fs = get.call(proc, 'node:fs') as NodeFsBuiltin | undefined;
  const path = get.call(proc, 'node:path') as NodePathBuiltin | undefined;
  const os = get.call(proc, 'node:os') as { homedir?: () => string } | undefined;
  if (!fs || !path || typeof fs.readFileSync !== 'function') return null;
  const out: {
    fs: NodeFsBuiltin;
    path: NodePathBuiltin;
    env?: Readonly<Record<string, string | undefined>>;
    homedir?: () => string;
  } = { fs, path };
  if (proc?.env !== undefined) {
    out.env = proc.env;
  }
  if (typeof os?.homedir === 'function') {
    out.homedir = () => os.homedir!();
  }
  return out;
}

function isWithinRoot(
  pathMod: NodePathBuiltin,
  baseDir: string,
  targetPath: string,
): boolean {
  const relativePath = pathMod.relative(baseDir, targetPath);
  if (relativePath === '') return true;
  if (relativePath === '..') return false;
  if (
    relativePath.startsWith(`..${pathMod.sep}`)
    || relativePath.startsWith('../')
    || relativePath.startsWith('..\\')
  ) {
    return false;
  }
  return !pathMod.isAbsolute(relativePath);
}

export function assertNotSymlink(fsMod: NodeFsBuiltin, file: string): void {
  if (typeof fsMod.lstatSync !== 'function') return;
  if (fsMod.lstatSync(file).isSymbolicLink()) {
    throw new Error('Symbolic links are not followed');
  }
}

export function resolveRealRoot(fsMod: NodeFsBuiltin, absRoot: string): string {
  if (typeof fsMod.realpathSync !== 'function') return absRoot;
  try {
    return fsMod.realpathSync(absRoot);
  } catch {
    return absRoot;
  }
}

function assertNoSymlinkAncestors(
  fsMod: NodeFsBuiltin,
  pathMod: NodePathBuiltin,
  absRoot: string,
  realRoot: string | undefined,
  targetPath: string,
): void {
  if (typeof fsMod.lstatSync !== 'function') return;
  const relPath = pathMod.relative(absRoot, targetPath);
  const segments = relPath.split(/[\\/]+/).filter((part) => part.length > 0);
  let current = absRoot;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = pathMod.join(current, segments[i]!);
    let st: { isSymbolicLink(): boolean };
    try {
      st = fsMod.lstatSync(current);
    } catch {
      return;
    }
    if (realRoot !== undefined && typeof fsMod.realpathSync === 'function') {
      let realCurrent: string | undefined;
      try {
        realCurrent = fsMod.realpathSync(current);
      } catch {
        realCurrent = undefined;
      }
      if (realCurrent !== undefined && !isWithinRoot(pathMod, realRoot, realCurrent)) {
        throw new Error('Rule path escapes project root via symbolic link');
      }
    }
    if (st.isSymbolicLink()) {
      throw new Error('Symbolic links are not followed');
    }
  }
}

export function assertContainedProjectFile(
  fsMod: NodeFsBuiltin,
  pathMod: NodePathBuiltin,
  absRoot: string,
  realRoot: string,
  file: string,
): void {
  if (!isWithinRoot(pathMod, absRoot, file)) {
    throw new Error('Rule path escapes project root');
  }
  assertNoSymlinkAncestors(fsMod, pathMod, absRoot, realRoot, file);
  assertNotSymlink(fsMod, file);
  if (typeof fsMod.realpathSync === 'function' && fsMod.existsSync(file)) {
    const realFile = fsMod.realpathSync(file);
    if (!isWithinRoot(pathMod, realRoot, realFile)) {
      throw new Error('Rule path escapes project root via symbolic link');
    }
  }
}

export interface BundleRulesSourceOptions {
  readonly filePath?: string;
  readonly rootDir?: string;
  readonly sourceFile?: string;
  readonly targetService?: 'cloud.firestore' | 'firebase.storage';
  readonly modules?: Readonly<Record<string, string>>;
}

function readDiskRelativeModule(
  fsMod: NodeFsBuiltin,
  pathMod: NodePathBuiltin,
  baseDir: string,
  specifier: string,
  absRoot: string | undefined,
  realRoot: string | undefined,
  callerModules: Readonly<Record<string, string>> | undefined,
  visited = new Set<string>(),
): string | null {
  const fromMemory = lookupInMemoryModule(specifier, callerModules);
  const isStdlibAlias = /^\.\/stdlib\/(.+?)(?:\.rules)?$/.test(specifier);
  if (fromMemory !== null && !specifier.startsWith('./') && !specifier.startsWith('../')) {
    return fromMemory;
  }
  if (callerModules !== undefined && lookupInMemoryModule(specifier, callerModules) !== null) {
    const rawMem = lookupInMemoryModule(specifier, callerModules)!;
    const expandedMem = expandBareModuleImports(rawMem, (nested) =>
      lookupInMemoryModule(nested, callerModules),
    );
    return preNormalizeModularSyntax(expandedMem);
  }

  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return fromMemory;
  }

  const fileName = specifier.endsWith('.rules') ? specifier : `${specifier}.rules`;
  const candidate = pathMod.resolve(baseDir, fileName);

  if (absRoot !== undefined) {
    if (!isWithinRoot(pathMod, absRoot, candidate)) {
      throw new Error('Rule path escapes project root');
    }
    assertNoSymlinkAncestors(fsMod, pathMod, absRoot, realRoot, candidate);
  } else if (isWithinRoot(pathMod, baseDir, candidate)) {
    assertNoSymlinkAncestors(fsMod, pathMod, baseDir, undefined, candidate);
  }

  if (typeof fsMod.lstatSync === 'function') {
    let stat: { isSymbolicLink(): boolean };
    try {
      stat = fsMod.lstatSync(candidate);
    } catch {
      if (isStdlibAlias) return fromMemory;
      return null;
    }
    if (stat.isSymbolicLink()) {
      throw new Error('Symbolic links are not followed');
    }
  } else if (!fsMod.existsSync(candidate)) {
    if (isStdlibAlias) return fromMemory;
    return null;
  }

  if (
    absRoot !== undefined
    && realRoot !== undefined
    && typeof fsMod.realpathSync === 'function'
  ) {
    const realCandidate = fsMod.realpathSync(candidate);
    if (!isWithinRoot(pathMod, realRoot, realCandidate)) {
      throw new Error('Rule path escapes project root via symbolic link');
    }
  }

  const rawText = fsMod.readFileSync(candidate, 'utf8');
  if (visited.has(candidate)) return preNormalizeModularSyntax(rawText);
  const nextVisited = new Set(visited);
  nextVisited.add(candidate);
  const candidateDir = pathMod.dirname(candidate);
  const expanded = expandBareModuleImports(rawText, (nested) =>
    readDiskRelativeModule(
      fsMod,
      pathMod,
      candidateDir,
      nested,
      absRoot,
      realRoot,
      callerModules,
      nextVisited,
    ),
  );
  return preNormalizeModularSyntax(expanded);
}

/**
 * Bundle a `rules_version = '2+modules'` Firestore or Storage ruleset into a
 * self-contained `rules_version = '2'` source string (resolving stdlib and
 * relative `.rules` module imports). Non-modular sources are returned verbatim.
 */
export function bundleRulesSource(
  source: string,
  options?: BundleRulesSourceOptions,
): string {
  if (!isModularRulesSource(source)) return source;

  let preparedModules: Record<string, string> | undefined;
  if (options?.modules !== undefined) {
    preparedModules = {};
    for (const [key, rawMod] of Object.entries(options.modules)) {
      if (typeof rawMod !== 'string') continue;
      const expandedMod = expandBareModuleImports(rawMod, (spec) =>
        lookupInMemoryModule(spec, options.modules),
      );
      Object.defineProperty(preparedModules, key, {
        value: preNormalizeModularSyntax(expandedMod),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  let builtins: RuleSourceBuiltins | null = null;
  if (options?.filePath !== undefined) {
    builtins = acquireRuleSourceBuiltins();
  }
  if (builtins !== null && options?.filePath !== undefined) {
    const { fs: fsMod, path: pathMod } = builtins;
    const absFile = pathMod.resolve(options.filePath);
    const baseDir = pathMod.dirname(absFile);
    let absRoot: string | undefined;
    if (options.rootDir !== undefined) {
      absRoot = pathMod.resolve(options.rootDir);
    }
    let realRoot: string | undefined;
    if (absRoot !== undefined) {
      realRoot = resolveRealRoot(fsMod, absRoot);
    }

    const expandedSource = expandBareModuleImports(source, (spec) =>
      readDiskRelativeModule(
        fsMod,
        pathMod,
        baseDir,
        spec,
        absRoot,
        realRoot,
        options.modules,
      ),
    );
    const preNormalized = preNormalizeModularSyntax(expandedSource);
    const resolveOpts: {
      basePath: string;
      modules?: Record<string, string>;
      sourceFile?: string;
      targetService?: 'cloud.firestore' | 'firebase.storage';
    } = { basePath: baseDir };
    if (preparedModules !== undefined) resolveOpts.modules = preparedModules;
    if (options.sourceFile !== undefined) resolveOpts.sourceFile = options.sourceFile;
    if (options.targetService !== undefined) resolveOpts.targetService = options.targetService;

    const resolved = resolveModulesWithFiles(
      preNormalized,
      (base, modName) =>
        readDiskRelativeModule(
          fsMod,
          pathMod,
          base,
          modName,
          absRoot,
          realRoot,
          options.modules,
        ),
      resolveOpts,
    );
    if (!resolved.success) {
      throw new Error(resolved.error.message);
    }
    return restoreDefaultDbSentinelText(resolved.data.resolved);
  }

  const expandedSource = expandBareModuleImports(source, (spec) =>
    lookupInMemoryModule(spec, preparedModules ?? options?.modules),
  );
  const preNormalized = preNormalizeModularSyntax(expandedSource);
  const browserOpts: {
    modules?: Record<string, string>;
    sourceFile?: string;
    targetService?: 'cloud.firestore' | 'firebase.storage';
  } = {};
  if (preparedModules !== undefined) browserOpts.modules = preparedModules;
  if (options?.sourceFile !== undefined) browserOpts.sourceFile = options.sourceFile;
  if (options?.targetService !== undefined) browserOpts.targetService = options.targetService;

  const resolved = resolveModulesBrowser(preNormalized, browserOpts);
  if (!resolved.success) {
    throw new Error(resolved.error.message);
  }
  return restoreDefaultDbSentinelText(resolved.data.resolved);
}
