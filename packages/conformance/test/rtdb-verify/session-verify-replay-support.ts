import 'fake-indexeddb/auto';
import { afterEach, expect, spyOn } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Query } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox, type AuthLens } from 'pyric/sandbox';
import type { BridgeMessage } from '../../../cli/dist/bridge/protocol.js';
import { parseArgs } from '../../../cli/dist/cli/parse-args.js';
import { runVerify } from '../../../cli/dist/cli/verify.js';
import { createCaptureStore } from '../../../cli/dist/serve/capture-store.js';
import { createHostedRuntime } from '../../../cli/dist/serve/hosted/runtime.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/dist/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  RtdbWireQuerySpec,
  SnapMessage,
} from '../../../cli/dist/serve/worker/protocol.js';
import { applyServeInit } from '../../../cli/dist/serve/worker/serve-init.js';
import {
  parseVerifyFixture,
  type PyricVerifyFixture,
  type VerifyDivergence,
} from '../../../cli/dist/verify/index.js';
import { openStorageBackend } from '../../../pyric/dist/storage/persistence.js';
import { CASCADE_BINDINGS_AUTH_RULES } from '../../probes/rtdb/rtdb-rules-cascade-bindings-and-auth-context.ts';
import { DATA_NEWDATA_SNAPSHOT_RULES } from '../../probes/rtdb/rtdb-rules-data-newdata-and-snapshot-methods.ts';
import { DEFAULT_DENY_AND_RUNTIME_ERROR_RULES } from '../../probes/rtdb/rtdb-rules-default-deny-and-runtime-errors.ts';
import { scenario as r28PresenceScenario } from '../../rules-corpus/rtdb/r28-stdlib-presence-timing.ts';
import { scenario as r30QueryScenario } from '../../rules-corpus/rtdb/r30-query-rules.ts';

interface AllowedFlagVerdict {
  allowed: boolean;
  permissionDenied: boolean;
}

interface CascadeAuthObservation {
  projectId: string;
  behavior: {
    ancestorCascadeOverridesChildFalse: Record<string, AllowedFlagVerdict>;
    pathVariableBindings: Record<string, AllowedFlagVerdict>;
    authNullVsBoundToken: Record<string, AllowedFlagVerdict>;
  };
}

interface RulesCorpusObservation {
  projectId: string;
  behavior: Record<string, 'ALLOW' | 'DENY'>;
}

interface QueryIndexCaseResult {
  get: { timing: string; keys?: string[]; message?: string };
  listen: { event: string; keys: string[] };
  listenLogs: string[];
}

interface QueryIndexObservation {
  projectId: string;
  behavior: {
    results: Record<string, QueryIndexCaseResult>;
  };
}

interface DataNewDataObservation {
  projectId: string;
  behavior: {
    createOnceLifecycle: Record<string, AllowedFlagVerdict>;
    monotonicDataVsNewData: Record<string, AllowedFlagVerdict>;
    parentAndChildNavigation: Record<string, AllowedFlagVerdict>;
  };
}

interface DefaultDenyObservation {
  projectId: string;
  behavior: {
    explicitFalseAncestorWithChildValidateOrOppositeOp: Record<string, AllowedFlagVerdict>;
    defaultDenyWhenNoRuleForOperationExists: Record<string, AllowedFlagVerdict>;
    runtimeTypeErrorsFailClosedAsVerdicts: Record<string, AllowedFlagVerdict>;
  };
}

interface MultiPathUpdateObservation {
  projectId: string;
  behavior: {
    multiPathAtomicPartialDenialRollback: {
      rejected: boolean;
      errorCode: string;
      allowedBranchUnchanged: Record<string, number>;
      deniedBranchUnchanged: Record<string, number>;
    };
  };
}

interface OnDisconnectRulesObservation {
  projectId: string;
  behavior: {
    registrationDenied: { resolved: boolean; error: { code: string } };
    registeredWhileAllowed: { resolved: boolean };
  };
}

interface OnDisconnectOperationsObservation {
  projectId: string;
  behavior: {
    outcomes: {
      set: Record<string, boolean>;
      update: Record<string, unknown>;
      remove: null;
      setWithPriority: { '.priority': number; after: boolean };
    };
  };
}

