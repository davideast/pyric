/**
 * Builds TypeScript programs for an app's source so the evaluator can use
 * the checker to resolve identifiers across files, path aliases, and
 * re-exports.
 *
 * Browser-clean: in-memory `{ root, files }` mode never touches `node:*`,
 * `ts.sys`, or `process`. Disk mode acquires filesystem access lazily via
 * `acquireDiskAdapter()`.
 */
import ts from 'typescript';
import { acquireDiskAdapter, type DiskAdapter } from './node-walk.js';
import { posixDirname, posixRelative, posixResolve, toPosixPath } from './posix-path.js';

/** One program and the files it owns for site scanning. */
export interface ScanProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Source files this program scans (each file is scanned by one program). */
  files: ts.SourceFile[];
  /** tsconfig path relative to root, or `<default>`. */
  config: string;
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TSCONFIG_PATH = /(?:^|\/)tsconfig(?:\.[\w-]+)?\.json$/;

/**
 * Paths matching any of these are not scanned for sites by default:
 * declaration files, and test and test-harness code, whose writes are
 * fixtures rather than app behaviour.
 */
const DEFAULT_EXCLUDES: RegExp[] = [
  /\.d\.[cm]?ts$/,
  /\.(?:test|spec|pw)\.[cm]?[jt]sx?$/,
  /(?:^|\/)(?:__tests__|__mocks__|test|tests)\//,
  /\.min\.[cm]?js$/,
];

/** Files larger than this are bundles or vendored builds, not app source. */
const MAX_SOURCE_BYTES = 400_000;

/** Options shared by every program; overrides what a tsconfig says where it matters. */
function baseOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    resolveJsonModule: false,
  };
}

/** True when the relative path is excluded from scanning. */
export function isExcludedPath(relPath: string, extraExcludes: string[]): boolean {
  const normalized = toPosixPath(relPath);
  if (DEFAULT_EXCLUDES.some((re) => re.test(normalized))) return true;
  return extraExcludes.some((needle) => normalized.includes(needle));
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface HostFs {
  readonly absRoot: string;
  resolve(...paths: string[]): string;
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
  readFile(path: string): string | undefined;
  getDirectories(path: string): string[];
  realpath(path: string): string;
  readDirectory(
    dir: string,
    extensions?: readonly string[],
    excludes?: readonly string[],
    includes?: readonly string[],
    depth?: number,
  ): string[];
}

function globPatternToRegex(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if ('\\^$+?.()|{}[]'.includes(ch)) {
      out += `\\${ch}`;
      continue;
    }
    out += ch;
  }
  out += '$';
  return new RegExp(out);
}

function matchesConfigSpec(file: string, configDir: string, spec: string): boolean {
  const cleanSpec = toPosixPath(spec).replace(/\/+$/, '');
  if (!cleanSpec.includes('*') && !cleanSpec.includes('?')) {
    const target = posixResolve(configDir, cleanSpec);
    if (target === '/') return true;
    return file === target || file.startsWith(`${target}/`);
  }
  const targetGlob = posixResolve(configDir, cleanSpec);
  return globPatternToRegex(targetGlob).test(file);
}

function makeMemoryFs(absRoot: string, memory: Map<string, string>): HostFs {
  const resolvePath = (...paths: string[]): string => posixResolve(absRoot, ...paths);
  return {
    absRoot,
    resolve: resolvePath,
    fileExists: (f) => memory.has(resolvePath(f)),
    readFile: (f) => memory.get(resolvePath(f)),
    directoryExists: (d) => {
      const norm = resolvePath(d);
      const prefix = norm === '/' ? '/' : `${norm}/`;
      for (const k of memory.keys()) {
        if (k.startsWith(prefix)) return true;
      }
      return false;
    },
    getDirectories: (d) => {
      const norm = resolvePath(d);
      const prefix = norm === '/' ? '/' : `${norm}/`;
      const dirs = new Set<string>();
      for (const k of memory.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash > 0) dirs.add(rest.slice(0, slash));
      }
      return [...dirs];
    },
    realpath: (p) => resolvePath(p),
    readDirectory: (dir, _extensions, excludes, includes) => {
      const configDir = resolvePath(dir);
      const all = [...memory.keys()].filter((k) => SOURCE_EXTENSION.test(k));
      const inc = includes && includes.length > 0 ? includes : ['**/*'];
      return all.filter((file) => {
        if (!inc.some((spec) => matchesConfigSpec(file, configDir, spec))) return false;
        if (excludes && excludes.some((spec) => matchesConfigSpec(file, configDir, spec))) return false;
        return true;
      });
    },
  };
}

