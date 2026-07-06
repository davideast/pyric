/**
 * Wire the workspace page to a session id read from `?session={id}`.
 *
 * On mount:
 *   - Read the query param. Missing → redirect to `/` (home).
 *   - Run the per-session writer election (`acquireSessionWriterLock`)
 *     — exactly one tab per session may write; the others go
 *     read-only (banner + blocked agent turns + read-only VFS +
 *     gated autosave). See `lib/sessions/writer-lock.ts`.
 *   - Mount the session's VFS container (`ensureSessionVFS`) so every
 *     file access on this page lands in `/sessions/{id}/...` instead
 *     of the old origin-global tree. The writer tab also runs the
 *     one-time legacy `/workspace` migration here.
 *   - Await `sessionsReady()` so the persistence restore has applied.
 *   - Call `loadSession(userId, sessionId)` and hydrate the workspace
 *     + chat stores from the returned payload.
 *
 * After hydration:
 *   - Subscribe to workspace + chat store changes and write back via
 *     `saveSession`, debounced. Skips the writes that fire during the
 *     hydration pass itself (we set the stores from the loaded
 *     payload; that mustn't immediately re-save and loop), and skips
 *     entirely while this tab is not the session writer.
 *
 * Returns `loaded` so the page can render a brief "loading" state
 * before the hydrated content lands, plus the writer-election state
 * (`isWriter` / `takeOver`) for the read-only banner.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getCurrentUserId,
  loadSession,
  saveSession,
  sessionsReady,
  SessionError,
  type SessionMeta,
  type SessionPayload,
} from '~/lib/sessions';
import { reportAutosave } from '~/lib/store/autosave';
import { disposeSessionsSandbox, getSessionsSandbox } from '~/lib/sessions/sandbox';
import {
  acquireSessionWriterLock,
  markSessionWriterStatus,
  type SessionWriterLock,
} from '~/lib/sessions/writer-lock';
import { ensureSessionVFS, setVFSReadOnly } from '~/lib/vfs';
import { recoverInterruptedJobs } from '~/lib/llm/inference/reattach';
import { useChatStore, type ChatMessage } from '~/lib/store/chat';
import type { CompactionMarker } from '~/lib/agent/context-management';
import { useSkillsStore } from '~/lib/store/skills';
import { useGithubSessionStore } from '~/lib/store/github-session';
import { useTraceStore } from '~/lib/store/trace';
import { useWorkspaceStore } from '~/lib/store/workspace';

const AUTOSAVE_DEBOUNCE_MS = 800;

export interface SessionRoutingState {
  /** Resolved session id from the URL. `null` until the URL parses
   *  (synchronous on mount; here to keep the type honest about the
   *  pre-mount render frame). */
  sessionId: string | null;
  /** True once the load + hydration pass has completed. The page
   *  should render a placeholder UI when false to avoid flashing a
   *  fresh-empty workspace before the session lands. */
  loaded: boolean;
  /** Set if `loadSession` failed for a reason other than 'not-found'
   *  (a not-found redirects to /). Surfaced to the page so it can
   *  render an inline error rather than a silent empty state. */
  error: string | null;
  /** False when another tab holds this session's writer lock — the
   *  page should render the read-only banner and the autosave / agent
   *  turns / VFS writes are blocked. */
  isWriter: boolean;
  /** Request the writer role from the holding tab (graceful steal).
   *  No-op when already the writer. */
  takeOver: () => Promise<void>;
  /** GitHub repo linked at session creation (home page). */
  githubRepo: SessionMeta['githubRepo'] | null;
}

