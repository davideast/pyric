/**
 * Optional GitHub repo import block for the home page composer.
 * Clone an existing repo into the session workspace after compatibility probe.
 */
import { useEffect, useId, useRef } from 'react';

import type { GitHubRepoSummary } from '~/lib/git/github-api';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.18.82.63-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.51-1.04 2.18-.82 2.18-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export type GitHubReposState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; repos: GitHubRepoSummary[] }
  | { kind: 'error'; message: string };

export interface GitHubImportSetupProps {
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
  selectedCloneUrl: string;
  onSelectedCloneUrlChange: (v: string) => void;
  reposState: GitHubReposState;
  onReloadRepos: () => void;
  /** null while checking IndexedDB. */
  patPresent: boolean | null;
  githubLogin: string | null;
  onOpenSettings: () => void;
}

export function githubImportBlockReason(opts: {
  importRepo: boolean;
  selectedCloneUrl: string;
  patPresent: boolean | null;
}): string | null {
  if (!opts.importRepo) return null;
  if (!opts.selectedCloneUrl.trim()) return 'Pick a repository to import.';
  if (opts.patPresent === false) return 'Add a GitHub token in Settings to clone.';
  if (opts.patPresent === null) return 'Checking GitHub token…';
  return null;
}

export function canStartWithGitHubImport(opts: {
  importRepo: boolean;
  selectedCloneUrl: string;
  patPresent: boolean | null;
}): boolean {
  return githubImportBlockReason(opts) === null;
}

export function GitHubImportSetup({
  expanded,
  onExpandedChange,
  selectedCloneUrl,
  onSelectedCloneUrlChange,
  reposState,
  onReloadRepos,
  patPresent,
  githubLogin,
  onOpenSettings,
}: GitHubImportSetupProps) {
  const bodyId = useId();
  const wasExpandedRef = useRef(expanded);

  useEffect(() => {
    wasExpandedRef.current = expanded;
  }, [expanded]);

  const expand = () => onExpandedChange(true);

  return (
    <div
      className={[
        'w-full rounded-md border overflow-hidden',
        'transition-[border-color,background-color] duration-200 ease-out',
        expanded
          ? 'border-[#3a3a48] bg-[#0f0f17]'
          : 'border-[#2a2a35] bg-[#0f0f17]/70 hover:border-[#3a3a48] hover:bg-[#0f0f17]',
      ].join(' ')}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <GitHubIcon
          className={[
            'h-4 w-4 shrink-0 transition-colors duration-200',
            expanded ? 'text-soft-white' : 'text-slate-gray',
          ].join(' ')}
        />

        <div
          className={[
            'relative flex flex-1 min-w-0 items-center',
            expanded ? 'min-h-[2.5rem]' : 'min-h-[1.25rem]',
            !expanded ? 'cursor-pointer' : '',
          ].join(' ')}
          role={!expanded ? 'button' : undefined}
          tabIndex={!expanded ? 0 : undefined}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={!expanded ? expand : undefined}
          onKeyDown={
            !expanded
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    expand();
                  }
                }
              : undefined
          }
        >
          <span
            className={[
              'block w-full text-[12px] leading-snug transition-[opacity,transform] duration-200 ease-out',
              expanded
                ? 'opacity-0 -translate-y-0.5 pointer-events-none absolute inset-x-0 top-0'
                : 'opacity-100 translate-y-0 text-slate-gray hover:text-soft-white',
            ].join(' ')}
          >
            Import an existing GitHub repository
          </span>
          <span
            className={[
              'block w-full transition-[opacity,transform] duration-200 ease-out',
              expanded
                ? 'opacity-100 translate-y-0'
                : 'opacity-0 translate-y-0.5 pointer-events-none absolute inset-x-0 top-0',
            ].join(' ')}
          >
            <span className="text-[13px] font-medium text-soft-white leading-snug">Import from GitHub</span>
            <span className="block text-[11px] text-slate-gray mt-0.5 leading-snug">
              Clone into the playground — we check Firestore rules + React entry before opening.
            </span>
          </span>
        </div>

        <button
          type="button"
          onClick={() => onExpandedChange(false)}
          tabIndex={expanded ? 0 : -1}
          aria-hidden={!expanded}
          className={[
            'shrink-0 text-[11px] text-slate-gray hover:text-soft-white px-1',
            'transition-opacity duration-200 ease-out',
            expanded ? 'opacity-100' : 'opacity-0 pointer-events-none',
          ].join(' ')}
          aria-label="Collapse GitHub import section"
        >
          Hide
        </button>
      </div>

      <div
        id={bodyId}
        className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
        aria-hidden={!expanded}
      >
        <div className="overflow-hidden min-h-0">
          <div
            className={[
              'px-3 pb-3 grid gap-3 border-t border-[#2a2a35]/60',
              'transition-opacity duration-200 ease-out',
              expanded ? 'opacity-100 delay-75' : 'opacity-0',
            ].join(' ')}
          >
            <div className="grid gap-2 pt-3">
              {patPresent === null ? (
                <p className="text-[11px] text-slate-gray">Checking GitHub token…</p>
              ) : patPresent ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-[#a4d4a8]">
                      Token configured{githubLogin ? ` · @${githubLogin}` : ''}
                    </p>
                    <button
                      type="button"
                      onClick={onReloadRepos}
                      tabIndex={expanded ? 0 : -1}
                      disabled={reposState.kind === 'loading'}
                      className="text-[11px] text-slate-gray hover:text-soft-white disabled:opacity-50"
                    >
                      {reposState.kind === 'loading' ? 'Loading…' : 'Refresh repos'}
                    </button>
                  </div>

                  {reposState.kind === 'error' ? (
                    <p className="text-[11px] text-[#f0a0a0]">{reposState.message}</p>
                  ) : null}

                  <label className="block text-[12px] text-slate-gray">
                    Repository
                    <select
                      value={selectedCloneUrl}
                      onChange={(e) => onSelectedCloneUrlChange(e.target.value)}
                      disabled={reposState.kind === 'loading'}
                      tabIndex={expanded ? 0 : -1}
                      className="mt-1 w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1.5 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
                    >
                      <option value="">Select a repository…</option>
                      {(reposState.kind === 'ready' ? reposState.repos : []).map((repo) => (
                        <option key={repo.fullName} value={repo.cloneUrl}>
                          {repo.fullName}
                          {repo.private ? ' (private)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#4a4030] bg-[#2a2418]/40 px-2.5 py-2">
                  <p className="text-[11px] text-[#e8d4a8]">Add a GitHub token to import a repo</p>
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    tabIndex={expanded ? 0 : -1}
                    className="shrink-0 rounded px-2 py-1 text-[11px] font-medium bg-[#3a3428] text-soft-white hover:bg-[#4a4438] transition-colors"
                  >
                    Open Settings
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
