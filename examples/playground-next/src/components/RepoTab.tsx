/**
 * Right-panel tab that exposes the new OPFS VFS / git / package
 * install / terminal stack. Three sub-views:
 *
 *   - git: clone a GitHub repo, view status, stage-commit-push
 *   - packages: install a name@version from esm.sh, list installed
 *   - terminal: just-bash terminal over the OPFS VFS
 *
 * Intentionally lo-fi UI — this is the verification surface for the
 * new plumbing. The polished home is TBD.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getAuthenticatedUser,
  listAccessibleRepos,
  type GitHubRepoSummary,
} from '~/lib/git/github-api';
import { getStoredPAT } from '~/lib/git/github-auth';
import { getGitService, type LogEntry, type StatusRow } from '~/lib/git/git-service';
import { ensureRepo } from '~/lib/checkpoints/service';
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { useGithubSessionStore } from '~/lib/store/github-session';
import {
  getRegistry,
  installPackage,
  uninstallPackage,
  type InstalledPackage,
} from '~/lib/packages';

import { TerminalPanel } from './TerminalPanel';

type SubTab = 'git' | 'packages' | 'terminal';

// The git UI operates on the SAME repo the agent + home page use: the
// session workspace at /workspace (git-managed via ensureRepo). The old
// default (/workspace/repo) had no `.git`, which is what produced the
// `commit failed: ENOENT lstat '.'` the user hit.
const DEFAULT_REPO_DIR = WORKSPACE_ROOT;
const DEFAULT_CLONE_URL = 'https://github.com/octocat/Hello-World';

function deriveRepoName(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '');
  const last = cleaned.split('/').pop();
  return last || 'repo';
}

export function RepoTab() {
  const [subTab, setSubTab] = useState<SubTab>('git');

  return (
    <div className="flex h-full min-h-0 flex-col bg-content-bg">
      <div className="flex shrink-0 border-b border-[#2a2a35] px-3">
        {(['git', 'packages', 'terminal'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setSubTab(id)}
            className={[
              'px-3 py-2 text-[12px] font-medium uppercase tracking-wider transition-colors',
              subTab === id ? 'text-soft-white' : 'text-slate-gray hover:text-soft-white/80',
            ].join(' ')}
          >
            {id}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {subTab === 'git' ? <GitView /> : null}
        {subTab === 'packages' ? <PackagesView /> : null}
        {subTab === 'terminal' ? <TerminalPanel repoDir={'/'} /> : null}
      </div>
    </div>
  );
}

type PatState =
  | { kind: 'unknown' }
  | { kind: 'missing' }
  | { kind: 'present' };

type ReposState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; repos: GitHubRepoSummary[] }
  | { kind: 'error'; message: string };

export function GitView() {
  const git = useMemo(() => getGitService(), []);
  // The repo linked on the home page (github-session store). Prefill the
  // clone URL from it so the git UI is aware of the session's repo
  // instead of the hardcoded octocat placeholder.
  const linkedRepo = useGithubSessionStore((s) => s.linkedRepo);
  const [url, setUrl] = useState(() => linkedRepo?.cloneUrl ?? DEFAULT_CLONE_URL);
  useEffect(() => {
    // Adopt the linked repo's clone URL once it loads, but only if the
    // user hasn't already changed the field away from the default.
    setUrl((cur) => (cur === DEFAULT_CLONE_URL && linkedRepo?.cloneUrl ? linkedRepo.cloneUrl : cur));
  }, [linkedRepo?.cloneUrl]);
  const [dir, setDir] = useState(DEFAULT_REPO_DIR);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusRows, setStatusRows] = useState<StatusRow[] | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [commitMessage, setCommitMessage] = useState('Update from playground');
  const [authorName, setAuthorName] = useState('Playground User');
  const [authorEmail, setAuthorEmail] = useState('playground@example.com');
  const [patState, setPatState] = useState<PatState>({ kind: 'unknown' });
  const [reposState, setReposState] = useState<ReposState>({ kind: 'idle' });

  const loadRepos = useCallback(async () => {
    setReposState({ kind: 'loading' });
    try {
      const [repos, user] = await Promise.all([
        listAccessibleRepos(),
        getAuthenticatedUser().catch(() => null),
      ]);
      setReposState({ kind: 'ready', repos });
      if (user) {
        if (user.name) setAuthorName(user.name);
        else if (user.login) setAuthorName(user.login);
        if (user.email) setAuthorEmail(user.email);
        else setAuthorEmail(`${user.id}+${user.login}@users.noreply.github.com`);
      }
    } catch (e) {
      setReposState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  // Detect PAT on mount; auto-load repos when present.
  useEffect(() => {
    let cancelled = false;
    getStoredPAT().then((token) => {
      if (cancelled) return;
      if (token) {
        setPatState({ kind: 'present' });
        void loadRepos();
      } else {
        setPatState({ kind: 'missing' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadRepos]);

  const handleSelectRepo = (cloneUrl: string) => {
    if (!cloneUrl) return;
    setUrl(cloneUrl);
    // Mirror the repo name into the local dir to avoid stomping over
    // a previously-cloned tree.
    setDir(`/workspace/${deriveRepoName(cloneUrl)}`);
  };

  const refreshStatusAndLog = useCallback(
    async (forDir: string) => {
      try {
        // The workspace repo is git-managed lazily (ensureRepo inits
        // /workspace on first use). A cloned repo dir already has .git.
        if (forDir === WORKSPACE_ROOT) await ensureRepo();
        const [rows, entries] = await Promise.all([
          git.status(forDir).catch(() => null),
          git.log(forDir, 10).catch(() => null),
        ]);
        if (rows) setStatusRows(rows);
        if (entries) setLog(entries);
      } catch {
        /* best-effort */
      }
    },
    [git],
  );

  const handleClone = async () => {
    setBusy(true);
    setStatus('cloning…');
    try {
      await git.clone({ url, dir, depth: 1, singleBranch: true });
      const repo = deriveRepoName(url);
      setStatus(`cloned ${repo} into ${dir}`);
      await refreshStatusAndLog(dir);
    } catch (e) {
      setStatus(`clone failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    setStatus('refreshing…');
    try {
      await refreshStatusAndLog(dir);
      setStatus('refreshed');
    } catch (e) {
      setStatus(`refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async () => {
    setBusy(true);
    setStatus('staging + committing…');
    try {
      if (dir === WORKSPACE_ROOT) await ensureRepo();
      await git.stageAll(dir);
      const oid = await git.commit({
        dir,
        message: commitMessage,
        authorName,
        authorEmail,
      });
      setStatus(`committed ${oid.slice(0, 7)}`);
      await refreshStatusAndLog(dir);
    } catch (e) {
      setStatus(`commit failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePush = async () => {
    setBusy(true);
    setStatus('pushing…');
    try {
      const result = await git.push({ dir });
      setStatus(`push ok (${result.ok ? 'accepted' : 'rejected'})`);
    } catch (e) {
      setStatus(`push failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-3">
      <section className="space-y-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-gray">clone</h3>
        <PatRepoPicker
          patState={patState}
          reposState={reposState}
          selectedUrl={url}
          onSelect={handleSelectRepo}
          onReload={loadRepos}
        />
        <label className="block text-[11px] text-slate-gray">
          repo URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="mt-1 w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
          />
        </label>
        <label className="block text-[11px] text-slate-gray">
          local dir
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="mt-1 w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <ActionButton onClick={handleClone} disabled={busy}>
            clone
          </ActionButton>
          <ActionButton onClick={handleRefresh} disabled={busy}>
            refresh
          </ActionButton>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-gray">
          commit + push
        </h3>
        <label className="block text-[11px] text-slate-gray">
          message
          <input
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            className="mt-1 w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
          />
        </label>
        <div className="flex gap-2">
          <label className="flex-1 text-[11px] text-slate-gray">
            name
            <input
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              className="mt-1 w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
            />
          </label>
          <label className="flex-1 text-[11px] text-slate-gray">
            email
            <input
              value={authorEmail}
              onChange={(e) => setAuthorEmail(e.target.value)}
              className="mt-1 w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton onClick={handleCommit} disabled={busy}>
            stage + commit
          </ActionButton>
          <ActionButton onClick={handlePush} disabled={busy}>
            push
          </ActionButton>
        </div>
      </section>

      {status ? <p className="font-mono text-[11px] text-slate-gray">{status}</p> : null}

      {statusRows && statusRows.length > 0 ? (
        <section className="space-y-1">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-gray">
            working tree
          </h3>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[#2a2a35] bg-[#0f0f17] p-2 font-mono text-[11px] text-soft-white">
            {statusRows
              .filter((row) => row.head !== 1 || row.workdir !== 1 || row.stage !== 1)
              .map(
                (row) =>
                  `${row.head}${row.workdir}${row.stage}  ${row.filepath}`,
              )
              .join('\n') || 'clean'}
          </pre>
        </section>
      ) : null}

      {log && log.length > 0 ? (
        <section className="space-y-1">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-gray">
            recent commits
          </h3>
          <ul className="space-y-1 font-mono text-[11px] text-soft-white">
            {log.map((entry) => (
              <li key={entry.oid} className="flex gap-2">
                <span className="text-slate-gray">{entry.oid.slice(0, 7)}</span>
                <span className="truncate">{entry.message.split('\n')[0]}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function PackagesView() {
  const [name, setName] = useState('lodash-es');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [installed, setInstalled] = useState<Record<string, InstalledPackage>>({});

  const refresh = useCallback(async () => {
    try {
      const next = await getRegistry();
      setInstalled(next);
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = async () => {
    setBusy(true);
    setStatus('resolving + installing…');
    try {
      const result = await installPackage({
        name: name.trim(),
        version: version.trim() || undefined,
      });
      setStatus(`installed ${result.name}@${result.version}`);
      await refresh();
    } catch (e) {
      setStatus(`install failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async (pkgName: string) => {
    setBusy(true);
    setStatus(`uninstalling ${pkgName}…`);
    try {
      await uninstallPackage(pkgName);
      setStatus(`uninstalled ${pkgName}`);
      await refresh();
    } catch (e) {
      setStatus(`uninstall failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const entries = Object.values(installed);

  return (
    <div className="space-y-4 p-3">
      <section className="space-y-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-gray">install</h3>
        <div className="flex gap-2">
          <label className="flex-1 text-[11px] text-slate-gray">
            name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="mt-1 w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
            />
          </label>
          <label className="w-32 text-[11px] text-slate-gray">
            version
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="latest"
              spellCheck={false}
              autoComplete="off"
              className="mt-1 w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
            />
          </label>
        </div>
        <ActionButton onClick={handleInstall} disabled={busy}>
          install via esm.sh
        </ActionButton>
        {status ? <p className="font-mono text-[11px] text-slate-gray">{status}</p> : null}
      </section>

      <section className="space-y-1">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-gray">
          installed
        </h3>
        {entries.length === 0 ? (
          <p className="text-[12px] text-slate-gray">none</p>
        ) : (
          <ul className="space-y-1">
            {entries.map((pkg) => (
              <li
                key={pkg.name}
                className="flex items-center justify-between gap-2 rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[12px] text-soft-white">
                    {pkg.name}@{pkg.version}
                  </p>
                  <p className="truncate font-mono text-[10px] text-slate-gray">{pkg.cdnUrl}</p>
                </div>
                <ActionButton onClick={() => handleUninstall(pkg.name)} disabled={busy}>
                  remove
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Renders the "your repos" affordance for the clone form:
 *
 *   - no PAT yet → hint pointing to Settings.
 *   - loading → muted "fetching" indicator.
 *   - error → message + retry button (covers expired PATs, missing
 *     `repo` scope, 5xx).
 *   - ready → native <select> populated with the repos the PAT can push to.
 *
 * Filter rationale: `/user/repos` returns every repo the user
 * account can see, which for a classic PAT with the `repo` scope
 * is effectively their full repo list. The useful subset for this
 * UI is the repos the PAT can clone *and* push to — surfaced via
 * the per-repo `permissions.push` flag GitHub returns. A toggle
 * relaxes the filter for users who genuinely want read-only.
 */
function PatRepoPicker({
  patState,
  reposState,
  selectedUrl,
  onSelect,
  onReload,
}: {
  patState: PatState;
  reposState: ReposState;
  selectedUrl: string;
  onSelect: (cloneUrl: string) => void;
  onReload: () => void;
}) {
  const [includeReadOnly, setIncludeReadOnly] = useState(false);
  const [filterText, setFilterText] = useState('');

  if (patState.kind === 'unknown') {
    return <p className="text-[11px] text-slate-gray">checking GitHub token…</p>;
  }
  if (patState.kind === 'missing') {
    return (
      <p className="text-[11px] text-slate-gray">
        Add a GitHub personal access token under <span className="font-mono">Settings → github</span> to
        load your repos here.
      </p>
    );
  }
  if (reposState.kind === 'loading') {
    return <p className="text-[11px] text-slate-gray">loading your repos…</p>;
  }
  if (reposState.kind === 'error') {
    return (
      <div className="space-y-1">
        <p className="text-[11px] text-[#f0a0a0]">{reposState.message}</p>
        <ActionButton onClick={onReload}>retry</ActionButton>
      </div>
    );
  }
  if (reposState.kind === 'idle') {
    return (
      <ActionButton onClick={onReload}>load my repos</ActionButton>
    );
  }
  const { repos } = reposState;
  const writable = includeReadOnly ? repos : repos.filter((r) => r.canPush);
  const filter = filterText.trim().toLowerCase();
  const visible = filter
    ? writable.filter((r) => r.fullName.toLowerCase().includes(filter))
    : writable;
  const readOnlyHidden = repos.length - writable.length;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wider text-slate-gray">
          your repos
        </p>
        <p className="font-mono text-[10px] text-slate-gray">
          {filter
            ? `${visible.length}/${writable.length} match`
            : `${writable.length} loaded`}
          {readOnlyHidden > 0 ? ` · ${readOnlyHidden} read-only hidden` : ''}
        </p>
      </div>
      <input
        type="text"
        value={filterText}
        onChange={(e) => setFilterText(e.target.value)}
        placeholder="filter by name…"
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[11px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
      />
      <select
        value={selectedUrl}
        onChange={(e) => onSelect(e.target.value)}
        size={Math.min(8, Math.max(3, visible.length + 1))}
        className="w-full rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
      >
        {visible.length === 0 ? (
          <option value="" disabled>
            no matches — clear the filter or paste the URL below
          </option>
        ) : (
          <option value="">— pick a repo —</option>
        )}
        {visible.map((repo) => (
          <option key={repo.fullName} value={repo.cloneUrl}>
            {repo.fullName}
            {repo.private ? ' · private' : ''}
            {repo.canPush ? '' : ' · read-only'}
          </option>
        ))}
      </select>
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-[11px] text-slate-gray">
          <input
            type="checkbox"
            checked={includeReadOnly}
            onChange={(e) => setIncludeReadOnly(e.target.checked)}
            className="h-3 w-3 accent-primary"
          />
          include read-only
        </label>
        <button
          type="button"
          onClick={onReload}
          className="font-mono text-[10px] uppercase tracking-wider text-slate-gray hover:text-soft-white"
          title="re-fetch /user/repos"
        >
          ↻ reload
        </button>
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-[#2a2a35] bg-[#0f0f17] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-slate-gray transition-colors hover:border-soft-white hover:text-soft-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
