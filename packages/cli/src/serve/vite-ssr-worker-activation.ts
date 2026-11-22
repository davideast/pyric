/**
 * Cross-thread propagation for Vite dev SSR activation (#1144).
 *
 * `attachViteSsrActivation` installs the active dev server's `ProcessActivation`
 * on the main thread's `globalThis`. Frameworks whose dev SSR runner evaluates
 * modules inside a `worker_threads.Worker` (such as Nuxt's vite-node) run the
 * routed `@pyric/cli/vite/ssr-loader` targets in a separate V8 isolate where the
 * main thread's `globalThis` is absent and `process.cwd()` may not be the Vite
 * project root.
 *
 * On the main thread, a 2-word `SharedArrayBuffer` (`[generationId, hostedFlag]`)
 * is published through `worker_threads.setEnvironmentData` so every spawned
 * worker sees server handovers and `hosted` mode changes synchronously via
 * `Atomics.load`, even if the worker was spawned during `configureServer` before
 * `httpServer.listen()` bound its port. An unreferenced in-process
 * `BroadcastChannel` answers async host URL, HTTPS certificate trust, and local
 * session-token queries from the server currently in force without holding the
 * Node event loop open.
 */
import {
  BroadcastChannel,
  getEnvironmentData,
  isMainThread,
  setEnvironmentData,
} from 'node:worker_threads';
import { FirebaseError } from 'pyric/app';
import type { Sandbox } from 'pyric/sandbox';
import {
  clearProcessActivation,
  installProcessActivation,
  type HostTrust,
  type ProcessActivation,
} from 'pyric/sandbox/internal';
import {
  connectRemoteSandbox,
  createLazyRemoteSandbox,
  createRemoteSandboxHandle,
  type LazyRemoteSandbox,
  type RemoteSandboxChannel,
} from '../remote/index.js';
import { isTrustedOrigin } from '../remote/loopback-tls.js';
import { registerLocalSessionToken } from './local-session-token.js';
import { VITE_SSR_ISSUE_URL } from './vite-ssr-routing.js';

/** Global symbol returning the current Vite SSR server generation id (`0` when none). */
const VITE_SSR_SERVER_EPOCH = Symbol.for('pyric.vite.ssrServerEpoch');

const SHARED_STATE_KEY = 'pyric.vite.ssrActivationState';
const CHANNEL_NAME = `pyric.vite.ssrActivation.${process.pid}`;
const WORKER_QUERY_TIMEOUT_MS = 5_000;
const WORKER_DISCOVER_TIMEOUT_MS = 25;
const LABEL = "the Vite dev server's server-rendered modules";

export type WorkerHostSnapshot =
  | { readonly status: 'closed' }
  | { readonly status: 'refused'; readonly code: string; readonly message: string }
  | {
      readonly status: 'ready';
      readonly generationId: number;
      readonly hosted: boolean;
      readonly url: string;
      readonly trust?: HostTrust;
      readonly sessionToken?: string;
    };

type ChannelMessage =
  | { readonly kind: 'discover'; readonly requestId: string }
  | { readonly kind: 'discovered'; readonly requestId: string; readonly sharedWords: Int32Array }
  | { readonly kind: 'query'; readonly requestId: string }
  | { readonly kind: 'reply'; readonly requestId: string; readonly snapshot: WorkerHostSnapshot }
  | { readonly kind: 'handover'; readonly generationId: number; readonly hosted: boolean }
  | { readonly kind: 'ended'; readonly generationId: number };

function unrefChannel(channel: BroadcastChannel): void {
  const unrefable = channel as unknown as { unref?: () => void };
  if (typeof unrefable.unref === 'function') {
    unrefable.unref();
  }
}

function workerSsrRefusal(detail?: string): FirebaseError {
  const reason = detail === undefined ? '' : ` (${detail})`;
  return new FirebaseError(
    'failed-precondition',
    'pyric: firebase/* and firebase-admin/* in server-rendered modules reach the sandbox only when the ' +
      'Vite dev server hosts it: use pyric({ hosted: true }). This dev server runs the sandbox in the ' +
      `browser (SharedWorker), which server code cannot reach${reason}. See ${VITE_SSR_ISSUE_URL}.`,
  );
}

