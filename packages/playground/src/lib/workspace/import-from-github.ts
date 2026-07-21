/**
 * Clone a GitHub repo into a fresh session workspace, probe compatibility,
 * and materialize canonical playground files — or bail with blockers.
 */
import { listAllFiles } from '~/lib/files/file-tree';
import { GitService } from '~/lib/git/git-service';
import type { GitHubRepoSummary } from '~/lib/git/github-api';
import type { SessionMeta, SessionPayload } from '~/lib/sessions/types';
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { ensureSessionVFS, getVFS } from '~/lib/vfs';

import { materializeWorkspaceFromProbe } from './materialize-workspace-from-probe';
import {
  probeWorkspace,
  type WorkspaceProbeResult,
  type WorkspaceProbeTier,
} from './probe-from-repo';

export interface ImportFromGitHubInput {
  sessionId: string;
  repo: GitHubRepoSummary | ImportRepoRef;
  /** Probe tiers allowed to proceed. Defaults to green + yellow. */
  allowedTiers?: WorkspaceProbeTier[];
  onProgress?: (phase: string) => void;
}

/** Minimal repo reference when the caller only has a clone URL. */
export interface ImportRepoRef {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private?: boolean;
  htmlUrl?: string;
}

export interface ImportFromGitHubResult {
  probe: WorkspaceProbeResult;
  workspace: SessionPayload['workspace'];
  githubRepo: SessionMeta['githubRepo'];
}

export interface PreparedGitHubImport {
  probe: WorkspaceProbeResult;
  githubRepo: SessionMeta['githubRepo'];
  scaffoldable: boolean;
}

export class WorkspaceImportError extends Error {
  readonly probe: WorkspaceProbeResult;

  constructor(message: string, probe: WorkspaceProbeResult) {
    super(message);
    this.name = 'WorkspaceImportError';
    this.probe = probe;
  }
}

const DEFAULT_ALLOWED: WorkspaceProbeTier[] = ['green', 'yellow'];

function toGithubRepoMeta(
  repo: GitHubRepoSummary | ImportRepoRef,
): NonNullable<SessionMeta['githubRepo']> {
  return {
    fullName: repo.fullName,
    htmlUrl: 'htmlUrl' in repo && repo.htmlUrl ? repo.htmlUrl : `https://github.com/${repo.fullName}`,
    cloneUrl: repo.cloneUrl,
    defaultBranch: repo.defaultBranch,
    private: repo.private ?? false,
    linkedAt: Date.now(),
  };
}

/**
 * True when a cloned repo has no app code — only README / docs / dotfiles.
 * Such a repo can't be "imported" as an existing app, but the user clearly
 * wants to BUILD into it, so import falls back to a fresh workspace linked
 * to the repo instead of a confusing "no firestore.rules / no app entry"
 * failure. Any real source (*.ts/tsx/js/jsx/…), a package.json, or a
 * firestore.rules means there IS content to import — not scaffoldable.
 */
export function isScaffoldableEmptyRepo(files: readonly string[]): boolean {
  const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/i;
  for (const f of files) {
    if (f.includes('/.git/')) continue;
    const base = (f.split('/').pop() ?? '').toLowerCase();
    if (base === 'firestore.rules' || base === 'package.json') return false;
    if (CODE_EXT.test(base)) return false;
  }
  return true;
}