const OBS_ROOT = join(import.meta.dir, '..', '..', 'observations');

function readObs<T>(subpath: string): T {
  return JSON.parse(readFileSync(join(OBS_ROOT, subpath), 'utf8')) as T;
}

export const cascadeAuthObs = readObs<CascadeAuthObservation>(
  'rtdb/rtdb-rules-cascade-bindings-and-auth-context.json',
);
export const queryRulesObs = readObs<RulesCorpusObservation>(
  'rtdb-rules/rules-rtdb-r30-query-rules.json',
);
export const queryIndexObs = readObs<QueryIndexObservation>(
  'rtdb-modular/rtdb-modular-query-index-enforcement.json',
);
export const dataNewDataObs = readObs<DataNewDataObservation>(
  'rtdb/rtdb-rules-data-newdata-and-snapshot-methods.json',
);
export const defaultDenyObs = readObs<DefaultDenyObservation>(
  'rtdb/rtdb-rules-default-deny-and-runtime-errors.json',
);
export const multiPathUpdateObs = readObs<MultiPathUpdateObservation>(
  'rtdb-modular/rtdb-modular-multipath-update-and-write-order.json',
);
export const onDisconnectRulesObs = readObs<OnDisconnectRulesObservation>(
  'rtdb-modular/rtdb-modular-ondisconnect-rules.json',
);
export const onDisconnectOpsObs = readObs<OnDisconnectOperationsObservation>(
  'rtdb-modular/rtdb-modular-ondisconnect-operations-cancel.json',
);
export const presenceTimingObs = readObs<RulesCorpusObservation>(
  'rtdb-rules/rules-rtdb-r28-stdlib-presence-timing.json',
);

export const R30_QUERY_RULES = JSON.parse(r30QueryScenario.rules) as Record<string, unknown>;
export const R28_PRESENCE_RULES = JSON.parse(r28PresenceScenario.rules) as Record<string, unknown>;
export {
  CASCADE_BINDINGS_AUTH_RULES,
  DATA_NEWDATA_SNAPSHOT_RULES,
  DEFAULT_DENY_AND_RUNTIME_ERROR_RULES,
};

export const PROJECT_ID = cascadeAuthObs.projectId;
export const DEFAULT_INSTANCE = `${PROJECT_ID}-default-rtdb`;
export const ALLOW_ALL_RULES = { rules: { '.read': true, '.write': true } };
export const LOCKED_RULES = { rules: { '.read': false, '.write': false } };
export const ALICE_ANON_LENS: AuthLens = {
  mode: 'as',
  uid: 'alice',
  token: { firebase: { sign_in_provider: 'anonymous' } },
};

export function divergenceSummary(divergences: VerifyDivergence[] | undefined): string[] {
  const list = divergences ?? [];
  return list.map((d) => {
    if ('method' in d && typeof d.method === 'string') {
      return `${d.kind}:${d.method}`;
    }
    return d.kind;
  });
}

const OWNERSHIP_MARKER = '.pyric-verify-replay-owned';
const tempRoot = realpathSync(tmpdir());
const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