function makeDiskFs(absRoot: string, disk: DiskAdapter): HostFs {
  return {
    absRoot,
    resolve: (...paths: string[]) => disk.resolve(absRoot, ...paths),
    fileExists: (f) => disk.fileExists(disk.resolve(absRoot, f)),
    readFile: (f) => disk.readFile(disk.resolve(absRoot, f)),
    directoryExists: (d) => disk.directoryExists(disk.resolve(absRoot, d)),
    getDirectories: (d) => disk.getDirectories(disk.resolve(absRoot, d)),
    realpath: (p) => disk.realpath(disk.resolve(absRoot, p)),
    readDirectory: (dir, extensions, excludes, includes, depth) => {
      if (ts.sys?.readDirectory) {
        return ts.sys.readDirectory(dir, extensions, excludes, includes, depth).map(toPosixPath);
      }
      return disk.walk(dir, MAX_SOURCE_BYTES).sources;
    },
  };
}

/** A compiler host backed by HostFs that keeps module resolution inside the project. */
function makeHost(options: ts.CompilerOptions, fs: HostFs): ts.CompilerHost {
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists: (f) => fs.fileExists(f),
    readFile: (f) => fs.readFile(f),
    directoryExists: (d) => fs.directoryExists(d),
    getDirectories: (d) => fs.getDirectories(d),
    realpath: (p) => fs.realpath(p),
    getCurrentDirectory: () => fs.absRoot,
    useCaseSensitiveFileNames: true,
  };
  return {
    getSourceFile: (fileName, languageVersion) => {
      const resolved = fs.resolve(fileName);
      const text = fs.readFile(resolved);
      if (text === undefined) return undefined;
      return ts.createSourceFile(resolved, text, languageVersion, true, scriptKindFor(resolved));
    },
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => fs.absRoot,
    getCanonicalFileName: (fileName) => toPosixPath(fileName),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => fs.fileExists(f),
    readFile: (f) => fs.readFile(f),
    directoryExists: (d) => fs.directoryExists(d),
    getDirectories: (d) => fs.getDirectories(d),
    realpath: (p) => fs.realpath(p),
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((name) => {
        const result = ts.resolveModuleName(name, containingFile, options, moduleHost).resolvedModule;
        if (!result) return undefined;
        const resolvedName = toPosixPath(result.resolvedFileName);
        if (result.isExternalLibraryImport || resolvedName.includes('/node_modules/')) return undefined;
        return { ...result, resolvedFileName: resolvedName };
      }),
  };
}

interface ProgramPlan {
  config: string;
  options: ts.CompilerOptions;
  rootNames: string[];
}

/** Parses a tsconfig into a plan, or null when it has no files of its own (a solution file). */
function planFromConfig(
  configPath: string,
  absRoot: string,
  sources: Set<string>,
  fs: HostFs,
  extraExcludes: string[],
): ProgramPlan | null {
  const read = ts.readConfigFile(configPath, (p) => fs.readFile(p));
  if (read.error || !read.config) return null;
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: (dir, extensions, excludes, includes, depth) =>
      fs.readDirectory(dir, extensions, excludes, includes, depth),
    fileExists: (p) => fs.fileExists(p),
    readFile: (p) => fs.readFile(p),
  };
  const dir = posixDirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(read.config, parseHost, dir, undefined, configPath);
  const rootNames = parsed.fileNames
    .map((f) => fs.resolve(f))
    .filter((f) => sources.has(f) && !isExcludedPath(posixRelative(absRoot, f), extraExcludes));
  if (rootNames.length === 0) return null;
  const options: ts.CompilerOptions = { ...parsed.options, ...baseOptions() };
  if (parsed.options.paths) options.paths = parsed.options.paths;
  if (parsed.options.baseUrl) options.baseUrl = toPosixPath(parsed.options.baseUrl);
  if (parsed.options.jsx !== undefined) options.jsx = ts.JsxEmit.Preserve;
  return { config: posixRelative(absRoot, configPath), options, rootNames };
}

