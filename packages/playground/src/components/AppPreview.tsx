/**
 * Live preview of the user's TSX module. Subscribes to
 * `workspace.appSource`, debounces (300ms) so the user can finish
 * typing before we recompile, then mounts the resulting component
 * inside a `PreviewErrorBoundary`.
 *
 * The user's `appSource` uses canonical `firebase/firestore` +
 * `react` imports — the same shape a production build sees. The
 * preview compiles via `esbuild-wasm` and aliases those imports
 * to pyric-flavored values exposed on
 * `globalThis.__pyricPreview__`. `sandbox.*` is deliberately not
 * in scope here — it belongs to the runner (`code` artifact) only.
 *
 * Recompile is async. No HMR semantics — every recompile is a
 * fresh mount, so any local useState resets.
 *
 * The user's component always renders once it compiles — we never
 * short-circuit on "the sandbox is empty," because that hides
 * authored apps. Empty-state framing lives inside the user's
 * component, which they own. The playground's fallbacks only kick
 * in for transient compile/runtime/no-source states.
 */
import * as React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import {
  getFirestore,
  onSnapshot,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  or,
  and,
  orderBy,
  limit,
  limitToLast,
  startAt,
  startAfter,
  endAt,
  endBefore,
  runTransaction,
  writeBatch,
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  deleteField,
  FieldValue,
  Timestamp,
  refEqual,
  queryEqual,
  snapshotEqual,
} from 'pyric/firestore';
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  onIdTokenChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  setPersistence,
  signInWithPopup,
  signInWithCredential,
  signInWithRedirect,
  getRedirectResult,
  getIdToken,
  getIdTokenResult,
  GoogleAuthProvider,
  EmailAuthProvider,
  FacebookAuthProvider,
  GithubAuthProvider,
  OAuthProvider,
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence,
  sandbox as authSandbox,
} from 'pyric/auth';
import {
  getDatabase,
  ref as rtdbRef,
  child as rtdbChild,
  get as rtdbGet,
  set as rtdbSet,
  update as rtdbUpdate,
  remove as rtdbRemove,
  push as rtdbPush,
  onValue as rtdbOnValue,
  off as rtdbOff,
  serverTimestamp as rtdbServerTimestamp,
  connectDatabaseEmulator,
} from 'pyric/database';
import { useEffect, useMemo, useState } from 'react';
import { PreviewAuthHelper } from './PreviewAuthHelper';
import type { Sandbox } from 'pyric/sandbox';
import { compileApp, type CompileResult } from '~/lib/preview/compile';
import type { PreviewScope } from '~/lib/preview/preview-scope';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { useFilesStore } from '~/lib/store/files';
import {
  getWorkerDb,
  getPlaygroundRuntime,
  isSharedSandboxMode,
  sharedWorkerRuntime,
} from '~/lib/sandbox/runtime';
import { DenialBanner } from './DenialBanner';
import { EmptyState } from './EmptyState';
import { IframePreview } from './IframePreview';
import { PreviewErrorBoundary } from './PreviewErrorBoundary';
import { TerminalView } from './TerminalView';
import type { LogEntry } from '~/lib/sandbox/runner';

const DEBOUNCE_MS = 300;

interface AppPreviewProps {
  onFixRequest?: (prompt: string) => void;
  onOpenDenials?: () => void;
}

/**
 * Build the agent-facing prompt the Fix button submits. Keeps the
 * model focused on the App TSX and reminds it of the canonical
 * import shape the preview and a production build expect. Same prompt
 * shape for compile and runtime errors.
 */