let sharedWords: Int32Array | undefined;
if (isMainThread) {
  sharedWords = new Int32Array(new SharedArrayBuffer(8));
  setEnvironmentData(SHARED_STATE_KEY, sharedWords);
} else {
  const inherited = getEnvironmentData(SHARED_STATE_KEY);
  if (inherited instanceof Int32Array) {
    sharedWords = inherited;
  }
}

function currentGenerationId(): number {
  if (sharedWords === undefined) return 0;
  return Atomics.load(sharedWords, 0);
}

function installEpochReader(): void {
  const holder = globalThis as Record<symbol, unknown>;
  if (typeof holder[VITE_SSR_SERVER_EPOCH] !== 'function') {
    holder[VITE_SSR_SERVER_EPOCH] = currentGenerationId;
  }
}

installEpochReader();

let nextGenerationId = 0;
let mainChannel: BroadcastChannel | undefined;
let mainResolver: (() => Promise<WorkerHostSnapshot>) | undefined;

function ensureMainChannel(): BroadcastChannel {
  if (mainChannel !== undefined) return mainChannel;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event) => {
    const data = (event as { data?: unknown }).data as Partial<ChannelMessage> | null;
    if (data === null || typeof data !== 'object') return;
    if (data.kind === 'discover' && typeof data.requestId === 'string') {
      if (sharedWords !== undefined && Atomics.load(sharedWords, 0) > 0) {
        const reply: ChannelMessage = {
          kind: 'discovered',
          requestId: data.requestId,
          sharedWords,
        };
        channel.postMessage(reply);
      }
      return;
    }
    if (data.kind === 'query' && typeof data.requestId === 'string') {
      const requestId = data.requestId;
      const resolveSnapshot = mainResolver;
      if (resolveSnapshot === undefined) {
        const closedReply: ChannelMessage = {
          kind: 'reply',
          requestId,
          snapshot: { status: 'closed' },
        };
        channel.postMessage(closedReply);
        return;
      }
      void resolveSnapshot().then(
        (snapshot) => {
          const reply: ChannelMessage = { kind: 'reply', requestId, snapshot };
          mainChannel?.postMessage(reply);
        },
        (error: unknown) => {
          const code = error instanceof FirebaseError ? error.code : 'failed-precondition';
          const message = error instanceof Error ? error.message : String(error);
          const reply: ChannelMessage = {
            kind: 'reply',
            requestId,
            snapshot: { status: 'refused', code, message },
          };
          mainChannel?.postMessage(reply);
        },
      );
    }
  };
  unrefChannel(channel);
  mainChannel = channel;
  return channel;
}

/** Publish a newly attached main-thread Vite dev server to worker threads. */
export function publishMainViteSsrActivation(
  hosted: boolean,
  resolveSnapshot: () => Promise<WorkerHostSnapshot>,
): number {
  installEpochReader();
  nextGenerationId += 1;
  const generationId = nextGenerationId;
  mainResolver = resolveSnapshot;
  if (sharedWords !== undefined) {
    Atomics.store(sharedWords, 1, hosted ? 1 : 0);
    Atomics.store(sharedWords, 0, generationId);
  }
  const channel = ensureMainChannel();
  const handover: ChannelMessage = { kind: 'handover', generationId, hosted };
  channel.postMessage(handover);
  return generationId;
}

/** Clear the published main-thread Vite dev server if `generationId` is still in force. */
export function clearMainViteSsrActivation(generationId: number): void {
  if (sharedWords !== undefined) {
    const active = Atomics.load(sharedWords, 0);
    if (active !== generationId) return;
    Atomics.store(sharedWords, 0, 0);
    Atomics.store(sharedWords, 1, 0);
  }
  mainResolver = undefined;
  if (mainChannel !== undefined) {
    const ended: ChannelMessage = { kind: 'ended', generationId };
    mainChannel.postMessage(ended);
    mainChannel.close();
    mainChannel = undefined;
  }
}

let querySeq = 0;
let latestTrust: HostTrust | undefined;
let unregisterWorkerPortToken: (() => void) | undefined;
let workerEventChannel: BroadcastChannel | undefined;
let workerAdminHandle: LazyRemoteSandbox | undefined;
let cachedWorkerSandbox: { generationId: number; sandbox: LazyRemoteSandbox } | undefined;

