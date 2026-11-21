import { createMemoryBackend } from 'pyric/sandbox';
import type {
  BridgeMessage,
  WorkerOpFrame,
  WorkerResFrame,
} from '../../../cli/dist/bridge/protocol.js';
import { createHostedRuntime } from '../../../cli/dist/serve/hosted/runtime.js';
import { REPO_ROOT } from '../../src/ledger.ts';

export interface HostedBridgeHarness {
  readonly projectId: string;
  sendOp(op: Record<string, unknown>): Promise<WorkerResFrame>;
  close(): Promise<void>;
}

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

export async function openHostedKotlinAuthBridge(projectId: string): Promise<HostedBridgeHarness> {
  const pendingReplies = new Map<string, (frame: WorkerResFrame) => void>();
  const persistence = makeInMemoryHostedPersistence();
  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules: null,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: `${projectId}-default-rtdb`,
        projectId,
        rules: {},
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: true,
      projectKey: projectId,
      sessionToken: `tok-${projectId}`,
    },
    'http://127.0.0.1:4400',
    (frame: BridgeMessage) => {
      if (frame.type === 'worker-res') {
        const resolver = pendingReplies.get(frame.id);
        if (resolver !== undefined) {
          pendingReplies.delete(frame.id);
          resolver(frame);
        }
      }
    },
    REPO_ROOT,
    { persistence: persistence as never, record: false },
  );

  let seq = 0;
  return {
    projectId,
    sendOp(op: Record<string, unknown>): Promise<WorkerResFrame> {
      seq += 1;
      const id = `kt-auth-oracle-${seq}`;
      return new Promise<WorkerResFrame>((resolveReply, rejectReply) => {
        const timer = setTimeout(() => {
          pendingReplies.delete(id);
          rejectReply(new Error(`Hosted worker-op '${id}' timed out`));
        }, 5_000);
        pendingReplies.set(id, (frame) => {
          clearTimeout(timer);
          resolveReply(frame);
        });
        runtime.receive({
          type: 'worker-op',
          id,
          clientSessionId: 'kt-oracle-replay-client',
          op: op as unknown as WorkerOpFrame['op'],
        });
      });
    },
    async close(): Promise<void> {
      await runtime.close();
    },
  };
}