export function useSessionRouting(): SessionRoutingState {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWriter, setIsWriter] = useState(true);
  const [githubRepo, setGithubRepo] = useState<SessionMeta['githubRepo'] | null>(null);
  /** Stable linked repo for autosave — mirrors `githubRepo` state. */
  const githubRepoRef = useRef<SessionMeta['githubRepo'] | null>(null);

  const applyGithubRepo = useCallback((repo: SessionMeta['githubRepo'] | null) => {
    githubRepoRef.current = repo;
    setGithubRepo(repo);
    useGithubSessionStore.getState().setLinkedRepo(repo);
  }, []);

  /** True during the initial hydration pass — the auto-save effect
   *  reads this to skip the writes that fire from our own setRules /
   *  appendMessage calls. Flipped to false once load completes. */
  const hydratingRef = useRef(true);
  /** Save key: stable per (userId, sessionId) so the autosave debounce
   *  resets across navigation. Stored as ref so the autosave effect
   *  doesn't tear down on every workspace tick. */
  const targetRef = useRef<{ userId: string; sessionId: string } | null>(null);
  /** The writer lock for this page's session. Null until the election
   *  ran (and in SSR). */
  const lockRef = useRef<SessionWriterLock | null>(null);
  /** Set by the auto-save effect: immediately persist + flush the
   *  sessions store. The lock calls this while we're still the writer
   *  when another tab takes over, so the successor restores our
   *  latest state. */
  const flushNowRef = useRef<(() => Promise<void>) | null>(null);
  /** Last hydrated session id — avoids clearing linked repo on Strict Mode remount. */
  const hydratedSessionRef = useRef<string | null>(null);

  /** Mirror a writer-status change everywhere it gates behavior:
   *  module-global flag (agent turns + persistence backend), VFS
   *  write gate, and this hook's state (banner). */
  const applyWriterStatus = useCallback((status: 'writer' | 'readonly') => {
    markSessionWriterStatus(status);
    setVFSReadOnly(status !== 'writer');
    setIsWriter(status === 'writer');
  }, []);

  // ─── Hydration ─────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get('session');
    if (!id) {
      // Direct navigation to /playground without a session → home.
      window.location.replace('/');
      return;
    }
    setSessionId(id);
    if (hydratedSessionRef.current && hydratedSessionRef.current !== id) {
      applyGithubRepo(null);
    }

    let cancelled = false;
    let unsubLock: (() => void) | null = null;
    void (async () => {
      // 1. Writer election — first, so the VFS gate + persistence
      //    backend see the right status before anything writes.
      const lock = await acquireSessionWriterLock(id, {
        onYield: async () => {
          await flushNowRef.current?.();
        },
      });
      if (cancelled) {
        lock.release();
        return;
      }
      lockRef.current = lock;
      applyWriterStatus(lock.status());
      // Track later transitions too (e.g. another tab takes over and
      // this tab yields mid-session).
      unsubLock = lock.subscribe(applyWriterStatus);

      // 2. Mount the per-session VFS container. Only the writer runs
      //    the one-time legacy /workspace migration — read-only tabs
      //    must not mutate OPFS.
      try {
        await ensureSessionVFS(id, { migrate: lock.status() === 'writer' });
      } catch (e) {
        console.warn('[playground] legacy workspace migration failed:', e);
      }
      if (cancelled) return;

      // 3. Restore the sessions store, then hydrate.
      await sessionsReady();
      if (cancelled) return;
      const userId = getCurrentUserId();
      targetRef.current = { userId, sessionId: id };
      try {
        const { meta, payload } = await loadSession(userId, id);
        if (cancelled) return;
        applyGithubRepo(meta.githubRepo ?? null);
        hydratedSessionRef.current = id;
        applyPayload(payload);
        hydratingRef.current = false;
        setLoaded(true);
        // A message carrying an `activeJob` stamp means the page died
        // mid-request (reload / mobile tab discard) — recover the rest
        // of that response from the durable job log. Writer only: a
        // read-only tab must not rewrite the conversation.
        if (lock.status() === 'writer') {
          void recoverInterruptedJobs();
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof SessionError && e.code === 'not-found') {
          // The id in the URL doesn't correspond to a session this
          // user owns. Best UX is to drop back to home rather than
          // render a stuck "loading" screen.
          window.location.replace('/');
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
        hydratingRef.current = false;
        setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
      unsubLock?.();
      lockRef.current?.release();
      lockRef.current = null;
    };
  }, [applyWriterStatus, applyGithubRepo]);

  // ─── Take over (read-only tab → writer) ─────────────────────────────
  const takeOver = useCallback(async () => {
    const lock = lockRef.current;
    const target = targetRef.current;
    if (!lock || lock.status() === 'writer') return;
    const ok = await lock.takeOver();
    if (!ok) {
      console.warn('[playground] take-over failed — the other tab did not yield');
      return;
    }
    applyWriterStatus('writer');
    // Re-sync from the persisted store: the previous writer flushed
    // its final state during the graceful yield, but THIS tab's
    // in-memory sessions sandbox restored at page load and never
    // re-reads. Dispose + recreate so the restore pass picks up the
    // latest blob, then re-hydrate the page stores from it.
    if (!target) return;
    try {
      disposeSessionsSandbox();
      await sessionsReady();
      const { meta, payload } = await loadSession(target.userId, target.sessionId);
      hydratingRef.current = true;
      applyGithubRepo(meta.githubRepo ?? null);
      applyPayload(payload);
    } catch (e) {
      console.warn('[playground] take-over re-sync failed:', e);
    } finally {
      hydratingRef.current = false;
    }
  }, [applyWriterStatus, applyGithubRepo]);

  // ─── Auto-save ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Gated on writer status: a read-only tab's ambient autosave was
    // the cross-tab last-writer-wins reverter — it must never run
    // while another tab holds the session's writer lock. Checked at
    // fire time (not effect-setup time) so a mid-session take-over /
    // yield is honored immediately.
    const persist = async (): Promise<void> => {
      const target = targetRef.current;
      if (!target) return;
      if (lockRef.current && lockRef.current.status() !== 'writer') return;
      const payload: SessionPayload = capturePayload();
      // Status seam for the TopBar indicator: report the actual save
      // lifecycle (never timer-derived). Writer-gated above: a
      // read-only tab never attempts a save, so it never reports one.
      reportAutosave({ status: 'saving' });
      try {
        await saveSession(target.userId, {
          id: target.sessionId,
          payload,
          ...(githubRepoRef.current ? { githubRepo: githubRepoRef.current } : {}),
        });
        reportAutosave({ status: 'saved', at: Date.now() });
      } catch (e) {
        reportAutosave({
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
        console.warn('[playground] auto-save failed:', e);
      }
    };

    const schedule = () => {
      if (hydratingRef.current) return;
      if (lockRef.current && lockRef.current.status() !== 'writer') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void persist(), AUTOSAVE_DEBOUNCE_MS);
    };

    // Final-flush hook for the writer lock's graceful yield: save the
    // current state AND force the sessions sandbox to flush its
    // persistence backend NOW (the controller's own debounce would
    // fire after we've already gone read-only and been gated off).
    flushNowRef.current = async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await persist();
      try {
        await getSessionsSandbox().getSandbox().flush();
      } catch {
        /* persistence not enabled / flush raced disposal — best-effort */
      }
    };

    const unsubWorkspace = useWorkspaceStore.subscribe(schedule);
    const unsubChat = useChatStore.subscribe(schedule);
    const unsubTrace = useTraceStore.subscribe(schedule);
    const unsubSkills = useSkillsStore.subscribe(schedule);

    // Also flush on tab close so the tail of the debounce window
    // doesn't get lost on navigation. Best-effort — the sandbox
    // persistence's own `beforeunload` flush picks up anything we
    // managed to save in time.
    const onBeforeUnload = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void persist();
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      unsubWorkspace();
      unsubChat();
      unsubTrace();
      unsubSkills();
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (timer) clearTimeout(timer);
      flushNowRef.current = null;
    };
  }, [loaded]);

  return { sessionId, loaded, error, isWriter, takeOver, githubRepo };
}

