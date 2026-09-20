import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { cleanupPort, handleMessage } from '../../../../src/serve/worker/host/dispatch.js';
import type { HostCtx, PortLike } from '../../../../src/serve/worker/host-context.js';
import type { OpMessage, OutboundMessage, SubMessage } from '../../../../src/serve/worker/protocol.js';
import { exportStateBundle } from '../../../../src/serve/worker/host/state-transfer.js';
import { allowWorkerServicesForTransportTests } from '../permissive-services.js';

const rules = `rules_version = '2'; service cloud.firestore {
  match /databases/{db}/documents { match /{path=**} { allow read, write: if true; } }
}`;
const actions = ['restore', 'checkpoint import', 'resetAll'] as const;
const services = ['firestore', 'rtdb'] as const;
const lenses = ['page', 'studio'] as const;

for (const action of actions) {
  for (const service of services) {
    for (const lens of lenses) {
      test(`${action} delivers once to a ${service} ${lens} listener and leaves it live`, async () => {
        const sandbox = initializeSandbox();
        allowWorkerServicesForTransportTests(sandbox, `restore-deliveries-${crypto.randomUUID()}`);
        await sandbox.enablePersistence({ key: crypto.randomUUID(), injectedBackend: createMemoryBackend() });
        const ctx: HostCtx = { sandbox, db: getFirestore(sandbox), subs: new Map(),
          instanceId: 'restore-test', sessionBackend: createMemoryBackend() };
        const messages: OutboundMessage[] = [];
        const port: PortLike = { postMessage: message => { messages.push(message); } };
        const isFirestore = service === 'firestore';
        const isStudio = lens === 'studio';
        const isReset = action === 'resetAll';
        const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
        const deliveries = () => messages.filter(message => message.t === 'snap').map(message => message.value);
        async function request(message: OpMessage) {
          const start = messages.length;
          await handleMessage(ctx, port, message);
          const response = messages.slice(start).find(reply => reply.t === 'res');
          expect(response).toMatchObject({ t: 'res', ok: true });
          await tick();
        }
        async function write(value: number) {
          const message: OpMessage = isFirestore
            ? { t: 'op', id: 'write', method: 'setDoc', path: 'items/shared', data: { value }, actAs: { mode: 'admin' } }
            : { t: 'op', id: 'write', method: 'rtdb.set', path: '/items/shared', value, actAs: { mode: 'admin' } };
          await request(message);
        }
        function expectValue(value: number | null) {
          const snapshots = deliveries();
          expect(snapshots).toHaveLength(1);
          const isEmpty = value === null;
          if (isFirestore) {
            const expected = isEmpty ? { exists: false } : { exists: true, data: { json: JSON.stringify({ value }) } };
            expect(snapshots[0]).toMatchObject(expected);
          } else {
            expect(snapshots[0]).toMatchObject({ value, exists: !isEmpty });
          }
        }
        try {
          await request({ t: 'op', id: 'rules', method: 'setRules', source: rules });
          await write(1);
          await request({ t: 'op', id: 'save', method: 'checkpoint', name: 'saved' });
          const bundle = await exportStateBundle(sandbox);
          await write(2);
          const subscription: SubMessage = {
            t: 'sub', subId: 'watch',
            target: isFirestore ? { __ref: 'doc', path: 'items/shared' } : { service: 'rtdb', path: '/items/shared' },
            ...(isStudio ? { issuer: 'studio', actAs: { mode: 'admin' } } as const : {}),
          };
          await handleMessage(ctx, port, subscription);
          await tick();
          expectValue(2);
          messages.length = 0;
          switch (action) {
            case 'restore': await request({ t: 'op', id: 'state', method: 'restore', name: 'saved' }); break;
            case 'checkpoint import': await request({ t: 'op', id: 'state', method: 'importState', bundle }); break;
            case 'resetAll': await request({ t: 'op', id: 'state', method: 'resetAll' }); break;
          }
          expectValue(isReset ? null : 1);
          messages.length = 0;
          await write(3);
          expectValue(3);
        } finally {
          await cleanupPort(ctx, port);
          sandbox.dispose();
        }
      });
    }
  }
}