function buildFixPrompt(kind: 'compile' | 'runtime', body: string): string {
  // Wrap the error body in a fenced code block so the chat renderer
  // displays it via `<CodeBlock>` (foldable past 14 lines, copy chip,
  // bordered panel) rather than as raw `<p>` text. `text` language —
  // the body mixes error labels and code excerpts, no single
  // grammar fits.
  return [
    `The App preview is broken with a ${kind} error.`,
    '',
    '```text',
    body,
    '```',
    '',
    'Fix the App TSX (writeApp). Reminders:',
    '- Use canonical imports: `import { collection, getDoc } from "firebase/firestore"`,',
    '  `import { useState } from "react"`, `import { db } from "./firebase"`.',
    '- Export the component as `export default function App() { … }`.',
    '- Use the MODULAR Firestore shape (`collection(db, "users")`, `getDoc(ref)`,',
    '  `setDoc(ref, data)`) — not `db.collection(...).get()`.',
    '- `firebase/auth` IS available in app code (aliased to `pyric/auth` in',
    '  sandbox preview, real `firebase/auth` in a production build). Call `getAuth()` inside',
    '  hooks; subscribe with `onAuthStateChanged(getAuth(), …)` in a `useEffect`.',
    '- The `sandbox` global is NOT available in app code — only in runner `code`.',
    '- Import from canonical `firebase/*` paths; the Playground compiler owns the sandbox mapping.',
    'After editing, call runOnce to make sure rules still pass.',
  ].join('\n');
}