function applyPayload(payload: SessionPayload): void {
  useTraceStore.getState().hydrate(payload.telemetry);
  useSkillsStore.getState().hydrate(payload.activeSkills);

  // Workspace fields — set in one batch so a single subscriber sees
  // the final state rather than two intermediate ticks. Older payloads
  // also carried a `workspace.code` field for the retired sandbox-
  // script editor; it's intentionally ignored on load now.
  const ws = useWorkspaceStore.getState();
  ws.setRules(payload.workspace.rules);
  ws.setAppSource(payload.workspace.appSource);

  // Chat — clear any pre-existing messages, then append from the
  // payload. The session payload's `conversation` is loosely typed
  // (`unknown`) so the cast is narrow + scoped to known good shapes
  // we wrote in `saveSession`.
  const chat = useChatStore.getState();
  chat.clear();
  if (Array.isArray(payload.conversation)) {
    for (const raw of payload.conversation) {
      const msg = coerceMessage(raw);
      if (msg) chat.appendMessage(msg);
    }
  }
}

function capturePayload(): SessionPayload {
  const ws = useWorkspaceStore.getState();
  const chat = useChatStore.getState();
  const telemetry = useTraceStore.getState().snapshot();
  return {
    version: 1,
    workspace: {
      rules: ws.rules,
      // `code` was the sandbox-script editor body; retained as an
      // empty string in the payload so older session readers don't
      // break on a missing field.
      code: '',
      appSource: ws.appSource,
    },
    conversation: chat.messages,
    telemetry,
    // Only serialize the field when skills are active — keeps legacy
    // payload shape byte-stable for sessions that never used skills.
    ...(useSkillsStore.getState().activeSkillIds.length > 0
      ? { activeSkills: useSkillsStore.getState().activeSkillIds }
      : {}),
  };
}

