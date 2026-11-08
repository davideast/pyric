/**
 * Builds TypeScript programs for an app's source so the evaluator can use
 * the checker to resolve identifiers across files, path aliases, and
 * re-exports.
 *
 * Each `tsconfig*.json` under the root gets its own program, with its own
 * `paths`; files no tsconfig claims share a default program. Imports that
 * resolve into `node_modules` are left unresolved on purpose: SDK calls
 * are recognised by their import specifier, never by library types, so the
 * result is the same whether or not the app's dependencies are installed.
 */
import ts from 'typescript';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

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
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'out', '.next', '.pyric', '.turbo', '.cache']);

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
  const normalized = relPath.split(sep).join('/');
  if (DEFAULT_EXCLUDES.some((re) => re.test(normalized))) return true;
  return extraExcludes.some((needle) => normalized.includes(needle));
}

/** Lists source and tsconfig files under a directory, skipping vendor and build output. */
function walk(root: string): { sources: string[]; configs: string[] } {
  const sources: string[] = [];
  const configs: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) visit(full);
      } else if (/^tsconfig(?:\.[\w-]+)?\.json$/.test(name)) {
        configs.push(full);
      } else if (SOURCE_EXTENSION.test(name) && st.size <= MAX_SOURCE_BYTES) {
        sources.push(full);
      }
    }
  };
  visit(root);
  sources.sort();
  configs.sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  return { sources, configs };
}

/** A compiler host that reads from memory or disk and keeps resolution inside the project. */
function makeHost(options: ts.CompilerOptions, memory: Map<string, string> | undefined): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  if (memory) {
    host.fileExists = (f) => memory.has(resolve(f));
    host.readFile = (f) => memory.get(resolve(f));
    host.directoryExists = (d) => {
      const prefix = resolve(d) + sep;
      for (const k of memory.keys()) if (k.startsWith(prefix)) return true;
      return false;
    };
    host.getDirectories = () => [];
    host.realpath = (p) => p;
    host.getSourceFile = (fileName, languageVersion) => {
      const text = memory.get(resolve(fileName));
      if (text === undefined) return undefined;
      return ts.createSourceFile(fileName, text, languageVersion, true, scriptKindFor(fileName));
    };
  }
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists: (f) => host.fileExists(f),
    readFile: (f) => host.readFile(f),
    directoryExists: host.directoryExists ? (d) => host.directoryExists!(d) : undefined,
    realpath: host.realpath ? (p) => host.realpath!(p) : undefined,
    getCurrentDirectory: () => host.getCurrentDirectory(),
  };
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((name) => {
      const result = ts.resolveModuleName(name, containingFile, options, moduleHost).resolvedModule;
      if (!result) return undefined;
      if (result.isExternalLibraryImport || result.resolvedFileName.includes(`${sep}node_modules${sep}`)) return undefined;
      return result;
    });
  return host;
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface ProgramPlan {
  config: string;
  options: ts.CompilerOptions;
  rootNames: string[];
}

/** Parses a tsconfig into a plan, or null when it has no files of its own (a solution file). */
function planFromConfig(configPath: string, root: string, sources: Set<string>, memory: Map<string, string> | undefined, extraExcludes: string[]): ProgramPlan | null {
  const readFile = (p: string): string | undefined => (memory ? memory.get(resolve(p)) : ts.sys.readFile(p));
  const read = ts.readConfigFile(configPath, readFile);
  if (read.error || !read.config) return null;
  let readDirectory = ts.sys.readDirectory;
  if (memory) {
    readDirectory = (dir) => [...memory.keys()].filter((k) => k.startsWith(resolve(dir) + sep) && SOURCE_EXTENSION.test(k));
  }
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory,
    fileExists: (p) => (memory ? memory.has(resolve(p)) : ts.sys.fileExists(p)),
    readFile: (p) => readFile(p),
  };
  const dir = resolve(configPath, '..');
  const parsed = ts.parseJsonConfigFileContent(read.config, parseHost, dir, undefined, configPath);
  const rootNames = parsed.fileNames.map((f) => resolve(f)).filter((f) => sources.has(f) && !isExcludedPath(relative(root, f), extraExcludes));
  if (rootNames.length === 0) return null;
  const options: ts.CompilerOptions = { ...parsed.options, ...baseOptions() };
  if (parsed.options.paths) options.paths = parsed.options.paths;
  if (parsed.options.baseUrl) options.baseUrl = parsed.options.baseUrl;
  if (parsed.options.jsx !== undefined) options.jsx = ts.JsxEmit.Preserve;
  return { config: relative(root, configPath).split(sep).join('/'), options, rootNames };
}

/**
 * Build the programs for a root. With `files`, everything is read from
 * memory (keys are paths relative to root).
 */
export function* iteratePrograms(root: string, files: Record<string, string> | undefined, extraExcludes: string[], shouldBuildPlan?: (rootNames: string[]) => boolean): Generator<ScanProgram> {
  const absRoot = resolve(root);
  let memory: Map<string, string> | undefined;
  let sources: string[];
  let configs: string[];
  if (files) {
    memory = new Map(Object.entries(files).map(([k, v]) => [resolve(absRoot, k), v]));
    sources = [...memory.keys()].filter((k) => SOURCE_EXTENSION.test(k) && memory!.get(k)!.length <= MAX_SOURCE_BYTES).sort();
    configs = [...memory.keys()].filter((k) => /(?:^|[\\/])tsconfig(?:\.[\w-]+)?\.json$/.test(k)).sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  } else {
    ({ sources, configs } = walk(absRoot));
  }
  const sourceSet = new Set(sources);

  const plans: ProgramPlan[] = [];
  for (const c of configs) {
    if (isExcludedPath(relative(absRoot, c), extraExcludes)) continue;
    const plan = planFromConfig(c, absRoot, sourceSet, memory, extraExcludes);
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
  
  // First give every program its own root files, then the files it pulled in through imports.
  const scannable = (sf: ts.SourceFile): boolean => {
    const abs = resolve(sf.fileName);
    if (!sourceSet.has(abs)) return false;
    return !isExcludedPath(relative(absRoot, abs), extraExcludes);
  };
  
  for (const plan of plans) {
    if (plan.rootNames.length === 0) continue;
    if (shouldBuildPlan && !shouldBuildPlan(plan.rootNames)) continue;
    
    const program = ts.createProgram({ rootNames: plan.rootNames, options: plan.options, host: makeHost(plan.options, memory) });
    const checker = program.getTypeChecker();
    const assignedFiles: ts.SourceFile[] = [];
    
    for (const name of plan.rootNames) {
      const sf = program.getSourceFile(name);
      if (!sf || owned.has(name) || !scannable(sf)) continue;
      owned.add(name);
      assignedFiles.push(sf);
    }
    
    for (const sf of program.getSourceFiles()) {
      const abs = resolve(sf.fileName);
      if (owned.has(abs) || !scannable(sf)) continue;
      owned.add(abs);
      assignedFiles.push(sf);
    }
    
    yield {
      config: plan.config,
      files: assignedFiles,
      program,
      checker
    };
  }
}

export function buildPrograms(root: string, files: Record<string, string> | undefined, extraExcludes: string[]): ScanProgram[] {
  return [...iteratePrograms(root, files, extraExcludes)];
}