export function AppPreview({ onFixRequest, onOpenDenials }: AppPreviewProps) {
  const appSource = useWorkspaceStore((s) => s.appSource);
  // Recompile triggers, debounced TOGETHER:
  //  - appSource: the App.tsx entry text (store mirror).
  //  - srcVersion: bumps on ANY /workspace/src/ mutation — esbuild reads
  //    imported files fresh from the VFS, so editing ONLY an imported
  //    component must recompile too (the historical stale-preview bug:
  //    recompile keyed on the appSource string alone).
  //  - refreshNonce: the manual refresh button — force a recompile even
  //    when nothing tracked changed (belt-and-braces for unknown holes).
  const srcVersion = useFilesStore((s) => s.srcVersion);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [snapshot, setSnapshot] = useState({ text: appSource, key: '0:0' });
  // The compile RESULT is bound to the resetKey it was built for. The
  // preview mounts on `compile.forKey`, never the live resetKey — a
  // pre-existing race left the preview permanently stale after edits:
  // setCompile resolves AFTER the render where resetKey changed, and
  // PreviewMount's useMemo([resetKey]) then cached the OLD bundle under
  // the NEW key ("UI isn't updated until I refresh the page").
  const [compile, setCompile] = useState<{ result: CompileResult; forKey: string } | null>(null);

  useEffect(() => {
    const id = setTimeout(
      () => setSnapshot({ text: appSource, key: `${srcVersion}:${refreshNonce}` }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(id);
  }, [appSource, srcVersion, refreshNonce]);

  const debounced = snapshot.text;
  // resetKey carries the version/nonce too, so a forced refresh (or an
  // imported-file edit) remounts with a freshly compiled component even
  // when App.tsx itself is byte-identical.
  const resetKey = `${snapshot.key}\u0000${snapshot.text}`;

  useEffect(() => {
    if (!debounced.trim()) {
      setCompile(null);
      return;
    }
    let cancelled = false;
    compileApp(debounced).then((result) => {
      if (!cancelled) setCompile({ result, forKey: resetKey });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  if (!compile) {
    return (
      <EmptyState
        icon="web"
        title="No app yet"
        body='Switch to Code → App and declare `export default function App()` — the preview mounts the default export.'
      />
    );
  }

  if (!compile.result.ok) {
    return (
      <CompileErrorView
        message={compile.result.message}
        line={compile.result.line}
        column={compile.result.column}
        onFixRequest={onFixRequest}
      />
    );
  }

  return (
    <PreviewErrorBoundary
      resetKey={compile.forKey}
      fallback={(err) => <RuntimeErrorView error={err} onFixRequest={onFixRequest} />}
    >
      <PreviewMount
        evaluate={compile.result.evaluate}
        resetKey={compile.forKey}
        onOpenDenials={onOpenDenials}
        onRefresh={() => setRefreshNonce((n) => n + 1)}
      />
    </PreviewErrorBoundary>
  );
}

interface PreviewMountProps {
  evaluate: (scope: PreviewScope, sandboxHandle: unknown) => unknown;
  /** Different source → fresh useMemo → fresh component instance. */
  resetKey: string;
  /** Manual refresh — force recompile + remount from the current VFS. */
  onRefresh: () => void;
  onOpenDenials?: () => void;
}

function PreviewMount({ evaluate, resetKey, onOpenDenials, onRefresh }: PreviewMountProps) {
  // Fullscreen state is local — the iframe stays mounted as the
  // wrapper class swaps from `flex-1 min-h-0` to `fixed inset-0 z-50`,
  // so the user's app retains its in-iframe state across the
  // transition.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const Component = useMemo(() => {
    const shared = isSharedSandboxMode();
    const runner = shared ? null : getPlaygroundRuntime().requireInProcessRunner('App preview isolated runtime');
    const workerDb = shared ? getWorkerDb() : null;
    const scope = {
      react: React,
      'react/jsx-runtime': ReactJsxRuntime as unknown as Record<string, unknown>,
      'react/jsx-dev-runtime': ReactJsxDevRuntime as unknown as Record<string, unknown>,
      'firebase/firestore': {
        // `getFirestore` is wrapped so a bare `getFirestore()` call
        // in app code (the canonical
        // `import { getFirestore } from "firebase/firestore"` shape)
        // defaults to the runner's sandbox. Mirrors the `getAuth`
        // wrap below; both keep canonical app code portable while
        // package resolution chooses the sandbox implementation in
        // the Playground and Firebase in production. The agent reliably
        // drifts into bare `getFirestore()` calls (see
        // `packages/playground/scripts/playground-debug.ts`
        // replay against a saved session), so the wrap is the load-
        // bearing safety net even though the system prompt also
        // tells the agent to prefer `import { db } from "./firebase"`.
        // Inner cast picks one overload at TS-check time — runtime
        // dispatch happens inside `pyric/firestore.getFirestore`.
        getFirestore: shared
          ? ((target?: unknown) => (target && typeof target === 'object' ? target : workerDb)) as typeof getFirestore
          : ((target?: Parameters<typeof getFirestore>[0]) =>
              getFirestore((target ?? runner!.getSandbox()) as Sandbox)) as typeof getFirestore,
        onSnapshot: shared ? sharedWorkerRuntime.onSnapshot : onSnapshot,
        collection: shared ? sharedWorkerRuntime.collection : collection,
        collectionGroup: shared ? sharedWorkerRuntime.collectionGroup : collectionGroup,
        doc: shared ? sharedWorkerRuntime.doc : doc,
        getDoc: shared ? sharedWorkerRuntime.getDoc : getDoc,
        getDocs: shared ? sharedWorkerRuntime.getDocs : getDocs,
        setDoc: shared ? sharedWorkerRuntime.setDoc : setDoc,
        addDoc: shared ? sharedWorkerRuntime.addDoc : addDoc,
        updateDoc: shared ? sharedWorkerRuntime.updateDoc : updateDoc,
        deleteDoc: shared ? sharedWorkerRuntime.deleteDoc : deleteDoc,
        query: shared ? sharedWorkerRuntime.query : query,
        where: shared ? sharedWorkerRuntime.where : where,
        or,
        and,
        orderBy: shared ? sharedWorkerRuntime.orderBy : orderBy,
        limit: shared ? sharedWorkerRuntime.limit : limit,
        limitToLast: shared ? sharedWorkerRuntime.limitToLast : limitToLast,
        startAt: shared ? sharedWorkerRuntime.startAt : startAt,
        startAfter: shared ? sharedWorkerRuntime.startAfter : startAfter,
        endAt: shared ? sharedWorkerRuntime.endAt : endAt,
        endBefore: shared ? sharedWorkerRuntime.endBefore : endBefore,
        runTransaction: shared ? sharedWorkerRuntime.runTransaction : runTransaction,
        writeBatch: shared ? sharedWorkerRuntime.writeBatch : writeBatch,
        serverTimestamp: shared ? sharedWorkerRuntime.serverTimestamp : serverTimestamp,
        increment: shared ? sharedWorkerRuntime.increment : increment,
        arrayUnion: shared ? sharedWorkerRuntime.arrayUnion : arrayUnion,
        arrayRemove: shared ? sharedWorkerRuntime.arrayRemove : arrayRemove,
        deleteField: shared ? sharedWorkerRuntime.deleteField : deleteField,
        FieldValue,
        Timestamp,
        refEqual,
        queryEqual,
        snapshotEqual,
      },
      // `firebase/auth` is aliased to `pyric/auth` at preview-bundle
      // time. AppPreview supplies the mirror surface so the runner's
      // sandbox sees identity changes (paired with runner.ts's
      // `getFirestore(this.sandbox)` per-call overload).
      //
      // `getAuth` is wrapped so a `getAuth()` call with no args
      // (the canonical `import { getAuth } from "firebase/auth"`
      // shape) defaults to the runner's sandbox in the preview. In a
      // production build the canonical import resolves directly to
      // Firebase, so app code stays portable between worlds.
      'firebase/auth': {
        getAuth: shared
          ? (((target?: unknown) => sharedWorkerRuntime.getAuth(
              target && typeof target === 'object' && '__kind' in target
                ? target as Parameters<typeof sharedWorkerRuntime.getAuth>[0]
                : workerDb!,
            )) as unknown as typeof getAuth)
          : ((target?: Parameters<typeof getAuth>[0]) =>
              getAuth((target ?? runner!.getSandbox()) as Sandbox)) as typeof getAuth,
        connectAuthEmulator,
        onAuthStateChanged: shared ? sharedWorkerRuntime.onAuthStateChanged : onAuthStateChanged,
        onIdTokenChanged: shared ? sharedWorkerRuntime.onIdTokenChanged : onIdTokenChanged,
        signInAnonymously: shared ? sharedWorkerRuntime.signInAnonymously : signInAnonymously,
        signInWithEmailAndPassword: shared ? sharedWorkerRuntime.signInWithEmailAndPassword : signInWithEmailAndPassword,
        createUserWithEmailAndPassword: shared ? sharedWorkerRuntime.createUserWithEmailAndPassword : createUserWithEmailAndPassword,
        signOut: shared ? sharedWorkerRuntime.signOut : signOut,
        setPersistence: shared ? sharedWorkerRuntime.setPersistence : setPersistence,
        signInWithPopup,
        signInWithCredential,
        signInWithRedirect,
        getRedirectResult,
        getIdToken,
        getIdTokenResult,
        GoogleAuthProvider,
        EmailAuthProvider,
        FacebookAuthProvider,
        GithubAuthProvider,
        OAuthProvider,
        browserLocalPersistence,
        browserSessionPersistence,
        inMemoryPersistence,
        // Preview-only sandbox driver — `seedUsers`, `setUser`,
        // `mockSignInResult`. Lets preview tests pre-stage
        // test users with customClaims. Generated application source
        // must not use this host-only testing capability.
        sandbox: authSandbox,
      },
      // `firebase/database` is aliased to `pyric/database` at preview-
      // bundle time. Same wrap rationale as
      // `getAuth` / `getFirestore` above: a bare `getDatabase()`
      // call with no args defaults to the runner's sandbox so app
      // code stays portable between sandbox preview and production.
      // The `sandbox.*` test-driver namespace from `pyric/database`
      // is intentionally NOT exposed to app code — that's runner-
      // side only.
      'firebase/database': {
        getDatabase: shared
          ? ((() => sharedWorkerRuntime.rtdbGetDatabase(workerDb!)) as unknown as typeof getDatabase)
          : ((target?: Parameters<typeof getDatabase>[0]) =>
              getDatabase((target ?? runner!.getSandbox()) as Sandbox)) as typeof getDatabase,
        ref: shared ? sharedWorkerRuntime.rtdbRef : rtdbRef,
        child: shared ? sharedWorkerRuntime.rtdbChild : rtdbChild,
        get: shared ? sharedWorkerRuntime.rtdbGet : rtdbGet,
        set: shared ? sharedWorkerRuntime.rtdbSet : rtdbSet,
        update: shared ? sharedWorkerRuntime.rtdbUpdate : rtdbUpdate,
        remove: shared ? sharedWorkerRuntime.rtdbRemove : rtdbRemove,
        push: shared ? sharedWorkerRuntime.rtdbPush : rtdbPush,
        onValue: shared ? sharedWorkerRuntime.rtdbOnValue : rtdbOnValue,
        off: shared ? sharedWorkerRuntime.rtdbOff : rtdbOff,
        serverTimestamp: shared ? sharedWorkerRuntime.rtdbServerTimestamp : rtdbServerTimestamp,
        connectDatabaseEmulator: shared ? sharedWorkerRuntime.rtdbConnectDatabaseEmulator : connectDatabaseEmulator,
      },
      './firebase': { db: shared ? workerDb : runner!.getDb() },
    };
    const resolved = evaluate(scope as unknown as PreviewScope, shared ? { runtime: 'shared-worker' } : runner!.getSandbox());
    if (typeof resolved !== 'function') return null;
    return resolved as React.ComponentType;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Sign-in helper: `PreviewAuthHelper` (via `@pyric/ui/auth`'s
  // `useAuthFlowHelper`) injects the popup/redirect resolver into the
  // sandbox's auth — the analog of browser `getAuth` wiring
  // `browserPopupRedirectResolver` — so an app calling `signInWithPopup`
  // opens the account-picker modal below. The handle is re-resolved on
  // reset, when the runner's sandbox may be fresh; the hook re-installs
  // whenever the handle identity changes (StrictMode-safe paired effect).
  const previewAuth = useMemo(
    () => {
      if (isSharedSandboxMode()) return null;
      const auth = getAuth(
        getPlaygroundRuntime().requireInProcessRunner('Preview auth helper').getSandbox() as Sandbox,
      );
      // The helper IS the federated provider here (same wiring as the served
      // firebase/auth entry): delegate provider enforcement so the picker
      // opens regardless of the sandbox's provider-config defaults — a
      // prototype's "Sign in with Google" must open the account picker, not
      // throw auth/operation-not-allowed before the modal exists.
      authSandbox.delegateProviderEnforcement(auth, true);
      return auth;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resetKey],
  );

  if (!Component) {
    return (
      <EmptyState
        icon="code_off"
        title="No default export found"
        body="Add `export default function App() { … }` — the preview mounts the default export."
      />
    );
  }

  return (
    <div
      className={[
        'bg-content-bg flex flex-col',
        // Fullscreen overlays the entire viewport — TopBar, tabs,
        // BottomTabBar all sit behind the z-50 layer. ESC or the
        // close-button exits.
        fullscreen ? 'fixed inset-0 z-50' : 'flex-1 min-h-0',
      ].join(' ')}
    >
      <DenialBanner onOpenDenials={onOpenDenials} />
      {previewAuth ? <PreviewAuthHelper auth={previewAuth} /> : null}
      <div className="flex-1 min-h-0 relative">
        <IframePreview Component={Component} />
        <button
          type="button"
          onClick={onRefresh}
          className={[
            'absolute top-3 right-12 z-10 p-1.5 rounded-md',
            'bg-black/40 backdrop-blur-sm text-white',
            'hover:bg-black/60 transition-colors',
          ].join(' ')}
          title="Refresh the preview — recompile from the current workspace files"
          aria-label="Refresh preview"
        >
          <span className="material-symbols-outlined text-[16px]">refresh</span>
        </button>
        <button
          type="button"
          onClick={() => setFullscreen((v) => !v)}
          // Semi-transparent black chip — reads on both light and
          // dark user-app backgrounds. Top-right keeps it out of the
          // app's main interactive area; absolute positioning floats
          // it above the iframe.
          className={[
            'absolute top-3 right-3 z-10 p-1.5 rounded-md',
            'bg-black/40 backdrop-blur-sm text-white',
            'hover:bg-black/60 transition-colors',
            'flex items-center gap-1.5',
          ].join(' ')}
          title={
            fullscreen
              ? 'Back to playground (Esc)'
              : 'Open the preview in full window'
          }
        >
          <span className="material-symbols-outlined text-[16px]">
            {fullscreen ? 'close_fullscreen' : 'fullscreen'}
          </span>
          {fullscreen ? (
            <span className="text-[11px] font-mono pr-1">back</span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

/**
 * Header strip + TerminalView panel. Shared chrome for compile +
 * runtime errors — same vocabulary as the Output tab's sandbox
 * stdout (pure-black panel, columnar severity, indented payload), so
 * "the user's code threw" and "the sandbox emitted" read as the same
 * kind of artifact. Optional `onFixRequest` renders a "Fix with
 * agent" button that submits a pre-built prompt to the active model.
 */
function ErrorPanel({
  kind,
  entries,
  copyPayload,
  fixPrompt,
  onFixRequest,
}: {
  kind: 'compile' | 'runtime';
  entries: readonly LogEntry[];
  copyPayload: string;
  fixPrompt: string;
  onFixRequest?: (prompt: string) => void;
}) {
  const title = kind === 'compile' ? 'compile error' : 'runtime error';
  return (
    <div className="flex-1 overflow-auto bg-content-bg px-4 py-3 flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-[16px] text-[#f0a0a0]">error</span>
        <span className="text-[10px] uppercase tracking-wider text-[#f0a0a0] font-bold">
          {title}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {onFixRequest ? (
            <button
              type="button"
              onClick={() => onFixRequest(fixPrompt)}
              title="Send this error to the agent and ask it to repair the App"
              className={[
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md',
                'bg-[#2a2a35] hover:bg-[#3a3a48] transition-colors',
                'text-[11px] font-mono uppercase tracking-wider text-soft-white',
              ].join(' ')}
            >
              <span className="material-symbols-outlined text-[14px]">auto_fix_high</span>
              Fix
            </button>
          ) : null}
        </span>
      </div>
      <TerminalView entries={entries} title="stderr" meta={copyPayload ? undefined : ''} />
    </div>
  );
}

function CompileErrorView({
  message,
  line,
  column,
  onFixRequest,
}: {
  message: string;
  line?: number;
  column?: number;
  onFixRequest?: (prompt: string) => void;
}) {
  const locTag = line != null ? `${line}${column != null ? `:${column}` : ''}` : undefined;
  const entries: LogEntry[] = [
    { level: 'error', message, ...(locTag ? { tag: locTag } : {}) },
  ];
  const body = `${locTag ? `(line ${locTag})\n` : ''}${message}`;
  return (
    <ErrorPanel
      kind="compile"
      entries={entries}
      copyPayload={body}
      fixPrompt={buildFixPrompt('compile', body)}
      onFixRequest={onFixRequest}
    />
  );
}

function RuntimeErrorView({
  error,
  onFixRequest,
}: {
  error: Error;
  onFixRequest?: (prompt: string) => void;
}) {
  // `error.stack` typically leads with `Name: message` then frame
  // lines. Skip that leading line if it matches the message we're
  // already showing in the message column — keeps the payload to
  // frame-only content. Reads as "error on top, trace below."
  const stack = error.stack ?? '';
  const head = `${error.name}: ${error.message}`;
  const trace = stack.startsWith(head)
    ? stack.slice(head.length).replace(/^\r?\n/, '')
    : stack;
  const entries: LogEntry[] = [
    { level: 'error', message: head, ...(trace ? { payload: trace } : {}) },
  ];
  const body = `${head}${trace ? `\n\nStack:\n${trace}` : ''}`;
  return (
    <ErrorPanel
      kind="runtime"
      entries={entries}
      copyPayload={body}
      fixPrompt={buildFixPrompt('runtime', body)}
      onFixRequest={onFixRequest}
    />
  );
}
