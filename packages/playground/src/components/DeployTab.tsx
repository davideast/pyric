/**
 * Deploy tab — collects the target Firebase project and surfaces the
 * orchestrating Deploy button + per-track retry buttons. Sign-in
 * happens elsewhere (the save icon modal at the top of the playground)
 * so the playground has a single auth surface; the deploy hooks read
 * the resulting token via `useAccessToken`. If the user isn't signed
 * in, this tab shows a hint pointing them at the save icon.
 *
 * Auth is via Google Identity Services (`lib/auth/gis-token.ts`).
 * Tokens are `cloud-platform`-scoped and silently reissued from the
 * active Google session; no paste needed. See
 * `packages/playground/README.md` for the one-time GCP Console
 * setup.
 */
import { useEffect, useState } from 'react';

import { useAccessToken } from '~/lib/deploy/useAccessToken';
import { useDeployAll, type StepStatus } from '~/lib/deploy/useDeployAll';
import {
  fetchDefaultWebConfig,
  NoWebAppError,
  useFirebaseProjects,
} from '~/lib/deploy/useFirebaseProjects';
import { useHostingDeploy } from '~/lib/deploy/useHostingDeploy';
import { useIndexesDeploy } from '~/lib/deploy/useIndexesDeploy';
import { useIndexesProgress } from '~/lib/deploy/useIndexesProgress';
import { useRulesDeploy } from '~/lib/deploy/useRulesDeploy';
import { useTargetProject } from '~/lib/deploy/useTargetProject';
import type { DeployTarget } from '~/lib/store/workspace';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { useChatStore } from '~/lib/store/chat';
import { getAllTurnTraces } from '~/lib/store/trace';
import type { ContextWindowSnapshot } from '~/lib/agent/context-window';
import {
  exportSessionToFirebase,
  type RemoteExportResult,
} from '~/lib/sessions/remote-export';
import {
  getCurrentUserId,
  recordSessionRemoteExport,
} from '~/lib/sessions';
import {
  checkPyricRuleConfigured,
  ensurePyricRule,
  type ConfigureRulesOutcome,
  type RuleCheckResult,
} from '~/lib/firebase/storage-rules';
import type { IndexOperationStatus } from '~/lib/deploy/pendingIndexOps';

function ProjectsStatusLine({
  signedIn,
  loading,
  count,
  error,
  onRefresh,
}: {
  signedIn: boolean;
  loading: boolean;
  count: number;
  error: { code: string; message: string } | null;
  onRefresh: () => void;
}) {
  if (!signedIn) {
    return (
      <span className="text-[10px] font-mono text-slate-gray">
        sign in to load your projects, or type a project id manually
      </span>
    );
  }
  if (loading) {
    return <span className="text-[10px] font-mono text-slate-gray">loading projects…</span>;
  }
  if (error) {
    return (
      <span className="text-[10px] font-mono text-[#f0a0a0] break-words">
        {error.code}: {error.message}
        {' · '}
        <button
          type="button"
          onClick={onRefresh}
          className="underline text-slate-gray hover:text-soft-white"
        >
          retry
        </button>
      </span>
    );
  }
  return (
    <span className="text-[10px] font-mono text-slate-gray">
      {count} project{count === 1 ? '' : 's'} available
      {' · '}
      <button
        type="button"
        onClick={onRefresh}
        className="underline hover:text-soft-white"
      >
        refresh
      </button>
    </span>
  );
}

function ConfigField({
  label,
  value,
  onChange,
  placeholder,
  required,
  monospace,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  monospace?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-mono uppercase tracking-wider text-slate-gray">
        {label}
        {required ? <span className="text-[#f0a0a0]"> *</span> : null}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={[
          'px-2.5 py-1.5 rounded-md bg-[#1a1a22] border border-[#2a2a35]',
          'text-soft-white placeholder:text-[#5a5a68] text-[13px]',
          'focus:outline-none focus:border-[#4a4a58]',
          monospace ? 'font-mono' : '',
        ].join(' ')}
      />
    </label>
  );
}

interface DeployTabProps {
  sessionId?: string | null;
  contextWindow?: ContextWindowSnapshot;
}

