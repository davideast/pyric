/**
 * Unified lexical + ancestor/leaf symlink + realpath project-root containment
 * resolver for CLI security rules files (`verify`, `verify --static`, and
 * `firebase.json` rule discovery).
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ContainedRulesFileResult =
  | {
      readonly ok: true;
      readonly realRoot: string;
      readonly realFile: string;
      readonly resolvedPath: string;
    }
  | {
      readonly ok: false;
      readonly kind: 'outside' | 'symlink' | 'not-found' | 'not-regular';
      readonly message: string;
    };

export function isWithinRootDir(baseDir: string, targetPath: string): boolean {
  const rel = relative(baseDir, targetPath);
  if (rel === '') return true;
  if (rel === '..') return false;
  if (
    rel.startsWith(`..${sep}`)
    || rel.startsWith('../')
    || rel.startsWith('..\\')
  ) {
    return false;
  }
  return !isAbsolute(rel);
}

export function isContainedNonSymlinkFile(
  absRoot: string,
  realRoot: string,
  candidatePath: string,
): boolean {
  const checked = resolveContainedRulesFile({
    projectRoot: realRoot,
    lexicalProjectRoot: absRoot,
    cwd: absRoot,
    fileArg: candidatePath,
  });
  return checked.ok;
}

export function resolveContainedRulesFile(options: {
  projectRoot: string;
  lexicalProjectRoot?: string;
  cwd: string;
  fileArg: string;
}): ContainedRulesFileResult {
  let realRoot = resolve(options.projectRoot);
  try {
    realRoot = realpathSync(realRoot);
  } catch {
    realRoot = resolve(options.projectRoot);
  }
  let lexicalRoot = resolve(options.projectRoot);
  if (options.lexicalProjectRoot !== undefined) {
    lexicalRoot = resolve(options.lexicalProjectRoot);
  }

  const absFile = resolve(options.cwd, options.fileArg);
  let relInsideProject: string;
  if (isWithinRootDir(realRoot, absFile)) {
    relInsideProject = relative(realRoot, absFile);
  } else if (isWithinRootDir(lexicalRoot, absFile)) {
    relInsideProject = relative(lexicalRoot, absFile);
  } else {
    return {
      ok: false,
      kind: 'outside',
      message: `rules path escapes project root: ${options.fileArg}`,
    };
  }

  const canonicalCandidate = resolve(realRoot, relInsideProject);
  if (!isWithinRootDir(realRoot, canonicalCandidate)) {
    return {
      ok: false,
      kind: 'outside',
      message: `rules path escapes project root: ${options.fileArg}`,
    };
  }

  const segments = relInsideProject
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
  let current = realRoot;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = join(current, segments[i]!);
    let ancStat: ReturnType<typeof lstatSync>;
    try {
      ancStat = lstatSync(current);
    } catch {
      break;
    }
    if (ancStat.isSymbolicLink()) {
      let realAnc: string | undefined;
      try {
        realAnc = realpathSync(current);
      } catch {
        realAnc = undefined;
      }
      if (realAnc !== undefined && !isWithinRootDir(realRoot, realAnc)) {
        return {
          ok: false,
          kind: 'outside',
          message: `rules path escapes project root: ${options.fileArg}`,
        };
      }
      return {
        ok: false,
        kind: 'symlink',
        message: `rules path must not traverse symbolic links: ${options.fileArg}`,
      };
    }
    const realAnc = realpathSync(current);
    if (!isWithinRootDir(realRoot, realAnc)) {
      return {
        ok: false,
        kind: 'outside',
        message: `rules path escapes project root: ${options.fileArg}`,
      };
    }
  }

  let leafStat: ReturnType<typeof lstatSync>;
  try {
    leafStat = lstatSync(canonicalCandidate);
  } catch {
    if (!existsSync(canonicalCandidate)) {
      return {
        ok: false,
        kind: 'not-found',
        message: `rules file does not exist: ${options.fileArg}`,
      };
    }
    return {
      ok: false,
      kind: 'not-regular',
      message: `rules path must be a regular non-symlink file: ${options.fileArg}`,
    };
  }
  if (leafStat.isSymbolicLink()) {
    return {
      ok: false,
      kind: 'symlink',
      message: `rules path must be a regular non-symlink file: ${options.fileArg}`,
    };
  }
  if (!leafStat.isFile()) {
    return {
      ok: false,
      kind: 'not-regular',
      message: `rules path must be a regular non-symlink file: ${options.fileArg}`,
    };
  }

  const realLeaf = realpathSync(canonicalCandidate);
  if (!isWithinRootDir(realRoot, realLeaf)) {
    return {
      ok: false,
      kind: 'outside',
      message: `rules path escapes project root: ${options.fileArg}`,
    };
  }

  return {
    ok: true,
    realRoot,
    realFile: realLeaf,
    resolvedPath: absFile,
  };
}
