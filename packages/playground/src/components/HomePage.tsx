/**
 * Home page — landing route. Two-column layout on desktop:
 *
 *   ┌────────────────────────────┬──────────────────┐
 *   │ Prompt composer            │ Recent sessions  │
 *   │ (left, grows with content) │ (right, list)    │
 *   └────────────────────────────┴──────────────────┘
 *
 * Mobile stacks them vertically. The composer is the centerpiece —
 * auto-growing textarea, no internal scrollbar, generous padding,
 * inline prompt enhancement.
 *
 * Enhancement runs on this page (not deferred to the workspace) so a
 * page refresh between "enhance" and "start session" can't drop the
 * generated text. The enhanced version streams in as a secondary card
 * below the textarea; "Use this" replaces the textarea content (the
 * user explicitly chooses to overwrite). "Discard" hides the card and
 * leaves the original intact.
 *
 * The header (TopBar + model picker + key/settings/auth modals)
 * matches the workspace exactly so the user can pick a model and set
 * an API key before they submit their first prompt.
 *
 * Sessions live in `@pyric/sandbox`-backed local storage (see
 * `~/lib/sessions/`) — no auth required, no network, no Firestore
 * dependency. Sign-in only matters for deploy + promote (handled on
 * the workspace page).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  deleteSession,
  flushSessions,
  saveSession,
  type SessionMeta,
  type SessionPayload,
} from '~/lib/sessions';
import { stashPendingPrompt } from '~/lib/sessions/pending-prompt';
import {
  detectContextSignalMatches,
} from '~/lib/agent/context';
import { listSkills } from '~/lib/skills/registry';
import { useSlashCommands } from './SlashCommandMenu';
import { useHomeSessions } from '~/hooks/useHomeSessions';
import { enhancePrompt, countWords } from '~/lib/agent/prompt-enhancer/enhance';
import { createRepository, getAuthenticatedUser, listAccessibleRepos } from '~/lib/git/github-api';
import { getStoredPAT } from '~/lib/git/github-auth';
import { suggestRepoNameFromPrompt } from '~/lib/git/suggest-repo-name';
import { PROVIDER_LIST, PROVIDERS } from '~/lib/llm/registry';
import { ensureBufferPolyfill } from '~/lib/git/buffer-polyfill';
import { useOllamaModelsStore } from '~/lib/store/ollamaModels';
import {
  importFromGitHub,
  WorkspaceImportError,
} from '~/lib/workspace/import-from-github';
import '~/lib/debug/expose';
import {
  isPlaygroundCommandMessage,
  isStudioEmbedSearch,
  playgroundHomeHref,
  playgroundSessionHref,
  readPlaygroundSandboxMode,
} from '~/lib/studio-embed';
import { useLlmStore } from '~/lib/store/llm';
import { ApiKeyForm } from './ApiKeyForm';
import { AgentModeControl } from './AgentModeControl';
import { buildApiKeyField } from './byok-field';
import { AuthModal } from './AuthModal';
import {
  canStartWithGitHubRepo,
  GitHubRepoSetup,
  githubStartBlockReason,
} from './GitHubRepoSetup';
import {
  canStartWithGitHubImport,
  GitHubImportSetup,
  githubImportBlockReason,
  type GitHubReposState,
} from './GitHubImportSetup';
import { Modal } from './Modal';
import { ModelPicker } from './ModelPicker';
import { PromptHighlightTextarea } from './PromptHighlightTextarea';
import { SettingsModal } from './SettingsModal';
import { TopBar } from './TopBar';

ensureBufferPolyfill();

const PROMPT_PLACEHOLDER =
  'Ask about Firestore rules, data models, Auth, RTDB, or building an app… (type / for shortcuts)';

type EnhanceState =
  | { kind: 'idle' }
  | { kind: 'streaming'; text: string }
  | { kind: 'ready'; text: string }
  | { kind: 'error'; text: string; message: string };

export function HomePage() {
  const embeddedInStudio =
    typeof window !== 'undefined' && isStudioEmbedSearch(window.location.search);
  const playgroundBase = import.meta.env.BASE_URL;
  const { sessions, loading, userId } = useHomeSessions();
  const [prompt, setPrompt] = useState('');
  // Skills chosen for the session about to be created (via the `/`
  // menu in the composer). Ride into the new session's payload; the
  // playground's skills store hydrates from it on load.
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const toggleSelectedSkill = useCallback((id: string) => {
    setSelectedSkills((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);
  const clearSelectedSkills = useCallback(() => setSelectedSkills([]), []);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [createRepo, setCreateRepo] = useState(false);
  const [importRepo, setImportRepo] = useState(false);
  const [selectedCloneUrl, setSelectedCloneUrl] = useState('');
  const [reposState, setReposState] = useState<GitHubReposState>({ kind: 'idle' });
  const [startPhase, setStartPhase] = useState<string | null>(null);
  const [importBlockers, setImportBlockers] = useState<string[] | null>(null);
  const [repoName, setRepoName] = useState('');
  const [repoNameSuggestion, setRepoNameSuggestion] = useState<string | null>(null);
  const [repoVisibility, setRepoVisibility] = useState<'public' | 'private'>('private');
  const [patPresent, setPatPresent] = useState<boolean | null>(null);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const repoNameTouchedRef = useRef(false);

  const handleCreateRepoChange = useCallback(
    (expanded: boolean) => {
      setCreateRepo(expanded);
      if (expanded) setImportRepo(false);
      if (!expanded) return;
      const suggested = suggestRepoNameFromPrompt(prompt);
      setRepoNameSuggestion(suggested);
      if (!repoNameTouchedRef.current && !repoName.trim()) {
        setRepoName(suggested);
      }
    },
    [prompt, repoName],
  );

  const loadImportRepos = useCallback(async () => {
    setReposState({ kind: 'loading' });
    try {
      const repos = await listAccessibleRepos();
      setReposState({ kind: 'ready', repos });
    } catch (e) {
      setReposState({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const handleImportRepoChange = useCallback(
    (expanded: boolean) => {
      setImportRepo(expanded);
      if (expanded) {
        setCreateRepo(false);
        setImportBlockers(null);
        if (reposState.kind === 'idle') void loadImportRepos();
      }
    },
    [loadImportRepos, reposState.kind],
  );

  // Header modal state — mirrors PlaygroundPage so the user can set
  // model + API key before submitting their first prompt.
  const [keysOpen, setKeysOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const openKeys = useCallback(() => {
    setSettingsOpen(false);
    setAuthOpen(false);
    setKeysOpen(true);
  }, []);
  const openSettings = useCallback(() => {
    setKeysOpen(false);
    setAuthOpen(false);
    setSettingsOpen(true);
  }, []);
  const openAccount = useCallback(() => {
    setKeysOpen(false);
    setSettingsOpen(false);
    setAuthOpen(true);
  }, []);

  useEffect(() => {
    if (!embeddedInStudio || typeof window === 'undefined') return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!isPlaygroundCommandMessage(event.data)) return;
      switch (event.data.type) {
        case 'pyric:playground:open-keys':
          openKeys();
          break;
        case 'pyric:playground:open-settings':
          openSettings();
          break;
        case 'pyric:playground:open-account':
          openAccount();
          break;
        case 'pyric:playground:set-model': {
          const provider = PROVIDERS[event.data.providerId];
          if (!provider) return;
          const modelId = provider.models.some((m) => m.id === event.data.modelId)
            ? event.data.modelId
            : provider.defaultModelId;
          useLlmStore.getState().setProvider(event.data.providerId, modelId);
          if (event.data.effort) {
            useLlmStore.getState().setOpenrouterEffort(event.data.effort);
          }
          break;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [embeddedInStudio, openAccount, openKeys, openSettings]);
  // Bumped by handleSaveKeys after keys are written to localStorage.
  // `hasKey` depends on it so the enhance button leaves its "Set API
  // key" state the moment a key is saved (byok is localStorage-backed,
  // not a reactive store, so nothing else triggers the recompute).
  const [keysTick, setKeysTick] = useState(0);

  const handleSaveKeys = useCallback((values: Record<string, string>) => {
    let ollamaUrlChanged = false;
    for (const def of PROVIDER_LIST) {
      const value = values[def.id];
      if (value && value.trim().length > 0) {
        def.byok.setKey(value);
        if (def.id === 'ollama') ollamaUrlChanged = true;
      }
    }
    if (ollamaUrlChanged) {
      void useOllamaModelsStore.getState().refresh();
    }
    setKeysTick((t) => t + 1);
    setKeysOpen(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getStoredPAT().then((token) => {
      if (!cancelled) setPatPresent(!!token);
    });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, createRepo, importRepo]);

  useEffect(() => {
    if (!patPresent) {
      setGithubLogin(null);
      return;
    }
    let cancelled = false;
    getAuthenticatedUser()
      .then((user) => {
        if (!cancelled) setGithubLogin(user.login);
      })
      .catch(() => {
        if (!cancelled) setGithubLogin(null);
      });
    return () => {
      cancelled = true;
    };
  }, [patPresent, settingsOpen]);

  // ─── Enhancement (inline on this page) ─────────────────────────────
  const [enhance, setEnhance] = useState<EnhanceState>({ kind: 'idle' });
  const enhanceAbortRef = useRef<AbortController | null>(null);
  const providerId = useLlmStore((s) => s.providerId);
  const modelId = useLlmStore((s) => s.modelId);

  // Abort any in-flight enhancement on unmount so a navigation
  // doesn't leak a pending stream.
  useEffect(() => () => enhanceAbortRef.current?.abort(), []);

  const hasKey = useMemo(() => {
    const def = PROVIDERS[providerId];
    return def ? def.byok.hasKey() : false;
  }, [providerId, keysTick]);

  const runEnhancement = useCallback(async () => {
    const raw = prompt.trim();
    if (!raw) return;
    const def = PROVIDERS[providerId];
    if (!def) return;
    const apiKey = def.byok.getKey();
    if (!apiKey) {
      setEnhance({
        kind: 'error',
        text: '',
        message: 'Set an API key first (key icon, top right).',
      });
      return;
    }

    enhanceAbortRef.current?.abort();
    const ac = new AbortController();
    enhanceAbortRef.current = ac;
    setEnhance({ kind: 'streaming', text: '' });

    try {
      let received = false;
      let accumulated = '';
      for await (const chunk of enhancePrompt({
        rawInput: raw,
        providerId,
        modelId,
        apiKey,
        activeSkillIds: selectedSkills,
        signal: ac.signal,
      })) {
        if (ac.signal.aborted) return;
        received = true;
        accumulated += chunk;
        setEnhance({ kind: 'streaming', text: accumulated });
      }
      if (ac.signal.aborted) return;
      if (!received) {
        setEnhance({
          kind: 'error',
          text: '',
          message:
            'Model returned no text. Try a different rough idea, or check your API key.',
        });
        return;
      }
      setEnhance({ kind: 'ready', text: accumulated });
    } catch (e) {
      if (ac.signal.aborted) return;
      setEnhance({
        kind: 'error',
        text: '',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (enhanceAbortRef.current === ac) enhanceAbortRef.current = null;
    }
  }, [prompt, providerId, modelId, selectedSkills]);

  const cancelEnhancement = useCallback(() => {
    enhanceAbortRef.current?.abort();
    setEnhance({ kind: 'idle' });
  }, []);

  const acceptEnhancement = useCallback(() => {
    if (enhance.kind === 'ready' || enhance.kind === 'streaming') {
      setPrompt(enhance.text);
    }
    setEnhance({ kind: 'idle' });
  }, [enhance]);

  const discardEnhancement = useCallback(() => {
    setEnhance({ kind: 'idle' });
  }, []);

  // ─── Submit ────────────────────────────────────────────────────────
  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = prompt.trim();
    if (starting) return;
    if (!importRepo && !trimmed) return;
    if (!canStartWithGitHubRepo({ createRepo, repoName, patPresent })) return;
    if (!canStartWithGitHubImport({ importRepo, selectedCloneUrl, patPresent })) return;
    enhanceAbortRef.current?.abort();
    setStarting(true);
    setStartPhase(null);
    setError(null);
    setImportBlockers(null);
    try {
      const sessionId = newSessionId();
      const sandboxMode = typeof window !== 'undefined'
        ? readPlaygroundSandboxMode(window.location.search)
        : 'isolated';
      let githubRepo: SessionMeta['githubRepo'] | undefined;
      let payload: SessionPayload;

      if (importRepo) {
        const repo =
          reposState.kind === 'ready'
            ? reposState.repos.find((r) => r.cloneUrl === selectedCloneUrl)
            : undefined;
        if (!repo) throw new Error('Selected repository not found — refresh the repo list.');

        const imported = await importFromGitHub({
          sessionId,
          repo,
          onProgress: setStartPhase,
        });
        payload = {
          version: 1,
          workspace: imported.workspace,
          conversation: [],
        };
        githubRepo = imported.githubRepo;
      } else {
        if (createRepo) {
          const result = await createRepository({
            name: repoName.trim(),
            visibility: repoVisibility,
          });
          githubRepo = { ...result, linkedAt: Date.now() };
        }
        payload = {
          version: 1,
          workspace: { rules: '', code: '', appSource: '' },
          conversation: [],
        };
      }

      // Skills picked in the composer ride into the new session.
      if (selectedSkills.length > 0) payload.activeSkills = selectedSkills;

      const title =
        trimmed.slice(0, 60).trim() ||
        (importRepo && reposState.kind === 'ready'
          ? reposState.repos.find((r) => r.cloneUrl === selectedCloneUrl)?.fullName.slice(0, 60) ??
            'Imported session'
          : 'New session');
      const preview =
        trimmed.slice(0, 120).trim() ||
        (githubRepo ? `Imported from ${githubRepo.fullName}` : '');

      await saveSession(userId, {
        id: sessionId,
        title,
        preview,
        payload,
        githubRepo,
        sandboxMode,
      });
      if (trimmed) stashPendingPrompt(sessionId, trimmed, 'send');
      // Commit the just-saved session to IndexedDB before navigating.
      // /playground restores from IndexedDB on load; the persistence
      // controller's debounced + beforeunload flush would otherwise race
      // (and lose) the navigation, dropping us into the bounce-back loop.
      await flushSessions();
      window.location.href = playgroundSessionHref(sessionId, {
        base: playgroundBase,
        embedded: embeddedInStudio,
      });
    } catch (e) {
      setStarting(false);
      setStartPhase(null);
      if (e instanceof WorkspaceImportError) {
        setImportBlockers(e.probe.blockers);
        setError(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const enhanceStreaming = enhance.kind === 'streaming';
  const canEnhance = !enhanceStreaming && prompt.trim().length > 0 && hasKey;
  const canStartGithub = canStartWithGitHubRepo({ createRepo, repoName, patPresent });
  const canStartImport = canStartWithGitHubImport({
    importRepo,
    selectedCloneUrl,
    patPresent,
  });
  const canStart = importRepo ? canStartImport : canStartGithub && !!prompt.trim();
  const githubBlockReason = importRepo
    ? githubImportBlockReason({ importRepo, selectedCloneUrl, patPresent })
    : githubStartBlockReason({ createRepo, repoName, patPresent });

  return (
    <div className="min-h-screen flex flex-col bg-content-bg text-soft-white">
      {!embeddedInStudio ? (
        <TopBar
          title="home"
          homeHref={playgroundHomeHref({ base: playgroundBase })}
          onOpenKeys={openKeys}
          onOpenSettings={openSettings}
          onOpenAccount={openAccount}
        >
          <div className="hidden md:flex">
            <ModelPicker />
          </div>
        </TopBar>
      ) : null}

      <main className="flex-1 overflow-y-auto custom-scrollbar px-4 sm:px-6 lg:px-10 py-10 sm:py-14">
        <div className="mx-auto w-full max-w-6xl">
          <div className="grid gap-x-12 gap-y-8 lg:gap-x-16 lg:grid-cols-[minmax(0,1fr)_minmax(280px,400px)]">
            {/* ── Left column: composer ────────────────────────────
                Both columns start with a small uppercase label so
                their top edges align visually. The label sits at the
                same baseline; the cards/lists below align flush. */}
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">
                  New session
                </h2>
                {prompt.trim().length > 0 ? (
                  <span className="text-[10px] font-mono text-slate-gray">
                    {countWords(prompt)} {countWords(prompt) === 1 ? 'word' : 'words'}
                  </span>
                ) : null}
              </div>
              <PromptComposer
                prompt={prompt}
                onPromptChange={setPrompt}
                onSubmit={handleSubmit}
                onKeyDown={handleKeyDown}
                selectedSkills={selectedSkills}
                onToggleSkill={toggleSelectedSkill}
                onClearSkills={clearSelectedSkills}
                onEnhance={runEnhancement}
                onCancelEnhance={cancelEnhancement}
                enhance={enhance}
                onAcceptEnhance={acceptEnhancement}
                onDiscardEnhance={discardEnhancement}
                canEnhance={canEnhance}
                enhanceStreaming={enhanceStreaming}
                hasKey={hasKey}
                onOpenKeys={openKeys}
                onOpenSettings={openSettings}
                starting={starting}
                canStart={canStart}
                githubBlockReason={githubBlockReason}
                error={error}
                createRepo={createRepo}
                onCreateRepoChange={handleCreateRepoChange}
                importRepo={importRepo}
                onImportRepoChange={handleImportRepoChange}
                selectedCloneUrl={selectedCloneUrl}
                onSelectedCloneUrlChange={setSelectedCloneUrl}
                reposState={reposState}
                onReloadRepos={loadImportRepos}
                importBlockers={importBlockers}
                startPhase={startPhase}
                repoName={repoName}
                onRepoNameChange={(v) => {
                  repoNameTouchedRef.current = true;
                  setRepoName(v);
                }}
                repoNameSuggestion={repoNameSuggestion}
                repoVisibility={repoVisibility}
                onRepoVisibilityChange={setRepoVisibility}
                githubLogin={githubLogin}
                patPresent={patPresent}
              />
            </section>

            {/* ── Right column: recent sessions ──────────────────── */}
            <aside className="min-w-0">
              <h2 className="mb-3 text-[10px] font-mono uppercase tracking-wider text-slate-gray">
                Recent sessions
              </h2>
              {loading ? (
                <p className="text-[12px] text-slate-gray">Loading…</p>
              ) : sessions.length === 0 ? (
                <p className="text-[12px] text-slate-gray">
                  No sessions yet. Start one on the left.
                </p>
              ) : (
                /* On mobile (single-column stack) the sessions list can
                   easily run longer than the viewport and push the
                   composer off the screen. Cap it to 40vh with an
                   internal scroll on small screens; let it grow
                   naturally in the right column on lg+. */
                <ul className="space-y-1.5 max-h-[40vh] overflow-y-auto custom-scrollbar pr-1 -mr-1 lg:max-h-none lg:overflow-visible lg:pr-0 lg:mr-0">
                  {sessions.map((s) => (
                    <SessionCard
                      key={s.id}
                      session={s}
                      playgroundBase={playgroundBase}
                      embeddedInStudio={embeddedInStudio}
                      isConfirmingDelete={confirmingDeleteId === s.id}
                      onConfirmDelete={() => setConfirmingDeleteId(s.id)}
                      onCancelDelete={() => setConfirmingDeleteId(null)}
                      onDelete={async () => {
                        setConfirmingDeleteId(null);
                        try {
                          await deleteSession(userId, s.id);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    />
                  ))}
                </ul>
              )}
            </aside>
          </div>
        </div>
      </main>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />

      <Modal open={keysOpen} onClose={() => setKeysOpen(false)} ariaLabel="API keys">
          <div className={embeddedInStudio ? 'mb-4' : 'md:hidden mb-4'}>
            <p className="text-[11px] uppercase tracking-wider text-slate-gray mb-2">
              Active model
            </p>
            <ModelPicker />
          </div>
          <ApiKeyForm
            title="API keys"
            subtitle="Bring your own keys. Stored in this browser only — never sent to a server we control."
            fields={PROVIDER_LIST.map((def) => buildApiKeyField(def)).filter((f) => f !== null)}
          onSubmit={handleSaveKeys}
          submitLabel="Save"
          footerText="Update or remove anytime."
        />
      </Modal>
    </div>
  );
}

// ─── Composer ────────────────────────────────────────────────────────

interface PromptComposerProps {
  prompt: string;
  onPromptChange: (v: string) => void;
  onSubmit: (e?: FormEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Skills picked for the session-to-be (`/` menu + chips). */
  selectedSkills: string[];
  onToggleSkill: (id: string) => void;
  onClearSkills: () => void;
  onEnhance: () => void;
  onCancelEnhance: () => void;
  enhance: EnhanceState;
  onAcceptEnhance: () => void;
  onDiscardEnhance: () => void;
  canEnhance: boolean;
  enhanceStreaming: boolean;
  hasKey: boolean;
  onOpenKeys: () => void;
  onOpenSettings: () => void;
  starting: boolean;
  canStart: boolean;
  githubBlockReason: string | null;
  error: string | null;
  createRepo: boolean;
  onCreateRepoChange: (v: boolean) => void;
  importRepo: boolean;
  onImportRepoChange: (v: boolean) => void;
  selectedCloneUrl: string;
  onSelectedCloneUrlChange: (v: string) => void;
  reposState: GitHubReposState;
  onReloadRepos: () => void;
  importBlockers: string[] | null;
  startPhase: string | null;
  repoName: string;
  onRepoNameChange: (v: string) => void;
  repoNameSuggestion: string | null;
  repoVisibility: 'public' | 'private';
  onRepoVisibilityChange: (v: 'public' | 'private') => void;
  githubLogin: string | null;
  patPresent: boolean | null;
}

function PromptComposer({
  prompt,
  onPromptChange,
  selectedSkills,
  onToggleSkill,
  onClearSkills,
  onSubmit,
  onKeyDown,
  onEnhance,
  onCancelEnhance,
  enhance,
  onAcceptEnhance,
  onDiscardEnhance,
  canEnhance,
  enhanceStreaming,
  hasKey,
  onOpenKeys,
  onOpenSettings,
  starting,
  canStart,
  githubBlockReason,
  error,
  createRepo,
  onCreateRepoChange,
  importRepo,
  onImportRepoChange,
  selectedCloneUrl,
  onSelectedCloneUrlChange,
  reposState,
  onReloadRepos,
  importBlockers,
  startPhase,
  repoName,
  onRepoNameChange,
  repoNameSuggestion,
  repoVisibility,
  onRepoVisibilityChange,
  githubLogin,
  patPresent,
}: PromptComposerProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: reset height to `auto` then snap to scrollHeight on
  // every keystroke. Layout effect rather than effect so the height
  // is committed before paint and the user never sees a flash of a
  // scrollbar.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 160)}px`;
  }, [prompt]);

  const matches = useMemo(() => detectContextSignalMatches(prompt), [prompt]);

  // `/` command menu — pick skills for the session about to be created.
  const slash = useSlashCommands({
    value: prompt,
    onChange: onPromptChange,
    textareaRef: taRef,
    items: listSkills().map((s) => ({
      id: s.id,
      icon: s.icon,
      label: s.label,
      description: s.description,
      active: selectedSkills.includes(s.id),
    })),
    onSelect: (item) => onToggleSkill(item.id),
  });

  return (
    <form
      onSubmit={onSubmit}
      className={[
        'rounded-md border bg-sidebar-bg transition-colors',
        'border-[#2a2a35] focus-within:border-[#4a4a58]',
        'p-4 sm:p-5 grid gap-4',
      ].join(' ')}
    >
      <div className="relative">
        {slash.menu}
        <PromptHighlightTextarea
          textareaRef={taRef}
          value={prompt}
          onValueChange={onPromptChange}
          matches={matches}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            onKeyDown(e);
          }}
          placeholder={PROMPT_PLACEHOLDER}
          rows={4}
          disabled={starting}
          spellCheck={false}
          ariaLabel="New session prompt"
          textClassName="text-[15px] leading-relaxed font-display min-h-[120px]"
          textareaClassName="custom-scrollbar resize-none disabled:opacity-60"
        />
      </div>

      <AgentModeControl
        activeSkillIds={selectedSkills}
        onToggleSkill={onToggleSkill}
        onClearSkills={onClearSkills}
        className="-mt-1"
      />

      {enhance.kind !== 'idle' ? (
        <EnhancePreview
          enhance={enhance}
          onCancel={onCancelEnhance}
          onAccept={onAcceptEnhance}
          onDiscard={onDiscardEnhance}
        />
      ) : null}

      <div className="border-t border-[#2a2a35] pt-3 grid gap-3">
        <GitHubImportSetup
          expanded={importRepo}
          onExpandedChange={onImportRepoChange}
          selectedCloneUrl={selectedCloneUrl}
          onSelectedCloneUrlChange={onSelectedCloneUrlChange}
          reposState={reposState}
          onReloadRepos={onReloadRepos}
          githubLogin={githubLogin}
          patPresent={patPresent}
          onOpenSettings={onOpenSettings}
        />

        <GitHubRepoSetup
          expanded={createRepo}
          onExpandedChange={onCreateRepoChange}
          name={repoName}
          onNameChange={onRepoNameChange}
          visibility={repoVisibility}
          onVisibilityChange={onRepoVisibilityChange}
          nameSuggestion={repoNameSuggestion}
          githubLogin={githubLogin}
          patPresent={patPresent}
          onOpenSettings={onOpenSettings}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
        {enhanceStreaming ? (
          <button
            type="button"
            onClick={onCancelEnhance}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#5a4a4a] bg-[#3a2a2a]/40 text-[11px] font-mono uppercase tracking-wider text-[#f0a0a0] hover:bg-[#3a2a2a]/60 transition-colors"
            title="Cancel enhancement"
          >
            <span className="material-symbols-outlined text-[14px] animate-pulse">
              bolt
            </span>
            Cancel enhance
          </button>
        ) : (
          <button
            type="button"
            onClick={hasKey ? onEnhance : onOpenKeys}
            disabled={!hasKey ? false : !canEnhance}
            className={[
              'inline-flex items-center gap-2 px-3 py-1.5 rounded-full border',
              'text-[11px] font-mono uppercase tracking-wider transition-colors',
              hasKey && canEnhance
                ? 'border-soft-white/40 text-soft-white hover:bg-soft-white/10'
                : 'border-[#2a2a35] text-slate-gray hover:text-soft-white hover:border-[#3a3a45] disabled:opacity-40 disabled:cursor-not-allowed',
            ].join(' ')}
            title={
              !hasKey
                ? 'Set an API key first (click to open)'
                : !prompt.trim()
                  ? 'Type something to enhance'
                  : 'Rewrite your rough idea into a well-shaped prompt. The original stays in the box; you choose whether to keep the enhanced version.'
            }
          >
            <span className="material-symbols-outlined text-[14px]">
              auto_awesome
            </span>
            {hasKey ? 'Enhance' : 'Set API key to enhance'}
          </button>
        )}

        <div className="flex flex-col items-end gap-1">
          {(createRepo || importRepo) && githubBlockReason ? (
            <p className="text-[11px] text-[#e8d4a8]">{githubBlockReason}</p>
          ) : null}
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-slate-gray hidden sm:inline">
              {!importRepo && prompt.trim().length > 0 ? '⌘ + Enter to start' : ''}
              {importRepo && !prompt.trim() ? 'Optional prompt · ⌘ + Enter to import' : ''}
            </span>
            <button
              type="submit"
              disabled={(importRepo ? false : !prompt.trim()) || starting || !canStart}
              className={[
                'px-4 py-1.5 rounded-full text-[12px] font-semibold',
                'bg-soft-white text-content-bg hover:bg-soft-white/90',
                'transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              ].join(' ')}
            >
              {starting
                ? startPhase ?? (importRepo ? 'Importing…' : 'Starting…')
                : importRepo
                  ? 'Import & start session'
                  : createRepo
                    ? 'Start session & create repo'
                    : 'Start session'}
            </button>
          </div>
        </div>
        </div>
      </div>

      {error ? (
        <div className="grid gap-1">
          <p className="text-[11px] font-mono text-[#f0a0a0]">
            {importRepo ? 'Import failed' : 'Failed to start session'}: {error}
          </p>
          {importBlockers && importBlockers.length > 0 ? (
            <ul className="text-[11px] font-mono text-[#f0a0a0] list-disc pl-4 space-y-0.5">
              {importBlockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

// ─── Enhancement preview card ────────────────────────────────────────

interface EnhancePreviewProps {
  enhance: EnhanceState;
  onCancel: () => void;
  onAccept: () => void;
  onDiscard: () => void;
}

function EnhancePreview({
  enhance,
  onCancel,
  onAccept,
  onDiscard,
}: EnhancePreviewProps) {
  const streaming = enhance.kind === 'streaming';
  const ready = enhance.kind === 'ready';
  const errored = enhance.kind === 'error';
  const text =
    enhance.kind === 'streaming' || enhance.kind === 'ready'
      ? enhance.text
      : '';
  const words = countWords(text);

  return (
    <div className="rounded-md border border-[#2a2a35] bg-[#0f0f17] p-4 grid gap-3">
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-slate-gray">
        <span className="material-symbols-outlined text-[14px] text-soft-white/70">
          auto_awesome
        </span>
        <span>{errored ? 'Enhance failed' : 'Enhanced'}</span>
        {streaming ? (
          <span className="text-[10px] text-slate-gray normal-case tracking-normal">
            · streaming
          </span>
        ) : ready ? (
          <span className="text-[10px] text-slate-gray normal-case tracking-normal">
            · {words} {words === 1 ? 'word' : 'words'}
          </span>
        ) : null}
      </div>

      {errored ? (
        <p className="text-[12px] font-mono text-[#f0a0a0] whitespace-pre-wrap">
          {enhance.message}
        </p>
      ) : (
        <p className="text-[14px] leading-relaxed text-soft-white whitespace-pre-wrap min-h-[1.5em]">
          {text || (streaming ? '…' : '')}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {streaming ? (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 rounded text-[10px] font-mono uppercase tracking-wider bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white"
          >
            Cancel
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onDiscard}
              className="px-3 py-1 rounded text-[10px] font-mono uppercase tracking-wider bg-[#2a2a35] hover:bg-[#3a3a48] text-slate-gray hover:text-soft-white"
            >
              Discard
            </button>
            {ready ? (
              <button
                type="button"
                onClick={onAccept}
                className="px-3 py-1 rounded text-[10px] font-mono uppercase tracking-wider bg-soft-white text-content-bg hover:bg-soft-white/90"
              >
                Use this
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Session list card ───────────────────────────────────────────────

interface SessionCardProps {
  session: SessionMeta;
  playgroundBase: string;
  embeddedInStudio: boolean;
  isConfirmingDelete: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}

function SessionCard({
  session,
  playgroundBase,
  embeddedInStudio,
  isConfirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: SessionCardProps) {
  const href = playgroundSessionHref(session.id, {
    base: playgroundBase,
    embedded: embeddedInStudio,
  });
  return (
    <li
      className={[
        'flex items-center gap-3 px-3 py-2 rounded-md transition-colors',
        isConfirmingDelete
          ? 'bg-[#3a1f1f]/40 border border-[#5a2a2a]'
          : 'bg-[#0f0f17] border border-[#2a2a35] hover:border-[#3a3a48]',
      ].join(' ')}
    >
      <div className="flex-1 min-w-0">
        <a
          href={href}
          className="block group"
          aria-label={`Open session: ${session.title}`}
        >
          <div className="text-[13px] text-soft-white truncate group-hover:underline">
            {session.title}
          </div>
          {session.preview ? (
            <div className="text-[11px] text-slate-gray truncate">
              {session.preview}
            </div>
          ) : null}
        </a>
        <div className="text-[10px] font-mono text-slate-gray mt-0.5">
          {relativeTime(session.updatedAt)}
          {session.payloadSize > 0
            ? ` · ${formatBytes(session.payloadSize)}`
            : ''}
          {session.promotedTo ? (
            <span className="ml-2 text-[#a4d4a8]">synced</span>
          ) : null}
          {session.githubRepo ? (
            <>
              {' · '}
              <a
                href={session.githubRepo.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#a4c4f0] hover:underline"
              >
                github: {session.githubRepo.fullName}
              </a>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {isConfirmingDelete ? (
          <>
            <button
              type="button"
              onClick={onCancelDelete}
              className="px-2 py-1 rounded text-[10px] font-mono uppercase tracking-wider bg-[#2a2a35] hover:bg-[#3a3a48] text-soft-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="px-2 py-1 rounded text-[10px] font-mono uppercase tracking-wider bg-[#5a2a2a] hover:bg-[#6a3030] text-[#f0a0a0]"
            >
              Delete
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onConfirmDelete}
            className="px-2 py-1 rounded text-[10px] font-mono uppercase tracking-wider bg-[#2a2a35] hover:bg-[#3a3a48] text-slate-gray hover:text-soft-white"
            aria-label={`Delete session: ${session.title}`}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
