import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getFirestore } from 'pyric/firestore';
import { getDatabase, sandbox as databaseSandbox } from 'pyric/database';
import { handleMessage, type HostCtx } from '../../packages/cli/src/serve/worker/host.ts';

const sandbox = initializeSandbox();
setRules(sandbox, "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /messages/{id} { allow read: if true; allow write: if request.resource.data.version >= 0; } } }");
databaseSandbox.setDefaultPolicy(getDatabase(sandbox), 'allow');
const ready = sandbox.enablePersistence({ key: 'sdk-flow-demo', injectedBackend: createMemoryBackend() });
const context: HostCtx = {
  sandbox, db: getFirestore(sandbox), subs: new Map(), instanceId: 'sdk-flow-demo',
  sessionMode: 'LOCAL', sessionBackend: createMemoryBackend(),
};
const worker = globalThis as unknown as { onconnect: (event: MessageEvent) => void };
worker.onconnect = (event) => {
  const port = event.ports[0]!;
  port.onmessage = async (message) => {
    await ready;
    await handleMessage(context, port, message.data);
  };
  port.start();
};