async function assertWorkspaceEmpty(): Promise<void> {
  const adapter = getVFS();
  try {
    await adapter.promises.lstat(WORKSPACE_ROOT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const files = await listAllFiles(WORKSPACE_ROOT);
  const meaningful = files.filter((p) => !p.includes('/.git/'));
  if (meaningful.length > 0) {
    throw new Error(
      `Workspace already has ${meaningful.length} file(s) — import requires an empty session workspace.`,
    );
  }
}

/**
 * Shallow-clone `repo` into `/workspace`, run {@link probeWorkspace}, and
 * {@link materializeWorkspaceFromProbe} when the probe tier is allowed.
 */
export async function importFromGitHub(
  input: ImportFromGitHubInput,
): Promise<ImportFromGitHubResult> {
  const allowed = input.allowedTiers ?? DEFAULT_ALLOWED;
  const report = (phase: string) => input.onProgress?.(phase);

  report('Preparing workspace…');
  await ensureSessionVFS(input.sessionId);
  await assertWorkspaceEmpty();

  report('Cloning repository…');
  const git = new GitService(getVFS());
  await git.clone({
    url: input.repo.cloneUrl,
    dir: WORKSPACE_ROOT,
    ref: input.repo.defaultBranch,
    depth: 1,
    singleBranch: true,
  });

  report('Checking compatibility…');
  const probe = await probeWorkspace();

  // Empty repo (only README/docs, no app code): the user wants to BUILD
  // into it, not import an existing app. Keep the clone (.git + README so
  // a later push works), start a fresh empty workspace, link the repo,
  // and proceed — the agent builds firestore.rules + App.tsx from here.
  const clonedFiles = (await listAllFiles(WORKSPACE_ROOT)).filter(
    (p) => !p.includes('/.git/'),
  );
  if (isScaffoldableEmptyRepo(clonedFiles)) {
    report('Empty repo — starting a fresh workspace linked to it…');
    return {
      probe,
      workspace: { rules: '', code: '', appSource: '' },
      githubRepo: toGithubRepoMeta(input.repo),
    };
  }

  if (!allowed.includes(probe.tier)) {
    throw new WorkspaceImportError(
      probe.blockers.length > 0
        ? probe.blockers.join('\n')
        : `Import blocked — probe tier "${probe.tier}" is not supported.`,
      probe,
    );
  }

  if (!probe.mappings) {
    throw new WorkspaceImportError('Import blocked — no file mappings discovered.', probe);
  }

  report('Materializing workspace…');
  const workspace = await materializeWorkspaceFromProbe(probe.mappings);

  return {
    probe,
    workspace,
    githubRepo: toGithubRepoMeta(input.repo),
  };
}

/** Clone once and return the choices needed to finish the import. */
export async function prepareGitHubImport(
  input: ImportFromGitHubInput,
): Promise<PreparedGitHubImport> {
  const report = (phase: string) => input.onProgress?.(phase);
  report('Preparing workspace…');
  await ensureSessionVFS(input.sessionId);
  await assertWorkspaceEmpty();
  report('Cloning repository…');
  const git = new GitService(getVFS());
  await git.clone({
    url: input.repo.cloneUrl,
    dir: WORKSPACE_ROOT,
    ref: input.repo.defaultBranch,
    depth: 1,
    singleBranch: true,
  });
  report('Finding React entries…');
  const probe = await probeWorkspace({ selectedAppEntryPath: null });
  const clonedFiles = (await listAllFiles(WORKSPACE_ROOT)).filter(
    (path) => !path.includes('/.git/'),
  );
  return {
    probe,
    githubRepo: toGithubRepoMeta(input.repo),
    scaffoldable: isScaffoldableEmptyRepo(clonedFiles),
  };
}

/** Materialize a prepared clone with an explicit preview choice. */
export async function finalizeGitHubImport(input: {
  probe: WorkspaceProbeResult;
  appEntryPath: string | null;
  githubRepo: SessionMeta['githubRepo'];
}): Promise<ImportFromGitHubResult> {
  const probe = await probeWorkspace({ selectedAppEntryPath: input.appEntryPath });
  if (probe.blockers.length > 0 || !probe.mappings) {
    throw new WorkspaceImportError(probe.blockers.join('\n') || 'Import blocked.', probe);
  }
  const workspace = await materializeWorkspaceFromProbe(probe.mappings);
  return { probe, workspace, githubRepo: input.githubRepo };
}