function parsePortOf(rawUrl: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (parsed.port !== '') {
    const numeric = Number(parsed.port);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
  }
  if (parsed.protocol === 'https:') return 443;
  if (parsed.protocol === 'http:') return 80;
  return undefined;
}

function recordWorkerHostAuth(snapshot: Extract<WorkerHostSnapshot, { status: 'ready' }>): void {
  latestTrust = snapshot.trust;
  unregisterWorkerPortToken?.();
  unregisterWorkerPortToken = undefined;
  if (snapshot.sessionToken !== undefined && snapshot.sessionToken.length > 0) {
    const port = parsePortOf(snapshot.url);
    if (port !== undefined) {
      unregisterWorkerPortToken = registerLocalSessionToken(port, snapshot.sessionToken);
    }
  }
}

function closeCachedWorkerSandbox(): void {
  cachedWorkerSandbox?.sandbox.close();
  cachedWorkerSandbox = undefined;
}

function queryMainHost(): Promise<WorkerHostSnapshot> {
  if (currentGenerationId() <= 0) {
    return Promise.resolve({ status: 'closed' });
  }
  querySeq += 1;
  const requestId = `${process.pid}-q-${querySeq}-${Math.random().toString(36).slice(2)}`;
  return new Promise<WorkerHostSnapshot>((resolve, reject) => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      channel.close();
      reject(new Error('pyric: timed out waiting for the Vite dev server host activation.'));
    }, WORKER_QUERY_TIMEOUT_MS);
    channel.onmessage = (event) => {
      const data = (event as { data?: unknown }).data as Partial<ChannelMessage> | null;
      if (data === null || typeof data !== 'object') return;
      if (data.kind !== 'reply' || data.requestId !== requestId || data.snapshot === undefined) {
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.close();
      resolve(data.snapshot);
    };
    const query: ChannelMessage = { kind: 'query', requestId };
    channel.postMessage(query);
  });
}

async function resolveReadyWorkerHost(): Promise<Extract<WorkerHostSnapshot, { status: 'ready' }>> {
  const snapshot = await queryMainHost();
  if (snapshot.status === 'closed') {
    throw new Error('pyric: the Vite dev server has closed.');
  }
  if (snapshot.status === 'refused') {
    throw new FirebaseError(snapshot.code, snapshot.message);
  }
  recordWorkerHostAuth(snapshot);
  return snapshot;
}

function workerServerSandbox(): LazyRemoteSandbox {
  const generationId = currentGenerationId();
  if (generationId <= 0) {
    closeCachedWorkerSandbox();
    return createLazyRemoteSandbox(() =>
      Promise.reject(new Error('pyric: the Vite dev server has closed.')),
    );
  }
  if (cachedWorkerSandbox !== undefined && cachedWorkerSandbox.generationId === generationId) {
    return cachedWorkerSandbox.sandbox;
  }
  closeCachedWorkerSandbox();
  const isHosted = sharedWords !== undefined && Atomics.load(sharedWords, 1) === 1;
  let sandbox: LazyRemoteSandbox;
  if (!isHosted) {
    sandbox = createLazyRemoteSandbox(() => Promise.reject(workerSsrRefusal()));
  } else {
    sandbox = createLazyRemoteSandbox((onConnectionLost) =>
      resolveReadyWorkerHost().then((ready) => {
        if (!ready.hosted) {
          throw workerSsrRefusal();
        }
        let trust: HostTrust | undefined;
        if (ready.trust !== undefined && isTrustedOrigin(ready.trust, ready.url)) {
          trust = ready.trust;
        }
        return connectRemoteSandbox({
          url: ready.url,
          trust,
          sessionToken: ready.sessionToken,
          onConnectionLost,
        });
      }),
    );
  }
  cachedWorkerSandbox = { generationId, sandbox };
  return sandbox;
}

