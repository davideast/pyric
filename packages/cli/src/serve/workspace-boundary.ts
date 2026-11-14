import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isFirebaseProjectRoot } from '../cli/firebase-project.js';

export const POINTER_REL = join('.pyric', 'serve.json');
export const SESSION_REL = join('.pyric', 'session.json');

const CANDIDATE_SUBDIRS = ['', 'web', 'frontend', 'client', 'app', 'ui', 'www'] as const;
const ROOT_ONLY_SUBDIRS = [''] as const;
const WORKSPACE_GROUPS = ['apps', 'packages', 'services'] as const;

function hasWorkspacesPackageJson(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return false;
    return Array.isArray(parsed.workspaces) || (parsed.workspaces !== null && typeof parsed.workspaces === 'object');
  } catch {
    return false;
  }
}

function isMonorepoWorkspaceDir(dir: string): boolean {
  if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
  return hasWorkspacesPackageJson(dir);
}

function isOwningWorkspaceConfigDir(dir: string): boolean {
  return isFirebaseProjectRoot(dir) || isMonorepoWorkspaceDir(dir);
}

function hasBoundaryMarker(dir: string): boolean {
  return (
    isFirebaseProjectRoot(dir) ||
    existsSync(join(dir, '.git')) ||
    existsSync(join(dir, 'package.json'))
  );
}

/**
 * Finds the nearest owning Firebase/Pyric project or monorepo workspace directory
 * at or above `startDir` (reusing {@link isFirebaseProjectRoot} from
 * `firebase-project.ts`), without crossing an enclosing `.git` repository root.
 */
function findOwningWorkspaceDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (isOwningWorkspaceConfigDir(dir)) return dir;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface WorkspaceSearchEntry {
  dir: string;
  includeSubdirs: boolean;
}

function candidateWorkspaceDirectories(startDir: string): WorkspaceSearchEntry[] {
  const entries: WorkspaceSearchEntry[] = [];
  const resolvedStart = resolve(startDir);
  const owningRoot = findOwningWorkspaceDir(resolvedStart);
  const insideOwningRoot =
    owningRoot !== null &&
    (resolvedStart === owningRoot || resolvedStart.startsWith(owningRoot + sep));
  let current = resolvedStart;
  for (;;) {
    const hasGitMarker = existsSync(join(current, '.git'));
    const includeSubdirs = current === resolvedStart || current === owningRoot || hasGitMarker;
    entries.push({ dir: current, includeSubdirs });
    if (insideOwningRoot && current === owningRoot) break;
    if (!insideOwningRoot && hasBoundaryMarker(current)) break;
    if (hasGitMarker) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return entries;
}

function expandCandidateFiles(
  startDir: string,
  relPaths: readonly string[],
  includeWorkspaceGroups: boolean,
): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const addDir = (dir: string): void => {
    for (const rel of relPaths) {
      const candidate = join(dir, rel);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        files.push(candidate);
      }
    }
  };
  for (const { dir, includeSubdirs } of candidateWorkspaceDirectories(startDir)) {
    const subdirs = includeSubdirs ? CANDIDATE_SUBDIRS : ROOT_ONLY_SUBDIRS;
    for (const sub of subdirs) {
      let targetDir = dir;
      if (sub !== '') {
        targetDir = join(dir, sub);
      }
      addDir(targetDir);
    }
  }
  if (includeWorkspaceGroups) {
    const projectRoot = findOwningWorkspaceDir(startDir) ?? resolve(startDir);
    for (const group of WORKSPACE_GROUPS) {
      const groupDir = join(projectRoot, group);
      if (!existsSync(groupDir)) continue;
      try {
        for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            addDir(join(groupDir, entry.name));
          }
        }
      } catch {
        // Ignore unreadable workspace directories.
      }
    }
  }
  return files;
}

/** Candidate `.pyric/serve.json` paths from `startDir` up to the owning workspace/project boundary. */
export function candidatePointerFiles(startDir: string): string[] {
  return expandCandidateFiles(startDir, [POINTER_REL], false);
}

/** Candidate `.pyric/serve.json` and `.pyric/session.json` paths within the owning workspace/project boundary. */
export function candidateSessionTokenFiles(
  startDir: string,
  options?: { includeWorkspaceGroups?: boolean },
): string[] {
  return expandCandidateFiles(
    startDir,
    [POINTER_REL, SESSION_REL],
    options?.includeWorkspaceGroups === true,
  );
}

/** Candidate `.pyric/serve.json` and `.pyric/session.json` paths including monorepo workspace groups for loopback TLS pinning. */
export function candidateTlsPointerFiles(startDir: string): string[] {
  const files = expandCandidateFiles(startDir, [POINTER_REL, SESSION_REL], false);
  const seen = new Set(files);
  const projectRoot = findOwningWorkspaceDir(startDir) ?? resolve(startDir);
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(projectRoot, group);
    if (!existsSync(groupDir)) continue;
    try {
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(groupDir, entry.name, POINTER_REL);
        if (!seen.has(candidate)) {
          seen.add(candidate);
          files.push(candidate);
        }
      }
    } catch {
      // Ignore unreadable workspace directories.
    }
  }
  return files;
}