/**
 * Coerce a loosely-typed conversation entry into a {@link ChatMessage}.
 * The home page seeds new sessions with `{ role: 'user', text }` which
 * is missing the id/createdAt fields the chat store carries — fill
 * them in here so the message renders. Existing assistant messages
 * (saved by the auto-save) already match the shape and pass through.
 */
function coerceMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<ChatMessage> & Record<string, unknown>;
  if (typeof m.text !== 'string' || m.text.length === 0) return null;
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  return {
    id: typeof m.id === 'string' ? m.id : `${role[0]}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    role,
    text: m.text,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
    ...(m.textChunks ? { textChunks: m.textChunks } : {}),
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.thinking ? { thinking: m.thinking } : {}),
    ...(m.providerLabel ? { providerLabel: m.providerLabel } : {}),
    ...(m.modelLabel ? { modelLabel: m.modelLabel } : {}),
    ...(typeof m.turnId === 'string' ? { turnId: m.turnId } : {}),
    ...(m.metrics ? { metrics: m.metrics } : {}),
    // Durable-job coordinates saved mid-request — lets reattach recover
    // the rest of an interrupted response (see inference/reattach.ts).
    ...(m.activeJob &&
    typeof (m.activeJob as { jobId?: unknown }).jobId === 'string' &&
    typeof (m.activeJob as { seq?: unknown }).seq === 'number'
      ? { activeJob: m.activeJob }
      : {}),
    // Interrupted-turn marker — keeps the "Resume turn" affordance alive
    // across reloads until the user acts on it.
    ...(m.interrupted &&
    typeof (m.interrupted as { toolCallsPending?: unknown }).toolCallsPending === 'boolean'
      ? { interrupted: m.interrupted }
      : {}),
    ...(m.thinkingChunks ? { thinkingChunks: m.thinkingChunks } : {}),
    ...(m.reflexionCritiques ? { reflexionCritiques: m.reflexionCritiques } : {}),
    ...(m.phaseEvents ? { phaseEvents: m.phaseEvents } : {}),
    ...(m.delegatedActivity ? { delegatedActivity: m.delegatedActivity } : {}),
    ...(m.rawTranscript ? { rawTranscript: m.rawTranscript } : {}),
  };
}
