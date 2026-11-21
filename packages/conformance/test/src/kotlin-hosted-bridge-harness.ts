import { createMemoryBackend } from 'pyric/sandbox';
import type {
  BridgeMessage,
  WorkerOpFrame,
  WorkerResFrame,
  WorkerSubFrame,
} from '../../../cli/dist/bridge/protocol.js';
import { createHostedRuntime } from '../../../cli/dist/serve/hosted/runtime.js';
import { REPO_ROOT } from '../../src/ledger.ts';

export interface HostedKotlinBridgeOptions {
  readonly projectId: string;
  readonly permissive?: boolean;
  readonly databaseRules?: { rules: Record<string, unknown> } | null;
  readonly databaseRulesByInstance?: Record<string, { rules: Record<string, unknown> }>;
}

export interface HostedKotlinBridgeHarness {
  readonly projectId: string;
  sendOp(op: Record<string, unknown>): Promise<WorkerResFrame>;
  subscribe(subId: string, sub: Record<string, unknown>, onSnap: (value: unknown) => void): void;
  unsubscribe(subId: string): void;
  close(): Promise<void>;
}

const CLIENT_SESSION_ID = 'kt-oracle-replay-client';

function makeInMemoryHostedPersistence() {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
}

export async function openHostedKotlinBridge(
  options: HostedKotlinBridgeOptions,
): Promise<HostedKotlinBridgeHarness> {
  const pendingReplies = new Map<string, (frame: WorkerResFrame) => void>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const subListeners = new Map<string, (value: unknown) => void>();
  const persistence = makeInMemoryHostedPersistence();

  let permissive = true;
  if (options.permissive !== undefined) {
    permissive = options.permissive;
  }
  let databaseRules: { rules: Record<string, unknown> } | null = null;
  if (options.databaseRules !== undefined) {
    databaseRules = options.databaseRules;
  }
  let rulesByInstance: Record<string, { rules: Record<string, unknown> }> = {};
  if (options.databaseRulesByInstance !== undefined) {
    rulesByInstance = options.databaseRulesByInstance;
  }

  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: `${options.projectId}-default-rtdb`,
        projectId: options.projectId,
        rules: rulesByInstance,
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive,
      projectKey: options.projectId,
      sessionToken: `tok-${options.projectId}`,
    },
    'http://127.0.0.1:4400',
    (frame: BridgeMessage) => {
      if (frame.type === 'worker-res') {
        const resolver = pendingReplies.get(frame.id);
        if (resolver !== undefined) {
          pendingReplies.delete(frame.id);
          resolver(frame);
        }
      } else if (frame.type === 'worker-snap') {
        const listener = subListeners.get(frame.subId);
        if (listener !== undefined) {
          listener(frame.value);
        }
      }
    },
    REPO_ROOT,
    { persistence: persistence as never, record: false },
  );

  let seq = 0;
  return {
    projectId: options.projectId,
    sendOp(op: Record<string, unknown>): Promise<WorkerResFrame> {
      seq += 1;
      const id = `kt-oracle-${seq}`;
      return new Promise<WorkerResFrame>((resolveReply, rejectReply) => {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          pendingReplies.delete(id);
          rejectReply(new Error(`Hosted worker-op '${id}' timed out`));
        }, 5_000);
        pendingTimers.add(timer);
        pendingReplies.set(id, (frame) => {
          clearTimeout(timer);
          pendingTimers.delete(timer);
          resolveReply(frame);
        });
        runtime.receive({
          type: 'worker-op',
          id,
          clientSessionId: CLIENT_SESSION_ID,
          op: op as unknown as WorkerOpFrame['op'],
        });
      });
    },
    subscribe(subId: string, sub: Record<string, unknown>, onSnap: (value: unknown) => void): void {
      subListeners.set(subId, onSnap);
      runtime.receive({
        type: 'worker-sub',
        subId,
        clientSessionId: CLIENT_SESSION_ID,
        sub: sub as unknown as WorkerSubFrame['sub'],
      });
    },
    unsubscribe(subId: string): void {
      subListeners.delete(subId);
      runtime.receive({
        type: 'worker-unsub',
        subId,
        clientSessionId: CLIENT_SESSION_ID,
      });
    },
    async close(): Promise<void> {
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      pendingReplies.clear();
      subListeners.clear();
      await runtime.close();
    },
  };
}