function SessionExportSection({
  sessionId,
  contextWindow,
  target,
  signedIn,
  resolveToken,
}: {
  sessionId?: string | null;
  contextWindow?: ContextWindowSnapshot;
  target: DeployTarget | null;
  signedIn: boolean;
  resolveToken: () => Promise<string>;
}) {
  const [includeFullDetails, setIncludeFullDetails] = useState(false);
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'running'; step: string }
    | { status: 'rules-needed'; check: RuleCheckResult }
    | { status: 'configuring-rules' }
    | { status: 'rules-configured'; outcome: ConfigureRulesOutcome }
    | { status: 'done'; result: RemoteExportResult }
  >({ status: 'idle' });

  const canExport = Boolean(sessionId && target?.projectId && signedIn);
  const bucketId = target ? storageBucketForTarget(target) : null;

  const handleConfigureRules = async () => {
    if (!target?.projectId || !bucketId) return;
    setState({ status: 'configuring-rules' });
    try {
      const token = await resolveToken();
      const outcome = await ensurePyricRule(token, target.projectId, bucketId);
      setState({ status: 'rules-configured', outcome });
    } catch (e) {
      setState({
        status: 'done',
        result: {
          ok: false,
          code: 'storage-rules-config-failed',
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  };

  const handleExport = async () => {
    if (!sessionId) {
      setState({
        status: 'done',
        result: { ok: false, code: 'no-session', message: 'Open a saved session first.' },
      });
      return;
    }
    if (!target?.projectId) {
      setState({
        status: 'done',
        result: { ok: false, code: 'no-target', message: 'Save a target project first.' },
      });
      return;
    }
    if (!signedIn) {
      setState({
        status: 'done',
        result: { ok: false, code: 'not-signed-in', message: 'Sign in with Google first.' },
      });
      return;
    }

    try {
      setState({ status: 'running', step: 'preparing export' });
      const token = await resolveToken();
      if (includeFullDetails) {
        const check = await checkPyricRuleConfigured(
          token,
          target.projectId,
          bucketId ?? `${target.projectId}.firebasestorage.app`,
        );
        if (check.state !== 'configured') {
          setState({ status: 'rules-needed', check });
          return;
        }
      }

      const workspace = useWorkspaceStore.getState();
      const messages = useChatStore.getState().messages;
      // Full trace payloads live outside React state — read them at
      // export time (see store/trace.ts memory architecture).
      const tracesByTurn = getAllTurnTraces();
      const result = await exportSessionToFirebase({
        sessionId,
        projectId: target.projectId,
        accessToken: token,
        includeFullDetails,
        workspace: {
          rules: workspace.rules,
          appSource: workspace.appSource,
          code: '',
          deployTarget: target,
        },
        messages,
        tracesByTurn,
        ...(contextWindow ? { contextSnapshot: contextWindow } : {}),
        ...(target.firebaseConfig ? { firebaseConfig: target.firebaseConfig } : {}),
      });
      if (result.localMeta) {
        await recordSessionRemoteExport(
          getCurrentUserId(),
          sessionId,
          result.localMeta,
        ).catch((e) => {
          console.warn('[playground] failed to record remote export metadata:', e);
        });
      }
      setState({ status: 'done', result });
    } catch (e) {
      setState({
        status: 'done',
        result: {
          ok: false,
          code: 'export-failed',
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  };

  return (
    <section className="pt-3 border-t border-[#2a2a35] space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-[10px] font-mono uppercase tracking-wider text-soft-white font-bold">
            Session telemetry export
          </h2>
          <p className="text-[11px] text-slate-gray leading-relaxed">
            Writes queryable summary rows to Firestore. Full details are opt-in
            and land in Firebase Storage under the same export id.
          </p>
        </div>
        {state.status === 'running' ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">
            {state.step}
          </span>
        ) : null}
      </div>

      <label className="flex items-start gap-2 rounded-md border border-[#2a2a35] bg-[#111119] px-3 py-2">
        <input
          type="checkbox"
          checked={includeFullDetails}
          onChange={(e) => setIncludeFullDetails(e.target.checked)}
          className="mt-0.5 size-4 accent-[#8bb7ff]"
        />
        <span className="space-y-1">
          <span className="block text-[12px] font-semibold text-soft-white">
            Include full details in Firebase Storage
          </span>
          <span className="block text-[11px] text-slate-gray leading-relaxed">
            Includes raw provider-visible requests, tool results, workspace
            files, chat, traces, and telemetry. Firestore keeps summaries only.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void handleExport();
          }}
          disabled={!canExport || state.status === 'running' || state.status === 'configuring-rules'}
          className={[
            'px-3 py-1.5 rounded-md transition-colors',
            'text-[11px] font-mono uppercase tracking-wider',
            canExport && state.status !== 'running' && state.status !== 'configuring-rules'
              ? 'bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white'
              : 'bg-[#1a1a22] text-[#5a5a68] cursor-not-allowed',
          ].join(' ')}
        >
          {state.status === 'running' ? 'Exporting…' : 'Export telemetry'}
        </button>
        <span className="text-[10px] font-mono text-slate-gray">
          {target?.projectId
            ? `target → ${target.projectId}`
            : 'save a target project first'}
        </span>
      </div>

      {state.status === 'rules-needed' ? (
        <div className="rounded-md border border-[#4a3a2a] bg-[#1a1510] px-3 py-2 space-y-2">
          <p className="text-[11px] font-mono text-[#f0c878]">
            Storage rules are not configured for full-detail exports.
          </p>
          {state.check.state === 'check-failed' ? (
            <p className="text-[10px] font-mono text-[#f0a0a0] break-words">
              {state.check.message}
            </p>
          ) : null}
          <p className="text-[11px] text-slate-gray leading-relaxed">
            Full details write nested artifacts under{' '}
            <code>pyric_sessions/&lt;uid&gt;/&lt;session&gt;/exports/&lt;export&gt;/</code>.
            Configure the owner-scoped rule before exporting raw details.
          </p>
          <button
            type="button"
            onClick={() => {
              void handleConfigureRules();
            }}
            className={[
              'px-3 py-1.5 rounded-md transition-colors',
              'text-[11px] font-mono uppercase tracking-wider',
              'bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white',
            ].join(' ')}
          >
            Configure Storage rules
          </button>
        </div>
      ) : null}

      {state.status === 'rules-configured' ? (
        <div className="rounded-md border border-[#2f4a36] bg-[#101810] px-3 py-2 text-[11px] font-mono text-[#a0e0a0]">
          {state.outcome.ok
            ? `Storage rules ready · ${state.outcome.status}`
            : `${state.outcome.code}: ${state.outcome.message}`}
        </div>
      ) : null}

      {state.status === 'done' ? <ExportResultPanel result={state.result} /> : null}
    </section>
  );
}

/** Deep-link to a Firestore document in the Firebase console. Segments are
 *  joined with `~2F` (the console's path separator). */
function firestoreConsoleUrl(projectId: string, docPath: string): string {
  const path = docPath.split('/').filter(Boolean).map(encodeURIComponent).join('~2F');
  return `https://console.firebase.google.com/project/${encodeURIComponent(projectId)}/firestore/databases/-default-/data/~2F${path}`;
}

/** Deep-link to a Storage folder in the Firebase console. */
function storageConsoleUrl(projectId: string, bucketId: string, prefix: string): string {
  const path = prefix.split('/').filter(Boolean).map(encodeURIComponent).join('~2F');
  return `https://console.firebase.google.com/project/${encodeURIComponent(projectId)}/storage/${encodeURIComponent(bucketId)}/files/~2F${path}`;
}

function ExportResultPanel({ result }: { result: RemoteExportResult }) {
  const color = result.ok ? 'border-[#2f4a36] bg-[#101810]' : 'border-[#4a2f36] bg-[#181010]';
  return (
    <div className={`rounded-md border ${color} px-3 py-2 space-y-2`}>
      <div className="text-[11px] font-mono text-soft-white">
        {result.ok ? 'Export complete' : `${result.code}: ${result.message}`}
      </div>
      {result.exportId ? (
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[10px] font-mono">
          <dt className="uppercase tracking-wider text-slate-gray">export id</dt>
          <dd className="text-soft-white break-all">{result.exportId}</dd>
          {result.firestoreDocPath ? (
            <>
              <dt className="uppercase tracking-wider text-slate-gray">Firestore</dt>
              <dd className="text-soft-white break-all">{result.firestoreDocPath}</dd>
            </>
          ) : null}
          {result.storageManifestPath ? (
            <>
              <dt className="uppercase tracking-wider text-slate-gray">Storage</dt>
              <dd className="text-soft-white break-all">{result.storageManifestPath}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {result.storageArtifacts && result.storageArtifacts.length > 0 ? (
        <p className="text-[10px] font-mono text-slate-gray">
          {result.storageArtifacts.length} artifact{result.storageArtifacts.length === 1 ? '' : 's'}
          {' · '}
          {formatBytes(result.storageArtifacts.reduce((sum, artifact) => sum + artifact.size, 0))}
        </p>
      ) : null}
      {result.ok && result.localMeta?.projectId ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5 text-[10px] font-mono">
          <a
            href={firestoreConsoleUrl(result.localMeta.projectId, result.localMeta.firestoreDocPath)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#a4c4f0] underline hover:text-soft-white"
          >
            Open in Firebase Console → Firestore
          </a>
          {result.localMeta.storageManifestPath && result.localMeta.bucketId ? (
            <a
              href={storageConsoleUrl(
                result.localMeta.projectId,
                result.localMeta.bucketId,
                result.localMeta.storageManifestPath.replace(/\/manifest\.json$/, ''),
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#a4c4f0] underline hover:text-soft-white"
            >
              Open in Firebase Console → Storage
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DeployTab({ sessionId, contextWindow }: DeployTabProps) {
  const { target, setTarget } = useTargetProject();
  const { signedIn, resolveToken } = useAccessToken();
  const {
    projects,
    loading: projectsLoading,
    error: projectsError,
    refresh: refreshProjects,
  } = useFirebaseProjects();

  // Local draft so partial edits don't fire localStorage writes on
  // every keystroke. Committed to the store on blur or explicit
  // save. Initialized from the persisted target.
  const [draft, setDraft] = useState<DeployTarget>(() => target ?? blankTarget());

  // Web-config fetch state — separate from sign-in / projects so the
  // user can see specifically when the config call is in flight or
  // why it failed.
  const [configFetching, setConfigFetching] = useState<boolean>(false);
  const [configError, setConfigError] = useState<{ code: string; message: string; consoleUrl?: string } | null>(null);

  const fetchConfigForCurrentProject = async () => {
    const pid = draft.projectId.trim();
    if (!pid) {
      setConfigError({ code: 'invalid-input', message: 'Set a Project ID first.' });
      return;
    }
    if (!signedIn) {
      setConfigError({ code: 'invalid-input', message: 'Sign in with Google first.' });
      return;
    }
    setConfigFetching(true);
    setConfigError(null);
    try {
      const token = await resolveToken();
      const config = await fetchDefaultWebConfig(token, pid);
      setDraft((d) => ({
        ...d,
        projectId: pid,
        firebaseConfig: {
          apiKey: config.apiKey,
          authDomain: config.authDomain,
          projectId: config.projectId,
          appId: config.appId,
          ...(config.storageBucket ? { storageBucket: config.storageBucket } : {}),
          ...(config.messagingSenderId ? { messagingSenderId: config.messagingSenderId } : {}),
        },
      }));
    } catch (e) {
      if (e instanceof NoWebAppError) {
        setConfigError({
          code: 'no-web-app',
          message: e.message,
          consoleUrl: `https://console.firebase.google.com/project/${encodeURIComponent(pid)}/settings/general`,
        });
      } else {
        setConfigError({
          code: 'fetch-failed',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      setConfigFetching(false);
    }
  };

  // Keep the draft in sync if the persisted target changes from
  // another surface (e.g. session save/load).
  useEffect(() => {
    if (target) setDraft(target);
  }, [target]);

  const commit = () => {
    if (!draft.projectId.trim()) {
      setTarget(null);
      return;
    }
    setTarget({
      ...draft,
      projectId: draft.projectId.trim(),
      siteId: draft.siteId?.trim() || undefined,
    });
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-4 pb-6 space-y-5">
      <section className="space-y-3">
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-soft-white font-bold">
          Target project
        </h2>
        <p className="text-[11px] text-slate-gray leading-relaxed">
          Where the deploy hooks ship code, rules, and indexes. You own this
          project — the playground only writes to it via Google APIs.
        </p>
        <div className="grid grid-cols-1 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-gray">
              Project ID
              <span className="text-[#f0a0a0]"> *</span>
            </span>
            <input
              type="text"
              list="firebase-projects-list"
              value={draft.projectId}
              onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
              placeholder={signedIn ? 'pick or type a project id' : 'sign in to list your projects'}
              className={[
                'px-2.5 py-1.5 rounded-md bg-[#1a1a22] border border-[#2a2a35]',
                'text-soft-white placeholder:text-[#5a5a68] text-[13px] font-mono',
                'focus:outline-none focus:border-[#4a4a58]',
              ].join(' ')}
            />
            <datalist id="firebase-projects-list">
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.displayName && p.displayName !== p.projectId ? p.displayName : ''}
                </option>
              ))}
            </datalist>
            <ProjectsStatusLine
              signedIn={signedIn}
              loading={projectsLoading}
              count={projects.length}
              error={projectsError}
              onRefresh={() => {
                void refreshProjects();
              }}
            />
          </label>
          <ConfigField
            label="Site ID (optional)"
            value={draft.siteId ?? ''}
            onChange={(siteId) => setDraft({ ...draft, siteId })}
            placeholder="defaults to Project ID"
            monospace
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-soft-white font-bold">
          Firebase web config
        </h2>
        <p className="text-[11px] text-slate-gray leading-relaxed">
          Pasted into the deployed bundle's <code>./firebase</code> so the
          shipped app talks to the right project. Click{' '}
          <span className="font-mono">Fetch from project</span> to auto-fill
          from the project's default web app, or paste manually.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              void fetchConfigForCurrentProject();
            }}
            disabled={!signedIn || !draft.projectId.trim() || configFetching}
            className={[
              'px-3 py-1.5 rounded-md transition-colors',
              'text-[11px] font-mono uppercase tracking-wider',
              !signedIn || !draft.projectId.trim() || configFetching
                ? 'bg-[#1a1a22] text-[#5a5a68] cursor-not-allowed'
                : 'bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white',
            ].join(' ')}
          >
            {configFetching ? 'Fetching…' : 'Fetch from project'}
          </button>
          {configError ? (
            <span className="text-[10px] font-mono text-[#f0a0a0] break-words">
              {configError.code}: {configError.message}
              {configError.consoleUrl ? (
                <>
                  {' · '}
                  <a
                    href={configError.consoleUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline"
                  >
                    open Console
                  </a>
                </>
              ) : null}
            </span>
          ) : draft.firebaseConfig?.apiKey ? (
            <span className="text-[10px] font-mono text-[#a0e0a0]">
              config loaded
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3">
          <ConfigField
            label="apiKey"
            value={draft.firebaseConfig?.apiKey ?? ''}
            onChange={(apiKey) =>
              setDraft({
                ...draft,
                firebaseConfig: { ...emptyConfig(draft), ...draft.firebaseConfig, apiKey },
              })
            }
            monospace
          />
          <ConfigField
            label="authDomain"
            value={draft.firebaseConfig?.authDomain ?? ''}
            onChange={(authDomain) =>
              setDraft({
                ...draft,
                firebaseConfig: {
                  ...emptyConfig(draft),
                  ...draft.firebaseConfig,
                  authDomain,
                },
              })
            }
            monospace
          />
          <ConfigField
            label="appId"
            value={draft.firebaseConfig?.appId ?? ''}
            onChange={(appId) =>
              setDraft({
                ...draft,
                firebaseConfig: { ...emptyConfig(draft), ...draft.firebaseConfig, appId },
              })
            }
            monospace
          />
        </div>
      </section>

      {!signedIn ? (
        <section className="rounded-md border border-[#3a3a48] bg-[#1a1a22] px-3 py-2">
          <p className="text-[11px] font-mono text-[#f0c878]">
            Not signed in. Click the save icon at the top of the playground to
            sign in with Google — the same auth covers session storage AND
            deploys.
          </p>
        </section>
      ) : null}

      <div className="pt-1 flex items-center gap-3">
        <button
          type="button"
          onClick={commit}
          className={[
            'px-3 py-1.5 rounded-md bg-[#2a2a35] hover:bg-[#3a3a48] transition-colors',
            'text-[11px] font-mono uppercase tracking-wider text-soft-white',
          ].join(' ')}
        >
          Save target
        </button>
        {target?.projectId ? (
          <span className="text-[10px] font-mono text-slate-gray">
            saved → <code>{target.projectId}</code>
          </span>
        ) : (
          <span className="text-[10px] font-mono text-slate-gray">no target saved</span>
        )}
      </div>

      <SessionExportSection
        sessionId={sessionId}
        contextWindow={contextWindow}
        target={target}
        signedIn={signedIn}
        resolveToken={resolveToken}
      />

      <DeployAllSection />
      <IndexesProgressSection />

      <section className="pt-3 border-t border-[#2a2a35] space-y-2">
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-soft-white font-bold">
          Re-run individual tracks
        </h2>
        <p className="text-[11px] text-slate-gray leading-relaxed">
          Use these to retry a single track after a failed deploy without
          re-running the whole pipeline.
        </p>
        <div className="flex flex-col gap-2 pt-1">
          <RulesDeployButton />
          <IndexesDeployButton />
        </div>
      </section>
      <DeploySection />
    </div>
  );
}

function DeployAllSection() {
  const { state, deploy, canDeploy } = useDeployAll();

  const running = state.phase === 'running';

  const headline = (() => {
    if (state.phase === 'idle') {
      return canDeploy
        ? 'Ready to deploy rules, hosting, and indexes to your target project.'
        : 'Set Project ID, paste a token, and write app source to enable deploy.';
    }
    if (state.phase === 'running') return 'Deploying…';
    if (state.phase === 'success') return 'Deploy succeeded.';
    return 'Deploy finished with errors. See per-step status below.';
  })();

  return (
    <section className="pt-3 border-t border-[#2a2a35] space-y-3">
      <h2 className="text-[10px] font-mono uppercase tracking-wider text-soft-white font-bold">
        Deploy
      </h2>
      <p className="text-[11px] text-slate-gray leading-relaxed">
        Runs pre-flight, then rules + hosting in parallel, then index
        creation. Per-step error attribution; no rollback.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-deploy-track="all"
          onClick={() => {
            void deploy();
          }}
          disabled={!canDeploy || running}
          className={[
            'px-3 py-1.5 rounded-md transition-colors',
            'text-[11px] font-mono uppercase tracking-wider',
            canDeploy && !running
              ? 'bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white'
              : 'bg-[#1a1a22] text-[#5a5a68] cursor-not-allowed',
          ].join(' ')}
        >
          {running ? 'Deploying…' : 'Deploy to Firebase'}
        </button>
        <span className="text-[10px] font-mono text-slate-gray">{headline}</span>
      </div>

      {state.phase !== 'idle' ? (
        <div className="flex flex-col gap-1 pt-1">
          <StepRow label="Preflight" status={state.preflight} render={renderPreflight} />
          <StepRow label="Rules" status={state.rules} render={renderRules} />
          <StepRow label="Hosting" status={state.hosting} render={renderHosting} />
          <StepRow label="Indexes" status={state.indexes} render={renderIndexes} />
        </div>
      ) : null}
    </section>
  );
}

function StepRow<T>({
  label,
  status,
  render,
}: {
  label: string;
  status: StepStatus<T>;
  render: (data: T) => string;
}) {
  const color = (() => {
    switch (status.kind) {
      case 'ok': return 'text-[#a0e0a0]';
      case 'failed': return 'text-[#f0a0a0]';
      case 'running': return 'text-soft-white';
      case 'skipped': return 'text-[#7a7a88]';
      case 'pending':
      default: return 'text-slate-gray';
    }
  })();
  const symbol = (() => {
    switch (status.kind) {
      case 'ok': return '✓';
      case 'failed': return '✗';
      case 'running': return '…';
      case 'skipped': return '–';
      case 'pending':
      default: return '·';
    }
  })();
  const summary = (() => {
    switch (status.kind) {
      case 'pending': return 'pending';
      case 'running': return 'running…';
      case 'ok': return render(status.data);
      case 'failed': return `${status.error.code}: ${status.error.message}`;
      case 'skipped': return `skipped — ${status.reason}`;
    }
  })();
  return (
    <div className={`text-[11px] font-mono ${color} flex items-baseline gap-2`}>
      <span className="w-3 text-center">{symbol}</span>
      <span className="w-16 uppercase tracking-wider text-[10px]">{label}</span>
      <span className="break-all">{summary}</span>
    </div>
  );
}

function renderPreflight(data: { results: { id: string; ok: boolean }[] }): string {
  return `${data.results.filter((r) => r.ok).length} of ${data.results.length} checks passed`;
}

function renderRules(data: { createdAt: string }): string {
  return `deployed · ${data.createdAt}`;
}

function renderHosting(data: { hostingUrl: string; fileCount: number; uploadedCount: number }): string {
  return `${data.uploadedCount}/${data.fileCount} files · ${data.hostingUrl}`;
}

function renderIndexes(data: { operations: unknown[]; failures: number; empty: boolean }): string {
  if (data.empty) return 'no indexes inferred · nothing to deploy';
  return `${data.operations.length} index${data.operations.length === 1 ? '' : 'es'} building · ${data.failures} failed`;
}

function IndexesProgressSection() {
  const { entries, counts, polling, refresh, clearCompleted } = useIndexesProgress();

  if (entries.length === 0) return null;

  const allDone = counts.creating === 0;
  const allReady = allDone && counts.failed === 0;

  const headline = (() => {
    if (allReady) return `All ${counts.total} indexes ready. Queries will work now.`;
    if (allDone) return `${counts.ready} ready · ${counts.failed} failed.`;
    return `${counts.creating} building · ${counts.ready} ready${counts.failed > 0 ? ` · ${counts.failed} failed` : ''}.`;
  })();

  return (
    <section className="pt-3 border-t border-[#2a2a35] space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-soft-white font-bold">
          Indexes — build progress
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            disabled={polling}
            className={[
              'px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider',
              polling
                ? 'bg-[#1a1a22] text-[#5a5a68] cursor-not-allowed'
                : 'bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white',
            ].join(' ')}
          >
            {polling ? 'polling…' : 'refresh'}
          </button>
          {allDone ? (
            <button
              type="button"
              onClick={clearCompleted}
              className="px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white"
            >
              clear
            </button>
          ) : null}
        </div>
      </div>
      <p className={`text-[11px] font-mono ${allReady ? 'text-[#a0e0a0]' : 'text-slate-gray'}`}>
        {headline}
      </p>
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <IndexProgressRow key={entry.operationName} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function IndexProgressRow({ entry }: { entry: IndexOperationStatus }) {
  const color = (() => {
    switch (entry.state) {
      case 'READY':
        return 'text-[#a0e0a0]';
      case 'NEEDS_REPAIR':
      case 'failed':
      case 'NOT_FOUND':
        return 'text-[#f0a0a0]';
      case 'CREATING':
      default:
        return 'text-soft-white';
    }
  })();
  const symbol = (() => {
    switch (entry.state) {
      case 'READY':
        return '✓';
      case 'NEEDS_REPAIR':
      case 'failed':
      case 'NOT_FOUND':
        return '✗';
      case 'CREATING':
      default:
        return '…';
    }
  })();
  const fieldsSummary = entry.fields
    .map((f) => `${f.fieldPath}${f.order ? ` ${f.order}` : ''}${f.arrayConfig ? ` ${f.arrayConfig}` : ''}`)
    .join(', ');
  return (
    <li className={`text-[11px] font-mono ${color} flex items-baseline gap-2`}>
      <span className="w-3 text-center">{symbol}</span>
      <span className="font-bold">{entry.collectionGroup}</span>
      <span className="text-slate-gray break-all">({fieldsSummary})</span>
      <span className="ml-auto uppercase tracking-wider text-[10px]">
        {entry.state === 'failed' && entry.error ? entry.error : entry.state}
      </span>
    </li>
  );
}

function RulesDeployButton() {
  const { state, deploy, canDeploy } = useRulesDeploy();
  const deploying = state.status === 'deploying';
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-deploy-track="rules"
        onClick={() => {
          void deploy();
        }}
        disabled={!canDeploy || deploying}
        className={[
          'self-start px-3 py-1.5 rounded-md transition-colors',
          'text-[11px] font-mono uppercase tracking-wider text-soft-white',
          canDeploy && !deploying
            ? 'bg-[#2a2a35] hover:bg-[#3a3a48]'
            : 'bg-[#1a1a22] text-[#5a5a68] cursor-not-allowed',
        ].join(' ')}
      >
        {deploying ? 'Deploying rules…' : 'Deploy rules'}
      </button>
      {state.status === 'success' ? (
        <span className="text-[10px] font-mono text-slate-gray">
          rules deployed{state.createdAt ? ` · ${state.createdAt}` : ''}
        </span>
      ) : null}
      {state.status === 'error' && state.error ? (
        <span className="text-[10px] font-mono text-[#f0a0a0] break-all">
          {state.error.code}: {state.error.message}
        </span>
      ) : null}
    </div>
  );
}

function IndexesDeployButton() {
  const { state, deploy, canDeploy } = useIndexesDeploy();
  const busy = state.status === 'extracting' || state.status === 'creating';
  const label = (() => {
    if (state.status === 'extracting') return 'Extracting indexes…';
    if (state.status === 'creating') return 'Creating indexes…';
    return 'Deploy indexes';
  })();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-deploy-track="indexes"
        onClick={() => {
          void deploy();
        }}
        disabled={!canDeploy || busy}
        className={[
          'self-start px-3 py-1.5 rounded-md transition-colors',
          'text-[11px] font-mono uppercase tracking-wider text-soft-white',
          canDeploy && !busy
            ? 'bg-[#2a2a35] hover:bg-[#3a3a48]'
            : 'bg-[#1a1a22] text-[#5a5a68] cursor-not-allowed',
        ].join(' ')}
      >
        {label}
      </button>
      {state.status === 'success' && state.empty ? (
        <span className="text-[10px] font-mono text-slate-gray">
          no indexes inferred from app source · nothing to deploy
        </span>
      ) : null}
      {state.status === 'success' && !state.empty ? (
        <span className="text-[10px] font-mono text-slate-gray">
          {state.operations.length} index{state.operations.length === 1 ? '' : 'es'} building · {state.operations.length} CREATING
        </span>
      ) : null}
      {state.status === 'partial' ? (
        <span className="text-[10px] font-mono text-[#f0a0a0] break-all">
          partial: {state.operations.length} started · {state.error?.message}
        </span>
      ) : null}
      {state.status === 'error' && state.error ? (
        <span className="text-[10px] font-mono text-[#f0a0a0] break-all">
          {state.error.code}: {state.error.message}
        </span>
      ) : null}
    </div>
  );
}

function DeploySection() {
  const { state, deploy, canDeploy } = useHostingDeploy();

  const busy = state.status === 'bundling' || state.status === 'uploading';
  const disabled = !canDeploy || busy;

  const statusLine = (() => {
    switch (state.status) {
      case 'bundling':
        return 'Bundling app source…';
      case 'uploading':
        return state.fileCount
          ? `Uploading ${state.fileCount} file${state.fileCount === 1 ? '' : 's'} to Hosting…`
          : 'Uploading to Hosting…';
      case 'success':
        return state.uploadedCount !== undefined && state.fileCount !== undefined
          ? `Deployed. ${state.uploadedCount} of ${state.fileCount} file${state.fileCount === 1 ? '' : 's'} uploaded (rest deduped).`
          : 'Deployed.';
      case 'error':
        return null;
      case 'idle':
      default:
        return canDeploy
          ? 'Ready to deploy the current app source.'
          : 'Set Project ID, paste a token, and write app source to enable deploy.';
    }
  })();

  return (
    <section className="pt-3 border-t border-[#2a2a35] space-y-3">
      <h2 className="text-[10px] font-mono uppercase tracking-wider text-soft-white font-bold">
        Deploy to Hosting
      </h2>
      <p className="text-[11px] text-slate-gray leading-relaxed">
        Bundles the current app source and ships it to Firebase Hosting under
        the target site.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void deploy();
          }}
          disabled={disabled}
          className={[
            'px-3 py-1.5 rounded-md transition-colors',
            'text-[11px] font-mono uppercase tracking-wider',
            disabled
              ? 'bg-[#1a1a22] text-[#5a5a68] cursor-not-allowed'
              : 'bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white',
          ].join(' ')}
        >
          {busy ? state.status : 'Deploy to Hosting'}
        </button>
        {statusLine ? (
          <span className="text-[10px] font-mono text-slate-gray">{statusLine}</span>
        ) : null}
      </div>
      {state.status === 'success' && state.hostingUrl ? (
        <p className="text-[11px] font-mono">
          <span className="text-slate-gray">live → </span>
          <a
            href={state.hostingUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[#a0c4f0] hover:underline"
          >
            {state.hostingUrl}
          </a>
          <span className="text-slate-gray text-[10px] ml-2">
            (propagation can take a few seconds)
          </span>
        </p>
      ) : null}
      {state.status === 'error' && state.error ? (
        <div className="text-[11px] font-mono space-y-1">
          <p className="text-[#f0a0a0]">
            <span className="uppercase tracking-wider">{state.error.code}</span>
            {state.error.recoverable ? (
              <span className="ml-2 text-[10px] text-slate-gray">(retry safe)</span>
            ) : null}
          </p>
          <p className="text-slate-gray break-words whitespace-pre-wrap">
            {state.error.message}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function blankTarget(): DeployTarget {
  return { projectId: '' };
}

function emptyConfig(t: DeployTarget): NonNullable<DeployTarget['firebaseConfig']> {
  // Project-id is always required in firebaseConfig; default to the
  // target's projectId so the user doesn't have to type it twice.
  return { apiKey: '', authDomain: '', projectId: t.projectId };
}

function storageBucketForTarget(target: DeployTarget): string {
  return target.firebaseConfig?.storageBucket || `${target.projectId}.firebasestorage.app`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