function workerAdminSandbox(): Sandbox {
  if (workerAdminHandle !== undefined) return workerAdminHandle;
  const channel: RemoteSandboxChannel = {
    op(payload) {
      return workerServerSandbox().channel.op(payload);
    },
    byteRoute() {
      return workerServerSandbox().channel.byteRoute?.() ?? Promise.resolve(undefined);
    },
    subscribe(sub, onSnap, onError) {
      return workerServerSandbox().channel.subscribe(sub, onSnap, onError);
    },
  };
  const handle = createRemoteSandboxHandle({
    channel,
    serveUrl: '<pyric sandbox url (pending discovery)>',
    close() {
      closeCachedWorkerSandbox();
    },
  }) as LazyRemoteSandbox;
  Object.defineProperty(handle, 'ready', {
    get: (): Promise<void> => workerServerSandbox().ready,
    enumerable: true,
    configurable: true,
  });
  workerAdminHandle = handle;
  return handle;
}

const workerActivation: ProcessActivation = {
  label: LABEL,
  host: async () => (await resolveReadyWorkerHost()).url,
  offHostError: (detail) => workerSsrRefusal(detail),
  adminSandbox: () => workerAdminSandbox(),
  hostTrust(url) {
    const trust = latestTrust;
    if (trust !== undefined && isTrustedOrigin(trust, url)) return trust;
    return undefined;
  },
};

function ensureWorkerEventChannel(): void {
  if (workerEventChannel !== undefined) return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event) => {
    const data = (event as { data?: unknown }).data as Partial<ChannelMessage> | null;
    if (data === null || typeof data !== 'object') return;
    if (data.kind === 'handover' && typeof data.generationId === 'number') {
      closeCachedWorkerSandbox();
      latestTrust = undefined;
      installProcessActivation(workerActivation);
      return;
    }
    if (data.kind === 'ended') {
      if (currentGenerationId() > 0) return;
      closeCachedWorkerSandbox();
      latestTrust = undefined;
      unregisterWorkerPortToken?.();
      unregisterWorkerPortToken = undefined;
      clearProcessActivation(workerActivation);
    }
  };
  unrefChannel(channel);
  workerEventChannel = channel;
}

/**
 * Synchronously install the Vite SSR worker activation if this thread is a
 * `worker_threads.Worker` with an active main-thread Vite dev server.
 */
export function installSyncWorkerViteSsrActivationIfActive(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isMainThread) return false;
  if ((env.PYRIC_SANDBOX ?? '').trim().length > 0) return false;
  if (sharedWords === undefined) {
    const inherited = getEnvironmentData(SHARED_STATE_KEY);
    if (inherited instanceof Int32Array) {
      sharedWords = inherited;
    }
  }
  if (sharedWords === undefined || Atomics.load(sharedWords, 0) <= 0) {
    return false;
  }
  installEpochReader();
  ensureWorkerEventChannel();
  installProcessActivation(workerActivation);
  return true;
}

function discoverSharedWordsFromMain(): Promise<void> {
  querySeq += 1;
  const requestId = `${process.pid}-d-${querySeq}-${Math.random().toString(36).slice(2)}`;
  return new Promise<void>((resolve) => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      channel.close();
      resolve();
    };
    const timer = setTimeout(finish, WORKER_DISCOVER_TIMEOUT_MS);
    channel.onmessage = (event) => {
      const data = (event as { data?: unknown }).data as Partial<ChannelMessage> | null;
      if (data === null || typeof data !== 'object') return;
      if (data.kind === 'discovered' && data.requestId === requestId && data.sharedWords instanceof Int32Array) {
        sharedWords = data.sharedWords;
        clearTimeout(timer);
        finish();
      }
    };
    unrefChannel(channel);
    const discover: ChannelMessage = { kind: 'discover', requestId };
    channel.postMessage(discover);
  });
}

/**
 * Ensure the Vite SSR worker activation is installed in this worker thread
 * before `@pyric/cli/vite/ssr-loader` evaluates a routed target module.
 */
export async function ensureWorkerViteSsrActivation(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (isMainThread) return;
  if ((env.PYRIC_SANDBOX ?? '').trim().length > 0) return;
  if (installSyncWorkerViteSsrActivationIfActive(env)) return;
  if (sharedWords === undefined) {
    await discoverSharedWordsFromMain();
    installSyncWorkerViteSsrActivationIfActive(env);
  }
}