export function registerVerifyReplayCleanupHooks(): void {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    for (const dir of tempDirs.splice(0)) {
      if (
        existsSync(dir) &&
        !lstatSync(dir).isSymbolicLink() &&
        realpathSync(dir).startsWith(`${tempRoot}/`) &&
        existsSync(join(dir, OWNERSHIP_MARKER))
      ) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

export function onVerifyTestCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

export function makeVerifyProjectDir(
  prefix: string,
  defaultRules: { rules: Record<string, unknown> },
): string {
  const dir = realpathSync(mkdtempSync(join(tempRoot, prefix)));
  tempDirs.push(dir);
  writeFileSync(join(dir, OWNERSHIP_MARKER), '1');
  writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(defaultRules));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  writeFileSync(
    join(dir, 'firebase.json'),
    JSON.stringify({ database: { rules: 'database.rules.json' } }),
  );
  return dir;
}

export function toWireQuery(builtQuery: Query): RtdbWireQuerySpec {
  const spec = builtQuery._spec;
  let limit: RtdbWireQuerySpec['limit'] = null;
  if (spec.limit !== null) {
    let count: number | null = null;
    if (Number.isFinite(spec.limit.n)) {
      count = spec.limit.n;
    }
    limit = { kind: spec.limit.kind, n: count };
  }
  return {
    orderBy: spec.orderBy,
    bounds: spec.bounds,
    limit,
  };
}

export async function outcomeAllowed(op: Promise<unknown>): Promise<boolean> {
  try {
    await op;
    return true;
  } catch (err) {
    expect(String(err)).toMatch(/PERMISSION_DENIED/i);
    return false;
  }
}

interface RtdbSubResult {
  allowed: boolean;
  warning: string | null;
  unsubscribe: () => void;
}

export async function openSharedWorkerCapture(databaseRules: { rules: Record<string, unknown> }) {
  const workerBox = initializeSandbox({ projectId: PROJECT_ID });
  onVerifyTestCleanup(() => workerBox.dispose());
  await workerBox.enablePersistence({
    key: `vr-worker-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  const ctx: HostCtx = {
    db: getFirestore(workerBox),
    sandbox: workerBox,
    instanceId: 'vr-worker',
    subs: new Map(),
    defaultRtdbInstance: DEFAULT_INSTANCE,
  };
  const postedBodies: string[] = [];
  const initHandle = applyServeInit(
    ctx,
    {
      rules: null,
      rulesHash: null,
      databaseRules,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: DEFAULT_INSTANCE,
        rules: { [DEFAULT_INSTANCE]: databaseRules },
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: true,
    },
    {
      captureDebounceMs: 5,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body === 'string') {
          postedBodies.push(init.body);
        }
        return new Response('ok', { status: 200 });
      }) as typeof fetch,
    },
  );
  onVerifyTestCleanup(() => initHandle.dispose());

  const listeners = new Set<(out: OutboundMessage) => void>();
  const port: PortLike = {
    postMessage(out: OutboundMessage) {
      for (const listener of listeners) {
        listener(out);
      }
    },
  };
  let seq = 0;

  const sendOp = (msg: Record<string, unknown>): Promise<ResMessage> => {
    seq += 1;
    const id = `vr-w-op-${seq}`;
    return new Promise<ResMessage>((resolve) => {
      const handler = (out: OutboundMessage) => {
        if (out.t === 'res' && out.id === id) {
          listeners.delete(handler);
          resolve(out);
        }
      };
      listeners.add(handler);
      void handleMessage(ctx, port, { t: 'op', id, ...msg } as InboundMessage);
    });
  };

  const subscribeRtdb = (opts: {
    path: string;
    query?: RtdbWireQuerySpec;
    event?: 'value' | 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';
    actAs?: AuthLens;
  }): Promise<RtdbSubResult> => {
    seq += 1;
    const subId = `vr-w-sub-${seq}`;
    return new Promise<RtdbSubResult>((resolve) => {
      const handler = (out: OutboundMessage) => {
        if (out.t === 'snap' && out.subId === subId) {
          listeners.delete(handler);
          const snapVal = (out as SnapMessage).value as Record<string, unknown>;
          const allowed = !('__error' in snapVal);
          let warning: string | null = null;
          if (typeof snapVal.warning === 'string') {
            warning = snapVal.warning;
          }
          resolve({
            allowed,
            warning,
            unsubscribe: () => {
              void handleMessage(ctx, port, { t: 'unsub', subId });
            },
          });
        }
      };
      listeners.add(handler);
      void handleMessage(ctx, port, {
        t: 'sub',
        subId,
        target: {
          service: 'rtdb',
          instance: undefined,
          path: opts.path,
          query: opts.query,
          event: opts.event,
        },
        actAs: opts.actAs,
      });
    });
  };

  const flushFixture = async (): Promise<PyricVerifyFixture> => {
    await ctx.captureFlush?.();
    const rawBody = postedBodies.at(-1);
    if (typeof rawBody !== 'string') {
      throw new Error('Expected SharedWorker capture post');
    }
    const parsed: unknown = JSON.parse(rawBody);
    return parseVerifyFixture(parsed);
  };

  return { sendOp, subscribeRtdb, flushFixture };
}

export async function openHostedCaptureSession(
  dir: string,
  databaseRules: { rules: Record<string, unknown> },
) {
  const listeners = new Set<(out: OutboundMessage) => void>();
  const persistence = {
    backend: createMemoryBackend(),
    storage: await openStorageBackend(`mem-vr-${Math.random()}`),
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
  const captureStore = createCaptureStore(dir);
  let capturedPosts = 0;
  const captureServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/__pyric/capture') {
        captureStore.write(await req.text());
        capturedPosts += 1;
        return new Response('ok', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  cleanups.push(() => {
    captureServer.stop(true);
  });

  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: DEFAULT_INSTANCE,
        rules: { [DEFAULT_INSTANCE]: databaseRules },
        projectId: PROJECT_ID,
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: true,
      hosted: true,
      projectKey: dir,
    },
    `http://127.0.0.1:${captureServer.port}`,
    (frame: BridgeMessage) => {
      if (frame.type === 'worker-message-result') {
        for (const listener of listeners) {
          listener(frame.message);
        }
      }
    },
    dir,
    { persistence: persistence as never, record: false },
  );
  let closed = false;
  cleanups.push(async () => {
    if (!closed) {
      closed = true;
      await runtime.close();
    }
  });

  let seq = 0;
  const sendOp = (msg: Record<string, unknown>): Promise<ResMessage> => {
    seq += 1;
    const id = `vr-h-op-${seq}`;
    return new Promise<ResMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Hosted op ${id} timed out`)), 4_000);
      const handler = (out: OutboundMessage) => {
        if (out.t === 'res' && out.id === id) {
          clearTimeout(timer);
          listeners.delete(handler);
          resolve(out);
        }
      };
      listeners.add(handler);
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'vr-client',
        message: { t: 'op', id, ...msg } as InboundMessage,
      });
    });
  };

  const subscribeRtdb = (opts: {
    path: string;
    query?: RtdbWireQuerySpec;
    event?: 'value' | 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';
    actAs?: AuthLens;
  }): Promise<RtdbSubResult> => {
    seq += 1;
    const subId = `vr-h-sub-${seq}`;
    return new Promise<RtdbSubResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Hosted sub ${subId} timed out`)), 4_000);
      const handler = (out: OutboundMessage) => {
        if (out.t === 'snap' && out.subId === subId) {
          clearTimeout(timer);
          listeners.delete(handler);
          const snapVal = (out as SnapMessage).value as Record<string, unknown>;
          const allowed = !('__error' in snapVal);
          let warning: string | null = null;
          if (typeof snapVal.warning === 'string') {
            warning = snapVal.warning;
          }
          resolve({
            allowed,
            warning,
            unsubscribe: () => {
              runtime.receive({
                type: 'worker-message',
                clientSessionId: 'vr-client',
                message: { t: 'unsub', subId },
              });
            },
          });
        }
      };
      listeners.add(handler);
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'vr-client',
        message: {
          t: 'sub',
          subId,
          target: {
            service: 'rtdb',
            instance: undefined,
            path: opts.path,
            query: opts.query,
            event: opts.event,
          },
          actAs: opts.actAs,
        },
      });
    });
  };

  const closeAndGetSessionPath = async (): Promise<string> => {
    const countAtEndOfOps = capturedPosts;
    const deadline = Date.now() + 3_000;
    while (capturedPosts === countAtEndOfOps && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(capturedPosts).toBeGreaterThan(0);
    closed = true;
    await runtime.close();
    return join(dir, '.pyric', 'last-session.json');
  };

  const runCliVerify = async (sessionPath: string, extraArgv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const code = await runVerify(parseArgs(['verify', sessionPath, ...extraArgv]));
      return { code, out: out.join(''), err: err.join('') };
    } finally {
      process.chdir(prevCwd);
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  };

  return { sendOp, subscribeRtdb, closeAndGetSessionPath, runCliVerify };
}
