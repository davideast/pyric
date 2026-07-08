/**
 * Playground shell. Two layouts in one tree:
 *
 *   Desktop (md+): 60/40 split — Workspace on the left, Agent panel
 *     (Activity / Output + ComposeBar + StatusBar) on the right.
 *
 *   Mobile (< md): single-panel toggle via a bottom tab bar. Workspace
 *     and Agent each take the full screen, swapped via
 *     `useMobileNavStore.activeTab`. Unread dots on the inactive tab
 *     surface "something happened over there" (agent wrote to editors;
 *     timeline gained entries) without auto-switching the user away.
 *
 * One DOM tree handles both — Tailwind's `md:flex` always shows both
 * panels at desktop widths; mobile-side JS only toggles the
 * `hidden` / `flex` class for sub-md widths.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentPanel, type AgentSubTab } from './AgentPanel';
import { ApiKeyForm } from './ApiKeyForm';
import { BottomTabBar } from './BottomTabBar';
import { ComposeBar } from './ComposeBar';
import { ResumeTurnBanner } from './ResumeTurnBanner';
import { SessionAgentModeControl } from './AgentModeControl';
import { Modal } from './Modal';
import { OutputTab } from './OutputTab';
import { FilesPanel } from './FilesPanel';
import type { FirebaseSubTab } from './FirebaseTab';
import { PanelTabs, type Tab } from './PanelTabs';
import { TerminalPanel } from './TerminalPanel';
import { AuthModal } from './AuthModal';
import { AutosaveStatus } from './AutosaveStatus';
import { SessionReadOnlyBanner } from './SessionReadOnlyBanner';
import { SettingsModal } from './SettingsModal';
import { WorkspacePanel, type WorkspaceTabId } from './WorkspacePanel';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
import { ToastProvider } from '@pyric/ui/primitives';
import { useAgentLoop } from '~/hooks/useAgentLoop';
import { useDenialCapture } from '~/hooks/useDenialCapture';
import { useRulesAutoDeploy } from '~/hooks/useRulesAutoDeploy';
import { useSessionRouting } from '~/hooks/useSessionRouting';
import { ensureBufferPolyfill } from '~/lib/git/buffer-polyfill';

ensureBufferPolyfill();
import { useUnreadTracking } from '~/hooks/useUnreadTracking';
import { takePendingPrompt } from '~/lib/sessions/pending-prompt';
import '~/lib/debug/expose';
import { enhancePrompt } from '~/lib/agent/prompt-enhancer/enhance';
import {
  buildContextWindowSnapshot,
} from '~/lib/agent/context-window';
import { buildClaudeLanePrompt } from '~/lib/agent/claude-lane-prompt';
import { buildSystemPrompt } from '~/lib/agent/system-prompt';
import { isDelegatedProvider } from '~/lib/agent/strategies/claude-delegate';
import { selectToolProfileForPrompt } from '~/lib/agent/tool-profile';
import { PROVIDER_LIST, PROVIDERS } from '~/lib/llm/registry';
import { useOllamaModelsStore } from '~/lib/store/ollamaModels';
import { buildApiKeyField } from './byok-field';
import { useChatStore } from '~/lib/store/chat';
import { useEnhancerStore } from '~/lib/store/enhancer';
import { useLlmStore } from '~/lib/store/llm';
import { useMobileNavStore } from '~/lib/store/mobile-nav';
import { useOpenRouterModelsStore } from '~/lib/store/openrouterModels';
import { useSettingsStore } from '~/lib/store/settings';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { useFilesStore } from '~/lib/store/files';
import { getAllTurnTraces, useTraceStore } from '~/lib/store/trace';
import { useSkillsStore } from '~/lib/store/skills';
import { resolveAgentContext } from '~/lib/agent/context';
import {
  isPlaygroundCommandMessage,
  isStudioEmbedSearch,
  playgroundHomeHref,
  type PlaygroundSandboxMode,
} from '~/lib/studio-embed';
import { listToolHandlersForProfile } from '~/lib/tools';
import { completeRedirectSignIn } from '~/lib/firebase/auth';
import { installDiagnosticsGlobals, logPage } from '~/lib/llm/inference/diagnostics';
import { installOpenRouterInspector } from '~/lib/llm/inference/openrouter-inspect';
import { ModelPicker } from './ModelPicker';


const SPLIT_STORAGE_KEY = 'pyric:split-pct';
const SPLIT_DEFAULT = 60;
const SPLIT_MIN = 25;
const SPLIT_MAX = 80;

function readStoredSplit(): number {
  if (typeof window === 'undefined') return SPLIT_DEFAULT;
  const v = Number(window.localStorage.getItem(SPLIT_STORAGE_KEY));
  return Number.isFinite(v) && v >= SPLIT_MIN && v <= SPLIT_MAX ? v : SPLIT_DEFAULT;
}

export function PlaygroundPage() {
  const embeddedInStudio =
    typeof window !== 'undefined' && isStudioEmbedSearch(window.location.search);
  const playgroundBase = import.meta.env.BASE_URL;
  // Hydrate workspace + chat from `?session={id}` on mount, then
  // auto-save changes back to the sandbox. Missing/unknown id
  // redirects to `/` — the workspace page only renders for a real
  // session. See plans/playground-home-page-and-sessions.md
  // ("playground-routing" track).
  const sessionRouting = useSessionRouting();

  const [activeTab, setActiveTab] = useState<string>('agent');
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTabId>('preview');
  const [agentSubTab, setAgentSubTab] = useState<AgentSubTab>('chat');
  // Firebase sub-tab state lifted up so the denial banner can land
  // on 'traffic' even when the Firebase panel is already mounted on
  // 'data', and so cross-tab navigation (Suggestions → Traffic) works.
  const [firebaseSubTab, setFirebaseSubTab] = useState<FirebaseSubTab>('sandbox');
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

  // Complete the Google redirect flow on app load — only matters
  // when the user picked the redirect fallback (popup is the
  // primary sign-in path; popup returns the OAuth access token
  // synchronously). Errors here are usually stale-redirect-cookie
  // or third-party-cookie-blocked-and-lost-the-token; not user-
  // facing emergencies, but visible in the console so devs can
  // diagnose if the modal stays signed-out after a redirect.
  useEffect(() => {
    void completeRedirectSignIn().catch((e) => {
      console.warn('[auth] redirect sign-in completion failed:', e);
    });
  }, []);

  // Page-lifecycle instrumentation — feeds the diagnostics activity
  // log. visibilitychange / freeze / resume / pagehide / online /
  // connection-change are logged so a session export shows exactly
  // what the tab did (backgrounded, frozen, lost network, …) — useful
  // context when a `resumableServerMode` reconnect shows up in the log.
  useEffect(() => {
    installDiagnosticsGlobals();
    // Wrap window.fetch to capture the literal OpenRouter request body
    // (the `reasoning` param) + stream timing. Idempotent; registers
    // __pyric.printOpenRouter(). See openrouter-inspect.ts.
    installOpenRouterInspector();
    const conn = (navigator as unknown as {
      connection?: {
        effectiveType?: string;
        downlink?: number;
        rtt?: number;
        addEventListener?: (t: string, h: () => void) => void;
        removeEventListener?: (t: string, h: () => void) => void;
      };
    }).connection;
    logPage('page_load', undefined, {
      visibility: document.visibilityState,
      online: navigator.onLine,
      connectionType: conn?.effectiveType ?? null,
    });

    const onVisibility = () =>
      logPage('visibility_change', undefined, { state: document.visibilityState });
    // Page Lifecycle API — `freeze` / `resume` are the explicit signals
    // for Chrome's frozen-tab and discarded-tab transitions. Distinct
    // from visibilitychange: a tab can be hidden without being frozen.
    const onFreeze = () => logPage('lifecycle_freeze');
    const onResume = () => logPage('lifecycle_resume');
    // pagehide/pageshow's `persisted` flag tells us whether the page
    // went into bfcache vs. being torn down fully.
    const onPagehide = (e: PageTransitionEvent) =>
      logPage('lifecycle_pagehide', undefined, { persisted: e.persisted });
    const onPageshow = (e: PageTransitionEvent) =>
      logPage('lifecycle_pageshow', undefined, { persisted: e.persisted });
    const onOnline = () => logPage('online');
    const onOffline = () => logPage('offline');
    const onConnectionChange = () =>
      logPage('connection_change', undefined, {
        effectiveType: conn?.effectiveType ?? null,
        downlink: conn?.downlink ?? null,
        rtt: conn?.rtt ?? null,
      });

    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);
    window.addEventListener('pagehide', onPagehide);
    window.addEventListener('pageshow', onPageshow);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    conn?.addEventListener?.('change', onConnectionChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
      window.removeEventListener('pagehide', onPagehide);
      window.removeEventListener('pageshow', onPageshow);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      conn?.removeEventListener?.('change', onConnectionChange);
    };
  }, []);
  // Composer text lives INSIDE ComposeBar (perf: keystrokes must not
  // re-render this 900-line root). This is the one-way write channel
  // for programmatic fills (enhancer edit).
  const [externalCompose, setExternalCompose] = useState<{ text: string; nonce: number } | null>(null);
  // Tick so the modal re-reads `hasKey()` after a save.
  const [keysTick, setKeysTick] = useState(0);

  // `[` hotkey — fold all turns except the most recent. Same
  // primitive as the auto-fold-on-new-turn setting; this is the
  // manual trigger. Guarded against typing in inputs / textareas
  // so the compose bar still accepts `[` as a character.
  const bumpCollapse = useSettingsStore((s) => s.bumpCollapse);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const editable = target?.isContentEditable;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return;
      e.preventDefault();
      bumpCollapse();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [bumpCollapse]);

  // Desktop column split (Workspace | Agent). Persisted across reloads
  // so the user's chosen ratio sticks; clamped to a sensible range so
  // either pane can never disappear entirely. Drag handle lives
  // between the panes in the JSX below.
  const [splitPct, setSplitPct] = useState<number>(readStoredSplit);
  const [isResizing, setIsResizing] = useState(false);
  const draggingRef = useRef(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, String(splitPct));
    } catch (e) {
      console.warn('[playground] localStorage write failed for split-pct:', e);
    }
  }, [splitPct]);

  const onResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (clientX: number) => {
      if (!draggingRef.current) return;
      const vw = window.innerWidth;
      const pct = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, (clientX / vw) * 100));
      setSplitPct(pct);
    };
    const onMouseMove = (ev: MouseEvent) => move(ev.clientX);
    const onTouchMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (t) move(t.clientX);
    };
    const onUp = () => {
      draggingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
  }, []);

  useDenialCapture();
  useRulesAutoDeploy();
  useUnreadTracking();
  const mobileTab = useMobileNavStore((s) => s.activeTab);
  const providerId = useLlmStore((s) => s.providerId);
  const modelId = useLlmStore((s) => s.modelId);
  const openrouterModelsById = useOpenRouterModelsStore((s) => s.byId);
  const openrouterModelsStatus = useOpenRouterModelsStore((s) => s.status);
  const refreshOpenrouterModels = useOpenRouterModelsStore((s) => s.refresh);
  const { sending, error, send, stop } = useAgentLoop();
  const messages = useChatStore((s) => s.messages);
  const compactionMarkers = useChatStore((s) => s.compactionMarkers);
  // Light per-turn summaries — full trace payloads stay OUT of React state
  // (see store/trace.ts memory architecture); `getAllTurnTraces()` reads
  // them on demand where needed, keyed off this object's identity.
  const traceSummaries = useTraceStore((s) => s.summaries);
  // Active skills change the system prompt (briefs) — the context-window
  // memo below lists this as a dep so the meter updates on toggle.
  const activeSkillIds = useSkillsStore((s) => s.activeSkillIds);
  const activeSkillKey = activeSkillIds.join('\u0000');
  const workbenchIntent = useMemo(
    () => resolveAgentContext({ activeSkillIds }).workbenchIntent,
    [activeSkillKey],
  );
  const setActiveFilePath = useFilesStore((s) => s.setActiveFilePath);

  useEffect(() => {
    setWorkspaceTab(workbenchIntent.primarySurface);
    if (workbenchIntent.defaultFirebaseSubtab) {
      setFirebaseSubTab(workbenchIntent.defaultFirebaseSubtab);
    }
    if (workbenchIntent.defaultFilePath) {
      setActiveFilePath(workbenchIntent.defaultFilePath);
    }
  }, [activeSkillKey, setActiveFilePath, workbenchIntent]);

  // (The pending-prompt auto-fire lives lower down — it depends on
  // `runEnhancement`, which is declared further into the component.)
  const pendingPromptFiredRef = useRef(false);
  const enhancePromptEnabled = useSettingsStore((s) => s.enhancePromptEnabled);
  const setEnhancePromptEnabled = useSettingsStore((s) => s.setEnhancePromptEnabled);
  const appSource = useWorkspaceStore((s) => s.appSource);
  const pyricDiagnosticsEnabled = useSettingsStore((s) => s.pyricDiagnosticsEnabled);
  const strategyMode = useSettingsStore((s) => s.strategyMode);
  const bumpContextCompact = useSettingsStore((s) => s.bumpContextCompact);
  const enhanceAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (providerId === 'openrouter' && openrouterModelsStatus === 'idle') {
      void refreshOpenrouterModels();
    }
  }, [providerId, openrouterModelsStatus, refreshOpenrouterModels]);

  // Enhance is a first-prompt-only affordance for blank workspaces.
  // Imported/cloned sessions already carry app code — skip the toggle
  // and route the first compose Send straight to the agent loop.
  const hasAnyUserTurn = useMemo(
    () => messages.some((m) => m.role === 'user'),
    [messages],
  );
  const hasSeedAppCode = appSource.trim().length > 0;
  const canEnhance = !hasAnyUserTurn && !hasSeedAppCode;
  // Effective enhance mode — the persisted preference only counts
  // while enhance is still available. Once it isn't, the Send button
  // returns to its plain "Send" label even if the user's persisted
  // toggle is true; flipping it back on at the start of the next
  // session honors the saved preference.
  const enhanceModeActive = canEnhance && enhancePromptEnabled;

  const rightTabs: readonly Tab[] = useMemo(
    () => [
      // Agent = chat history + active turn. Was 'Activity' before the
      // tab reshuffle; the rename matches what users actually call it.
      { id: 'agent', label: 'Agent' },
      // Files = VFS tree + git + packages sub-tabs. Clicking a file
      // routes through useFilesStore → the FileEditor in the left panel.
      { id: 'files', label: 'Files' },
      // Terminal = just-bash over the OPFS VFS. Promoted from the
      // (now retired) Repo tab.
      { id: 'terminal', label: 'Terminal' },
      { id: 'output', label: 'Output' },
    ],
    [],
  );
  const visibleRightTab = rightTabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : 'agent';

  const totals = useMemo(() => {
    let turns = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let cachedInputTokens = 0;
    let reasoningTokens = 0;
    let costUsd: number | null = null;
    let costEstimated = false;
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.metrics) continue;
      turns += 1;
      tokensIn += m.metrics.tokensIn ?? 0;
      tokensOut += m.metrics.tokensOut ?? 0;
      cachedInputTokens += m.metrics.cachedTokens ?? 0;
      reasoningTokens += m.metrics.reasoningTokens ?? 0;
      if (typeof m.metrics.costUsd === 'number') {
        costUsd = (costUsd ?? 0) + m.metrics.costUsd;
        if (m.metrics.costEstimated) costEstimated = true;
      }
    }
    return {
      turns,
      tokensIn,
      tokensOut,
      cachedInputTokens,
      reasoningTokens,
      tokensTotal: tokensIn + tokensOut,
      // Session cost: sum of per-turn costs (exact OpenRouter usage
      // accounting when unflagged; ≈ when any turn was estimated).
      costUsd,
      costEstimated,
    };
  }, [messages]);
  const modelRequestCount = useMemo<number | null>(() => {
    const traceCount = Object.values(traceSummaries).reduce(
      (sum, trace) => sum + trace.requestCount,
      0,
    );
    const completedTurns = messages.filter(
      (m) => m.role === 'assistant' && m.metrics,
    );
    const missingTraceForCompletedTurn = completedTurns.some(
      (m) => !m.turnId || !traceSummaries[m.turnId],
    );
    return missingTraceForCompletedTurn ? null : traceCount;
  }, [messages, traceSummaries]);

  // Run the enhancer for a given raw input. Pushes a card to the
  // store, streams chunks in, transitions to `ready` on completion
  // (or `errored` on a yielded/thrown error). Provider+model+apiKey
  // captured at call time, so changing the picker mid-stream doesn't
  // retarget the in-flight call. Cancellation is best-effort via the
  // AbortController on `enhanceAbortRef` — kept on the ref instead of
  // a closure so a fresh enhancement always cancels any prior one.
  const runEnhancement = useCallback(
    (rawInput: string, existingCardId?: string) => {
      const activeProviderDef = PROVIDERS[providerId];
      const apiKey = activeProviderDef.byok.getKey();
      if (!apiKey) return;

      // Cancel any prior in-flight enhancement before starting a new
      // one. Also tombstone the prior card so it doesn't sit in
      // `streaming` forever — the abort kills the fetch but the
      // streaming-state guard in the await loop won't otherwise
      // update store state on the way out.
      enhanceAbortRef.current?.abort();
      const prior = useEnhancerStore.getState();
      for (const e of prior.enhancements) {
        if (e.state === 'streaming') prior.setState(e.id, 'discarded');
      }

      const ac = new AbortController();
      enhanceAbortRef.current = ac;

      const store = useEnhancerStore.getState();
      const id = existingCardId ?? store.append(rawInput);
      if (existingCardId) {
        // Retry path — reset state. The prior errored text stays in
        // `enhancedText` until the first new chunk arrives; for an
        // explicit "clean slate" the user can discard + start over.
        store.setState(existingCardId, 'streaming');
      }

      void (async () => {
        try {
          let received = false;
          for await (const chunk of enhancePrompt({
            rawInput,
            providerId,
            modelId,
            apiKey,
            activeSkillIds,
            signal: ac.signal,
          })) {
            if (ac.signal.aborted) return;
            received = true;
            useEnhancerStore.getState().appendChunk(id, chunk);
          }
          if (ac.signal.aborted) return;
          if (!received) {
            useEnhancerStore
              .getState()
              .setError(id, 'Model returned no text. Try a different rough idea, or check your API key.');
            return;
          }
          useEnhancerStore.getState().setState(id, 'ready');
        } catch (e) {
          if (ac.signal.aborted) return;
          const msg = e instanceof Error ? e.message : String(e);
          useEnhancerStore.getState().setError(id, msg);
        }
      })();
    },
    [providerId, modelId, activeSkillIds],
  );

  const applyPromptWorkbenchIntent = useCallback(
    (prompt: string) => {
      const intent = resolveAgentContext({
        prompt,
        activeSkillIds: useSkillsStore.getState().activeSkillIds,
      }).workbenchIntent;
      setWorkspaceTab(intent.primarySurface);
      if (intent.defaultFirebaseSubtab) setFirebaseSubTab(intent.defaultFirebaseSubtab);
      if (intent.defaultFilePath) setActiveFilePath(intent.defaultFilePath);
    },
    [setActiveFilePath],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text) return;
      applyPromptWorkbenchIntent(text);
      useMobileNavStore.getState().setActive('agent');
      setActiveTab('agent');
      setAgentSubTab('chat');
      if (enhanceModeActive) {
        runEnhancement(text);
        return;
      }
      void send(text);
    },
    [send, enhanceModeActive, runEnhancement, applyPromptWorkbenchIntent],
  );

  // Auto-fire the agent (or enhancer) for the home page's pending
  // prompt. The home page stashes the user's first prompt under a
  // sessionStorage key (see `lib/sessions/pending-prompt.ts`); once
  // hydration completes we pop it and route based on the stashed
  // mode:
  //   - 'send'    → straight to `send()` (same path as compose box)
  //   - 'enhance' → `runEnhancement()` (same approval-card flow)
  //
  // Guarded with a ref so it fires exactly once per mount even when
  // React re-renders after the take() side-effect.
  useEffect(() => {
    if (!sessionRouting.loaded) return;
    if (!sessionRouting.sessionId) return;
    if (pendingPromptFiredRef.current) return;
    pendingPromptFiredRef.current = true;
    const pending = takePendingPrompt(sessionRouting.sessionId);
    if (!pending) return;
    applyPromptWorkbenchIntent(pending.prompt);
    if (pending.mode === 'enhance') {
      runEnhancement(pending.prompt);
    } else {
      void send(pending.prompt);
    }
  }, [sessionRouting.loaded, sessionRouting.sessionId, send, runEnhancement, applyPromptWorkbenchIntent]);

  // One-tap "Fix" from the Preview's compile/runtime error views or
  // the App pane's banner — submit the pre-built repair prompt AND
  // route the user to the Agent panel's Activity tab so they land
  // where the agent's response is about to stream in. Without the
  // route, the request fires "invisibly" — the user is still
  // looking at the error in the editor pane with no feedback that
  // anything happened.
  const handleFixRequest = useCallback(
    (prompt: string) => {
      useMobileNavStore.getState().setActive('agent');
      setActiveTab('agent');
      setAgentSubTab('chat');
      void send(prompt);
    },
    [send],
  );

  const handleApproveEnhancement = useCallback(
    (id: string, enhancedText: string) => {
      const trimmed = enhancedText.trim();
      if (!trimmed) return;
      useEnhancerStore.getState().setState(id, 'approved');
      setActiveTab('agent');
      setAgentSubTab('chat');
      void send(trimmed);
    },
    [send],
  );

  const handleEditEnhancement = useCallback(
    (id: string, enhancedText: string) => {
      useEnhancerStore.getState().setState(id, 'edited');
      // Drop the enhanced text back into the composer and turn the
      // toggle OFF so the user's tweaks aren't re-enhanced on Send.
      setExternalCompose({ text: enhancedText, nonce: Date.now() });
      setEnhancePromptEnabled(false);
    },
    [setEnhancePromptEnabled],
  );

  const handleDiscardEnhancement = useCallback((id: string) => {
    useEnhancerStore.getState().setState(id, 'discarded');
  }, []);

  const handleRetryEnhancement = useCallback(
    (id: string, rawInput: string) => {
      runEnhancement(rawInput, id);
    },
    [runEnhancement],
  );

  const handleToggleEnhance = useCallback(() => {
    setEnhancePromptEnabled(!enhancePromptEnabled);
  }, [enhancePromptEnabled, setEnhancePromptEnabled]);

  const handleOpenContext = useCallback(() => {
    useMobileNavStore.getState().setActive('agent');
    setActiveTab('agent');
    setAgentSubTab('context');
  }, []);

  const handleCompactContext = useCallback(() => {
    bumpContextCompact();
    useChatStore.getState().appendMessage({
      id: `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      text: 'Context compaction requested — the next agent turn will compact model-bound history; visible chat stays unchanged',
      createdAt: Date.now(),
    });
  }, [bumpContextCompact]);

  const handleSaveKeys = useCallback((values: Record<string, string>) => {
    // Save each provider's key only if the user typed something. Empty
    // values leave the existing key intact (the form shows a masked
    // placeholder when a key is already set).
    let ollamaUrlChanged = false;
    for (const def of PROVIDER_LIST) {
      const value = values[def.id];
      if (value && value.trim().length > 0) {
        def.byok.setKey(value);
        if (def.id === 'ollama') ollamaUrlChanged = true;
      }
    }
    // Ollama's model list is keyed on the base URL — refresh `/api/tags`
    // against the new host so the picker reflects what's actually
    // pulled there. No-op for other providers (their model lists are
    // static).
    if (ollamaUrlChanged) {
      void useOllamaModelsStore.getState().refresh();
    }
    setKeysTick((t) => t + 1);
    setKeysOpen(false);
  }, []);

  const handleOpenAccount = useCallback(() => {
    openAccount();
  }, [openAccount]);

  const handleSandboxModeChange = useCallback(
    (mode: PlaygroundSandboxMode) => {
      if (mode === sessionRouting.sandboxMode) return;
      if (
        typeof window !== 'undefined' &&
        !window.confirm(
          'Switch this Playground session sandbox mode? The Playground runtime will reload.',
        )
      ) {
        return;
      }
      void sessionRouting.setSandboxMode(mode).then(() => {
        if (typeof window !== 'undefined') window.location.reload();
      });
    },
    [sessionRouting],
  );

  const sessionState = sending ? 'streaming' : error ? 'failed' : 'idle';
  // Trigger re-read of byok.hasKey() across renders by reading
  // it during render (cheap, no subscriber needed).
  void keysTick;
  const activeProvider = PROVIDERS[providerId];
  const hasKey = activeProvider.byok.hasKey();
  const activeModel = activeProvider.models.find((m) => m.id === modelId);
  const activeModelLabel = activeModel?.label ?? modelId;
  const activeOpenrouterModel = providerId === 'openrouter'
    ? openrouterModelsById[modelId]
    : undefined;
  const promptPricing = useMemo(
    () =>
      activeOpenrouterModel?.promptPricePerMillion !== undefined
        ? {
            source: 'openrouter-models-api' as const,
            inputPricePerMillion: activeOpenrouterModel.promptPricePerMillion,
            ...(activeOpenrouterModel.cacheReadPricePerMillion !== undefined
              ? { cacheReadPricePerMillion: activeOpenrouterModel.cacheReadPricePerMillion }
              : {}),
          }
        : null,
    [
      activeOpenrouterModel?.cacheReadPricePerMillion,
      activeOpenrouterModel?.promptPricePerMillion,
    ],
  );
  // ── Perf: freeze the snapshot's turn-scoped inputs while streaming ──
  // `buildContextWindowSnapshot` walks every captured request (token
  // estimates over the full trace payloads) — it must NOT re-run on every
  // streamed token. The streaming buffer rewrites `messages` per chunk, so
  // holding these inputs to their pre-turn values while `sending` keeps the
  // memo below stable for the whole turn; when the turn completes it
  // recomputes once with the final state. Context-meter data is
  // turn-granular anyway, so mid-turn staleness is correct, not a lie.
  // NOTE composeValue is deliberately ABSENT: the snapshot is
  // turn-granular (its own contract) and must not recompute per
  // keystroke. The draft prompt's few-hundred tokens are negligible
  // against session scale.
  const liveContextInputs = useMemo(
    () => ({ messages, compactionMarkers, traceSummaries, totals, modelRequestCount }),
    [messages, compactionMarkers, traceSummaries, totals, modelRequestCount],
  );
  const frozenContextInputsRef = useRef(liveContextInputs);
  if (!sending) frozenContextInputsRef.current = liveContextInputs;
  const contextInputs = sending ? frozenContextInputsRef.current : liveContextInputs;

  const contextWindow = useMemo(() => {
    const delegated = isDelegatedProvider(providerId);
    const forceDiagnostics = workbenchIntent.promptProfile === 'firebase';
    const diagnosticsEnabled = pyricDiagnosticsEnabled || forceDiagnostics;
    const systemPrompt = delegated
      ? buildClaudeLanePrompt({ diagnosticsEnabled })
      : buildSystemPrompt({ diagnosticsEnabled });
    const toolProfile = selectToolProfileForPrompt({
      prompt: '', // turn-granular estimate — draft prompt excluded (see liveContextInputs)
      settings: { pyricDiagnosticsEnabled, strategyMode },
      delegated,
      promptProfile: workbenchIntent.promptProfile,
      preference: workbenchIntent.toolProfilePreference,
    });
    const tools = listToolHandlersForProfile(toolProfile, { forceDiagnostics });
    return buildContextWindowSnapshot({
      messages: contextInputs.messages,
      compactionMarkers: contextInputs.compactionMarkers,
      currentPrompt: '',
      systemPrompt,
      tools,
      limitTokens: activeOpenrouterModel?.contextWindowTokens ?? activeModel?.contextWindowTokens,
      providerId,
      modelId,
      promptPricing,
      sessionTurns: contextInputs.totals.turns,
      sessionRequests: contextInputs.modelRequestCount,
      sessionTokensTotal: contextInputs.totals.tokensTotal,
      sessionInputTokens: contextInputs.totals.tokensIn,
      sessionOutputTokens: contextInputs.totals.tokensOut,
      sessionCachedInputTokens: contextInputs.totals.cachedInputTokens,
      sessionReasoningTokens: contextInputs.totals.reasoningTokens,
      // Full payloads read on demand; `contextInputs.traceSummaries` above
      // is the change signal that invalidates this memo.
      tracesByTurn: getAllTurnTraces(),
    });
  }, [
    activeOpenrouterModel?.contextWindowTokens,
    activeModel?.contextWindowTokens,
    activeSkillIds,
    contextInputs,
    modelId,
    promptPricing,
    providerId,
    pyricDiagnosticsEnabled,
    strategyMode,
    workbenchIntent.promptProfile,
    workbenchIntent.toolProfilePreference,
  ]);

  // Render a minimal placeholder while the session payload loads.
  // Without this guard the workspace momentarily renders empty
  // (pre-hydration) before the editors fill in — visually identical to
  // a stuck render. See `useSessionRouting`. A missing `?session={id}`
  // already redirected to `/` inside the hook, so reaching here with
  // `loaded=false` means a real load is in flight.
  if (!sessionRouting.loaded) {
    return (
      <main className="min-h-screen bg-content-bg text-soft-white flex items-center justify-center">
        <p className="text-[12px] font-mono text-slate-gray">
          {sessionRouting.error
            ? `Couldn't load session: ${sessionRouting.error}`
            : 'Loading session…'}
        </p>
      </main>
    );
  }

  return (
    <ToastProvider>
      {!embeddedInStudio ? (
        <TopBar
          title="playground"
          homeHref={playgroundHomeHref({ base: playgroundBase })}
          sessionState={sessionState}
          githubRepo={sessionRouting.githubRepo}
          onOpenKeys={openKeys}
          onOpenSettings={openSettings}
          onOpenAccount={handleOpenAccount}
        >
          {/* Desktop carries the picker in the TopBar. Mobile hides it
              here (the bar is tight) and renders it inside the key
              modal — the user opens that modal to set keys, and seeing
              the picker right there makes the relationship obvious. */}
          <div className="hidden md:flex">
            <ModelPicker />
          </div>
          {/* Ambient-autosave indicator — driven by the real save
              lifecycle reported from useSessionRouting. Its popover
              carries the persistence truth copy + the sign-in step. */}
          <AutosaveStatus onOpenAccount={handleOpenAccount} />
        </TopBar>
      ) : null}

      {/* Writer-lock banner — another tab holds this session's writer
          lock, so this tab is view-only until the user takes over. */}
      {!sessionRouting.isWriter ? (
        <SessionReadOnlyBanner onTakeOver={sessionRouting.takeOver} />
      ) : null}

      <div
        className="flex-1 overflow-hidden flex"
        style={
          {
            '--split-l': `${splitPct}%`,
            '--split-r': `${100 - splitPct}%`,
          } as React.CSSProperties
        }
      >
        {/* Desktop: two panes (Workspace · Agent) with a drag-resize
            handle between them. Preview + the file editor live inside
            WorkspacePanel on the left; the right panel hosts Agent /
            Files / Terminal / Output tabs.
            Mobile: two bottom-tabs (App · Agent). App shows the
            WorkspacePanel (whose Preview sub-tab serves the
            preview-only surface that used to be a standalone panel);
            Agent shows the right panel. */}
        <main
          className={[
            'md:flex md:w-[var(--split-l)] flex-col min-w-0 bg-content-bg border-r border-[#2a2a35]',
            mobileTab === 'app' ? 'flex w-full' : 'hidden md:flex',
          ].join(' ')}
        >
          <WorkspacePanel
            promptProfile={workbenchIntent.promptProfile}
            activeTab={workspaceTab}
            onTabChange={setWorkspaceTab}
            onFixRequest={handleFixRequest}
            onOpenDenials={() => {
              useMobileNavStore.getState().setActive('app');
              setWorkspaceTab('firebase');
              setFirebaseSubTab('traffic');
            }}
            firebaseProps={{
              onSendPrompt: (prompt) => void send(prompt),
              sendBusy: sending,
              onAfterSend: () => {
                setActiveTab('agent');
                setAgentSubTab('chat');
              },
              subTab: firebaseSubTab,
              onSubTabChange: setFirebaseSubTab,
              sessionId: sessionRouting.sessionId,
              contextWindow,
              sandboxMode: sessionRouting.sandboxMode,
              sandboxModeDisabled: !sessionRouting.isWriter,
              onSandboxModeChange: handleSandboxModeChange,
              onNavigateAgent: () => {
                setActiveTab('agent');
                setAgentSubTab('chat');
              },
              promptProfile: workbenchIntent.promptProfile,
            }}
          />
        </main>

        {/* Drag handle between Workspace and Agent — desktop only. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
          tabIndex={-1}
          onMouseDown={onResizeStart}
          onTouchStart={onResizeStart}
          className="hidden md:block w-3 -mx-1.5 shrink-0 cursor-col-resize group relative z-10"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-[#2a2a35] group-hover:bg-[#3a3a48] transition-colors" />
        </div>

        {/* Agent — Activity / Files / Terminal / Output. */}
        <aside
          className={[
            'md:flex md:w-[var(--split-r)] flex-col min-w-0 bg-sidebar-bg',
            mobileTab === 'agent' ? 'flex w-full' : 'hidden md:flex',
          ].join(' ')}
        >
          <PanelTabs tabs={rightTabs} activeTab={visibleRightTab} onTabChange={setActiveTab} />

          {/* Keep every right-panel tab MOUNTED at all times — `hidden`
              just toggles display so each tab's local state (xterm
              instance, FilesPanel sub-tab, etc.)
              survives a switch away and back. Conditional rendering
              would unmount the components and lose the terminal's
              scrollback, the file editor's draft, etc. */}
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <RightTabPane active={visibleRightTab === 'agent'}>
              <AgentPanel
                activeSubTab={agentSubTab}
                onSubTabChange={setAgentSubTab}
                contextWindow={contextWindow}
                onCompactContext={handleCompactContext}
                onSendPrompt={(prompt) => void send(prompt)}
                sendBusy={sending}
                onAfterSend={() => {
                  setActiveTab('agent');
                  setAgentSubTab('chat');
                }}
                onApproveEnhancement={handleApproveEnhancement}
                onEditEnhancement={handleEditEnhancement}
                onDiscardEnhancement={handleDiscardEnhancement}
                onRetryEnhancement={handleRetryEnhancement}
              />
            </RightTabPane>
            <RightTabPane active={visibleRightTab === 'output'}>
              <OutputTab />
            </RightTabPane>
            <RightTabPane active={visibleRightTab === 'files'}>
              <FilesPanel />
            </RightTabPane>
            <RightTabPane active={visibleRightTab === 'terminal'}>
              <TerminalPanel />
            </RightTabPane>
          </div>

          {/* On mobile, StatusBar sits above the ComposeBar (sticky)
              so the model + turn/token info stays visible right
              before the input. On desktop it stays below as a
              footer. Visual order matches importance per breakpoint. */}
          <StatusBar
            modelLabel={`${activeProvider.label}: ${activeModelLabel}`}
            sessionState={sessionState}
            error={error}
            turns={totals.turns}
            requests={modelRequestCount}
            tokensTotal={totals.tokensTotal}
            costUsd={totals.costUsd}
            costEstimated={totals.costEstimated}
          />
          {/* Interrupted-turn recovery: one-tap resume for a reply cut
              short by a reload/tab discard (see inference/reattach.ts). */}
          <ResumeTurnBanner sending={sending} onSend={send} disabled={!hasKey} />
          {/* Compact session intent control. Slash commands handle fast
              activation; this keeps enable/disable discoverable without
              rendering the whole skill registry in the footer. */}
          <SessionAgentModeControl className="px-3 py-1" />
          <ComposeBar
            externalText={externalCompose}
            onSubmit={handleSubmit}
            onStop={stop}
            sending={sending}
            disabled={!hasKey}
            placeholder={
              hasKey
                ? enhanceModeActive
                  ? 'Sketch a rough idea — the enhancer will shape it…'
                  : 'Ask the agent anything…'
                : embeddedInStudio
                  ? `Paste a ${activeProvider.label} API key first (key icon in the Studio bar)`
                  : `Paste a ${activeProvider.label} API key first (top-right key icon)`
            }
            enhanceMode={enhanceModeActive}
            contextWindow={contextWindow}
            onOpenContext={handleOpenContext}
            {...(canEnhance ? { onToggleEnhance: handleToggleEnhance } : {})}
          />
        </aside>
      </div>

      {/* Drag-curtain — mounted only while resizing. Transparent fixed
          overlay above every iframe (z-[2000] outranks the
          fullscreen-preview overlay at z-50) so pointer events stay
          on the parent window listeners while the cursor crosses the
          Preview iframe. */}
      {isResizing ? (
        <div
          className="fixed inset-0 z-[2000] cursor-col-resize"
          aria-hidden
        />
      ) : null}

      <BottomTabBar />

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />

      <Modal open={keysOpen} onClose={() => setKeysOpen(false)} ariaLabel="API keys">
          {/* Picker rendered inside the modal on mobile so the user can
              switch providers + models in the same place they manage
              keys. Desktop has the picker in the TopBar; rendering it
              again here would be redundant. */}
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
    </ToastProvider>
  );
}

/**
 * Right-panel tab wrapper that keeps the child mounted regardless of
 * whether the tab is currently active. We hide via `display: none`
 * instead of unmounting so the terminal's xterm instance + shell
 * state and the FilesPanel's open sub-tab survive a switch away and
 * back. `inert` removes the
 * subtree from the tab order while hidden.
 */
function RightTabPane({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  // React 19 accepts `inert` as a boolean prop and renders it as
  // the bare attribute when true. Passing the empty string trips a
  // React warning ("treat as false" / "use the boolean form").
  const inertProp = active ? {} : { inert: true };
  return (
    <div
      {...inertProp}
      aria-hidden={!active}
      className={active ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}
    >
      {children}
    </div>
  );
}
