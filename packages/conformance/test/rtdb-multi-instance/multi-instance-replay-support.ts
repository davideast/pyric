import 'fake-indexeddb/auto';
import { afterEach, expect } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBackend } from 'pyric/sandbox';
import { openStorageBackend } from '../../../pyric/dist/storage/persistence.js';
import type { BridgeMessage } from '../../../cli/dist/bridge/protocol.js';
import { createCaptureStore } from '../../../cli/dist/serve/capture-store.js';
import { createHostedRuntime } from '../../../cli/dist/serve/hosted/runtime.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../cli/dist/serve/worker/protocol.js';

export interface MultiInstanceObservation {
  rowIds: string[];
  projectId: string;
  behavior: {
    rules: {
      default: Record<string, unknown>;
      second: Record<string, unknown>;
    };
    signedOut: {
      defaultWrite: 'ALLOW' | 'DENY';
      secondWrite: 'ALLOW' | 'DENY';
    };
    isolation: {
      secondWriteReadOnSecond: string;
      secondWriteReadOnDefault: null;
    };
    signedIn: {
      defaultWrite: 'ALLOW' | 'DENY';
      secondOwnUserPath: 'ALLOW' | 'DENY';
      secondOtherUserPath: 'ALLOW' | 'DENY';
      secondPathWithoutRules: 'ALLOW' | 'DENY';
      defaultReadOfSecondOnlyPath: 'ALLOW' | 'DENY';
    };
    isolationAfterBothWrites: {
      defaultHolds: string;
      secondHolds: string;
      secondUserPathOnDefault: null;
    };
  };
}

export interface UrlInstanceSuccess {
  name: string;
  url: string;
}

export interface UrlInstanceFailure {
  error: string;
  errorClass: string;
}

export type UrlInstanceOutcome = UrlInstanceSuccess | UrlInstanceFailure;

export interface UrlInstanceObservation {
  rowIds: string[];
  projectId: string;
  behavior: {
    urls: Record<string, UrlInstanceOutcome>;
    projectDefault: {
      name: string;
      url: string;
      nameIsProjectIdDefaultRtdb: boolean;
    };
  };
}

export function isUrlFailure(entry: UrlInstanceOutcome): entry is UrlInstanceFailure {
  return 'error' in entry;
}

const OBSERVATIONS_DIR = join(import.meta.dir, '..', '..', 'observations', 'rtdb-modular');

export const multiObs = JSON.parse(
  readFileSync(join(OBSERVATIONS_DIR, 'rtdb-modular-multiple-instances.json'), 'utf8'),
) as MultiInstanceObservation;

export const urlObs = JSON.parse(
  readFileSync(join(OBSERVATIONS_DIR, 'rtdb-modular-database-url-instance.json'), 'utf8'),
) as UrlInstanceObservation;

export const DEFAULT_RULES = { rules: multiObs.behavior.rules.default };
export const SECOND_RULES = { rules: multiObs.behavior.rules.second };
export const LOCKED_RULES = { rules: { '.read': false, '.write': false } };
export const PROJECT_ID = urlObs.projectId;
export const DEFAULT_INSTANCE = urlObs.behavior.projectDefault.name;
export const NAMED_INSTANCE = 'my-instance';

const tempRoot = realpathSync(tmpdir());
const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

export function registerMultiInstanceCleanupHooks(): void {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    for (const dir of tempDirs.splice(0)) {
      if (dir.startsWith(tempRoot)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

export function onTestCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

export function makeTempProjectDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tempRoot, prefix)));
  tempDirs.push(dir);
  return dir;
}

export async function outcomeOf(op: Promise<unknown>): Promise<'ALLOW' | 'DENY'> {
  try {
    await op;
    return 'ALLOW';
  } catch (err) {
    expect(String(err)).toMatch(/PERMISSION_DENIED/i);
    return 'DENY';
  }
}

export async function openHostedMultiInstance(
  dir: string,
  databaseInstances: { defaultInstance: string; rules: Record<string, { rules: Record<string, unknown> } | null> },
  captureSession: boolean,
) {
  let onReply: (res: OutboundMessage) => void = () => {};
  const persistence = {
    backend: createMemoryBackend(),
    storage: await openStorageBackend(`mem-mi-${Math.random()}`),
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
  let baseUrl = 'http://127.0.0.1:4410';
  let capturedPosts = 0;
  if (captureSession) {
    const captureStore = createCaptureStore(dir);
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
    baseUrl = `http://127.0.0.1:${captureServer.port}`;
  }
  const defaultRules = databaseInstances.rules[databaseInstances.defaultInstance] ?? null;
  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules: defaultRules,
      databaseRulesHash: null,
      databaseInstances: { ...databaseInstances, projectId: PROJECT_ID },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: captureSession,
      hosted: true,
      projectKey: dir,
    },
    baseUrl,
    (frame: BridgeMessage) => {
      if (frame.type === 'worker-message-result') {
        onReply(frame.message);
      }
    },
    dir,
    { persistence: persistence as never, record: false },
  );
  let seq = 0;
  const request = (msg: Record<string, unknown>): Promise<ResMessage> => {
    seq += 1;
    const id = `mi-op-${seq}`;
    return new Promise<ResMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Hosted op ${id} timed out`)), 4_000);
      onReply = (response) => {
        if (response.t === 'res' && response.id === id) {
          clearTimeout(timer);
          resolve(response);
        }
      };
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'mi-client',
        message: { t: 'op', id, ...msg } as InboundMessage,
      });
    });
  };
  const waitForCaptureFlush = async (): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (capturedPosts === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { runtime, request, waitForCaptureFlush };
}
