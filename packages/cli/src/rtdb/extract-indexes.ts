/**
 * Shared Node-side Realtime Database `.indexOn` extraction and `firebase.json`
 * multi-instance rules target resolution for CLI and MCP surfaces.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';
import {
  extractSdkUsage,
  isExcludedPath,
  rtdbIndexPass,
  type RtdbIndexPassResult,
} from 'pyric/rules/internal/usage';
import {
  databaseRulesConfig,
  DEFAULT_DATABASE_RULES_FILE,
  parseResourcePattern,
} from 'pyric/sandbox/internal';
import {
  readFirebaseJson,
  readFirebaseRc,
  type FirebaseJson,
  type FirebaseRc,
} from '../cli/firebase-json.js';
import { resolveFirebaseProject } from '../cli/firebase-project.js';

const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;
const TSCONFIG_FILE_RE = /^tsconfig(?:\.[\w-]+)?\.json$/;
const PROJECT_MARKERS = ['tsconfig.json', 'jsconfig.json', 'firebase.json', 'package.json'];
const EXCLUDED_DIR_SEGMENT = /^(?:__tests__|__mocks__|test|tests)$/;
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.output',
  '.turbo',
  '.vercel',
  '.firebase',
  '.pyric',
  'dist',
  'build',
  'out',
  'coverage',
]);
const MAX_SOURCE_BYTES = 512 * 1024;

export interface ExtractRtdbIndexesFromPathsOptions {
  readonly projectDir: string;
  readonly paths: readonly string[];
  readonly instance?: string;
  readonly includeDefaultInstance?: boolean;
}

export interface ResolveRtdbRulesTargetOptions {
  readonly cwd: string;
  readonly rulesFlag?: string;
  readonly instance?: string;
  readonly readFirebaseJsonFn?: (cwd: string) => Promise<FirebaseJson>;
  readonly readFirebaseRcFn?: (cwd: string) => Promise<FirebaseRc | null>;
}

export interface ResolvedRtdbRulesTarget {
  readonly rulesPath: string;
  readonly instance: string | undefined;
  readonly includeDefaultInstance: boolean;
}

interface CheckedTarget {
  readonly absTarget: string;
  readonly isDir: boolean;
}

function toPosixRelative(fromDir: string, toFile: string): string {
  return relative(fromDir, toFile).replace(/\\/g, '/');
}

function hasExcludedDirSegment(relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('..')) return false;
  return relPath.split('/').some((seg) => EXCLUDED_DIR_SEGMENT.test(seg));
}

function commonAncestorDir(dirs: readonly string[]): string {
  let acc = dirs[0]!;
  for (let i = 1; i < dirs.length; i += 1) {
    const other = dirs[i]!;
    while (acc !== dirname(acc) && other !== acc && toPosixRelative(acc, other).startsWith('..')) {
      acc = dirname(acc);
    }
  }
  return acc;
}

function chooseScanRoot(commonDir: string, absProject: string): string {
  const relFromProject = toPosixRelative(absProject, commonDir);
  if (!relFromProject.startsWith('..') && !hasExcludedDirSegment(relFromProject)) {
    return absProject;
  }

  const rawTmp = resolvePath(tmpdir());
  const tempRoots = new Set<string>(['/tmp', '/private/tmp', '/var/tmp', rawTmp]);
  try {
    tempRoots.add(realpathSync(rawTmp));
  } catch {
    // Keep rawTmp when realpath fails.
  }
  const stopRoots = new Set<string>(['/', '/private', '/var', '/home', '/Users', '/usr', ...tempRoots]);
  if (process.env.HOME) stopRoots.add(resolvePath(process.env.HOME));

  let cur = commonDir;
  let topWalked = commonDir;
  while (!stopRoots.has(cur)) {
    topWalked = cur;
    const hasMarker = PROJECT_MARKERS.some((marker) => {
      try {
        const st = lstatSync(join(cur, marker));
        return st.isFile() && !st.isSymbolicLink();
      } catch {
        return false;
      }
    });
    if (hasMarker) return cur;
    if (EXCLUDED_DIR_SEGMENT.test(basename(cur))) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  if (tempRoots.has(dirname(topWalked))) return topWalked;
  return commonDir;
}

function collectDirectoryFiles(
  projectDir: string,
  dirPath: string,
  files: Record<string, string>,
): void {
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      collectDirectoryFiles(projectDir, full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = toPosixRelative(projectDir, full);
    if (isExcludedPath(rel, [])) continue;
    if (TSCONFIG_FILE_RE.test(entry.name)) {
      files[rel] = readFileSync(full, 'utf8');
      continue;
    }
    if (!SOURCE_FILE_RE.test(entry.name)) continue;
    const size = lstatSync(full).size;
    if (size <= MAX_SOURCE_BYTES) {
      files[rel] = readFileSync(full, 'utf8');
    }
  }
}

export function extractRtdbIndexesFromPaths(
  options: ExtractRtdbIndexesFromPathsOptions,
): RtdbIndexPassResult {
  const absProject = resolvePath(options.projectDir);
  const targets: CheckedTarget[] = [];

  for (const rawPath of options.paths) {
    const absTarget = resolvePath(absProject, rawPath);
    let stat;
    try {
      stat = lstatSync(absTarget);
    } catch {
      throw new Error(`Path does not exist: ${rawPath}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link path: ${rawPath}`);
    }
    targets.push({ absTarget, isDir: stat.isDirectory() });
  }

  const targetDirs = targets.map((t) => {
    if (t.isDir) return t.absTarget;
    return dirname(t.absTarget);
  });
  let scanRoot = absProject;
  if (targets.length > 0) {
    scanRoot = chooseScanRoot(commonAncestorDir(targetDirs), absProject);
  }

  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  if (existsSync(scanRoot)) {
    collectDirectoryFiles(scanRoot, scanRoot, files);
  }

  const clientRoots: string[] = [];
  for (const t of targets) {
    const rel = toPosixRelative(scanRoot, t.absTarget);
    if (t.isDir) {
      clientRoots.push(rel);
    } else {
      files[rel] = readFileSync(t.absTarget, 'utf8');
      clientRoots.push(rel);
    }
  }

  const usage = extractSdkUsage({
    root: scanRoot,
    files,
    clientRoots,
    includeReads: true,
  });

  if (options.instance !== undefined) {
    return rtdbIndexPass(usage, {
      instance: options.instance,
      includeDefaultInstance: options.includeDefaultInstance === true,
    });
  }
  return rtdbIndexPass(usage);
}

export async function resolveRtdbRulesTarget(
  options: ResolveRtdbRulesTargetOptions,
): Promise<ResolvedRtdbRulesTarget> {
  const cwd = resolvePath(options.cwd);
  const readFbJson = options.readFirebaseJsonFn ?? readFirebaseJson;
  const readFbRc = options.readFirebaseRcFn ?? readFirebaseRc;

  let fbJson: FirebaseJson | null = null;
  try {
    fbJson = await readFbJson(cwd);
  } catch {
    fbJson = null;
  }

  const rc = await readFbRc(cwd).catch(() => null);
  const projectId = resolveFirebaseProject({ projectDir: cwd, rc }).projectId;

  const targetInstances = (targetName: string): unknown => {
    if (!projectId || !rc?.targets) return undefined;
    const projTargets = Object.hasOwn(rc.targets, projectId) ? rc.targets[projectId] : undefined;
    const dbTargets = projTargets?.database;
    if (!dbTargets || !Object.hasOwn(dbTargets, targetName)) return undefined;
    return dbTargets[targetName];
  };

  let config: ReturnType<typeof databaseRulesConfig> | null = null;
  let defaultNorm = '(default)';
  if (fbJson !== null) {
    config = databaseRulesConfig(fbJson.database, {
      projectId,
      targetInstances,
      resolveFile: (f) => resolvePath(cwd, f),
    });
    defaultNorm = parseResourcePattern('rtdb', '', config.defaultInstance).resourceId;
  } else if (projectId) {
    defaultNorm = parseResourcePattern('rtdb', '', `${projectId}-default-rtdb`).resourceId;
  }

  const matchesDefault = (inst: string | undefined): boolean => {
    if (inst === undefined) return true;
    const norm = parseResourcePattern('rtdb', '', inst).resourceId;
    return norm === '(default)' || norm === defaultNorm;
  };

  if (options.rulesFlag !== undefined) {
    return {
      rulesPath: resolvePath(cwd, options.rulesFlag),
      instance: options.instance,
      includeDefaultInstance: matchesDefault(options.instance),
    };
  }

  if (config === null) {
    return {
      rulesPath: resolvePath(cwd, DEFAULT_DATABASE_RULES_FILE),
      instance: options.instance,
      includeDefaultInstance: matchesDefault(options.instance),
    };
  }

  if (options.instance !== undefined) {
    const requestedNorm = parseResourcePattern('rtdb', '', options.instance).resourceId;
    const isDefault = matchesDefault(options.instance);
    const match = config.targets.find((t) => {
      const targetNorm = parseResourcePattern('rtdb', '', t.instance).resourceId;
      if (targetNorm === requestedNorm) return true;
      return isDefault && targetNorm === defaultNorm;
    });
    if (!match) {
      throw new Error(
        `No database rules entry in firebase.json matches instance '${options.instance}'.`,
      );
    }
    return {
      rulesPath: match.file,
      instance: options.instance,
      includeDefaultInstance: isDefault,
    };
  }

  if (config.targets.length === 0) {
    return {
      rulesPath: resolvePath(cwd, DEFAULT_DATABASE_RULES_FILE),
      instance: undefined,
      includeDefaultInstance: true,
    };
  }

  if (config.targets.length === 1) {
    const single = config.targets[0]!;
    const singleNorm = parseResourcePattern('rtdb', '', single.instance).resourceId;
    const isDefault = singleNorm === '(default)' || singleNorm === defaultNorm;
    let scopedInstance: string | undefined;
    if (Array.isArray(fbJson?.database)) {
      scopedInstance = single.instance;
    }
    return {
      rulesPath: single.file,
      instance: scopedInstance,
      includeDefaultInstance: isDefault,
    };
  }

  const defaultTarget = config.targets.find(
    (t) => parseResourcePattern('rtdb', '', t.instance).resourceId === defaultNorm,
  );
  if (defaultTarget) {
    return {
      rulesPath: defaultTarget.file,
      instance: defaultTarget.instance,
      includeDefaultInstance: true,
    };
  }

  throw new Error(
    'firebase.json configures multiple Realtime Database instances without a default instance; pass --instance <name> or --rules <file>.',
  );
}