/** Resolve root path for memory or disk scanning without touching Node builtins in memory mode. */
export function resolveScanRoot(root: string, inMemory: boolean): string {
  if (inMemory) return posixResolve(root);
  return acquireDiskAdapter().resolve(root);
}

/**
 * Build the programs for a root. With `files`, everything is read from
 * memory (keys are paths relative to root).
 */
export function* iteratePrograms(
  root: string,
  files: Record<string, string> | undefined,
  extraExcludes: string[],
  shouldBuildPlan?: (rootNames: string[]) => boolean,
): Generator<ScanProgram> {
  let absRoot: string;
  let fs: HostFs;
  let sources: string[];
  let configs: string[];
  if (files) {
    absRoot = posixResolve(root);
    const memory = new Map(Object.entries(files).map(([k, v]) => [posixResolve(absRoot, k), v]));
    fs = makeMemoryFs(absRoot, memory);
    sources = [...memory.keys()]
      .filter((k) => SOURCE_EXTENSION.test(k) && memory.get(k)!.length <= MAX_SOURCE_BYTES)
      .sort();
    configs = [...memory.keys()]
      .filter((k) => TSCONFIG_PATH.test(k))
      .sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  } else {
    const disk = acquireDiskAdapter();
    absRoot = disk.resolve(root);
    fs = makeDiskFs(absRoot, disk);
    ({ sources, configs } = disk.walk(absRoot, MAX_SOURCE_BYTES));
  }
  const sourceSet = new Set(sources);

  const plans: ProgramPlan[] = [];
  for (const c of configs) {
    if (isExcludedPath(posixRelative(absRoot, c), extraExcludes)) continue;
    const plan = planFromConfig(c, absRoot, sourceSet, fs, extraExcludes);
    if (plan) plans.push(plan);
  }
  const claimed = new Set(plans.flatMap((p) => p.rootNames));
  const loose = sources.filter((s) => !claimed.has(s));
  if (loose.length > 0) plans.push({ config: '<default>', options: baseOptions(), rootNames: loose });

  const owned = new Set<string>();
  const claimedForProgram = new Set<string>();
  for (const plan of plans) {
    plan.rootNames = plan.rootNames.filter((name) => {
      if (claimedForProgram.has(name)) return false;
      claimedForProgram.add(name);
      return true;
    });
  }

  const scannable = (sf: ts.SourceFile): boolean => {
    const abs = fs.resolve(sf.fileName);
    if (!sourceSet.has(abs)) return false;
    return !isExcludedPath(posixRelative(absRoot, abs), extraExcludes);
  };

  for (const plan of plans) {
    if (plan.rootNames.length === 0) continue;
    if (shouldBuildPlan && !shouldBuildPlan(plan.rootNames)) continue;

    const program = ts.createProgram({
      rootNames: plan.rootNames,
      options: plan.options,
      host: makeHost(plan.options, fs),
    });
    const checker = program.getTypeChecker();
    const assignedFiles: ts.SourceFile[] = [];

    for (const name of plan.rootNames) {
      const sf = program.getSourceFile(name);
      if (!sf || owned.has(name) || !scannable(sf)) continue;
      owned.add(name);
      assignedFiles.push(sf);
    }

    for (const sf of program.getSourceFiles()) {
      const abs = fs.resolve(sf.fileName);
      if (owned.has(abs) || !scannable(sf)) continue;
      owned.add(abs);
      assignedFiles.push(sf);
    }

    yield {
      config: plan.config,
      files: assignedFiles,
      program,
      checker,
    };
  }
}

export function buildPrograms(
  root: string,
  files: Record<string, string> | undefined,
  extraExcludes: string[],
): ScanProgram[] {
  return [...iteratePrograms(root, files, extraExcludes)];
}
