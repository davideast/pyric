import type { Page } from '@playwright/test';
import type { OpMessage } from '../../../src/serve/worker/protocol.js';

interface OperationShape { values: Record<string, unknown>; invalid: Record<string, unknown> }

// Required argument inventory, frozen to the protocol's 94 method literals.
// Empty rows have no required method payload; shared envelope checks cover them.
export const operationShapes: Record<OpMessage['method'], OperationShape> = {
  "getDoc": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "getDocs": { values: {"source": {"__ref": "collection", "path": "protocol-invalid"}}, invalid: {"source": 7} },
  "setDoc": { values: {"path": "protocol-invalid/document", "data": {}}, invalid: {"path": 7, "data": []} },
  "updateDoc": { values: {"path": "protocol-invalid/document", "data": {}}, invalid: {"path": 7, "data": []} },
  "deleteDoc": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "addDoc": { values: {"collectionPath": "protocol-invalid", "data": {}}, invalid: {"collectionPath": 7, "data": []} },
  "count": { values: {"source": {"__ref": "collection", "path": "protocol-invalid"}}, invalid: {"source": 7} },
  "aggregate": { values: {"source": {"__ref": "collection", "path": "protocol-invalid"}, "spec": {"n": {"kind": "count"}}}, invalid: {"source": 7, "spec": []} },
  "batchCommit": { values: {"writes": []}, invalid: {"writes": 7} },
  "txnCommit": { values: {"reads": [], "writes": []}, invalid: {"reads": 7, "writes": 7} },
  "setRules": { values: {"source": "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if request.auth != null; } } }"}, invalid: {"source": 7} },
  "setFirestoreRules": { values: {"source": "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if request.auth != null; } } }"}, invalid: {"source": 7} },
  "setDatabaseRules": { values: {"source": {"rules": {".read": false, ".write": false}}}, invalid: {"source": 7} },
  "getActiveRules": { values: {}, invalid: {} },
  "getRulesStatus": { values: {}, invalid: {} },
  "admin.getDocument": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "admin.listDocuments": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "admin.setDocument": { values: {"path": "protocol-invalid/document", "data": {}}, invalid: {"path": 7, "data": []} },
  "admin.deleteDocument": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "admin.readState": { values: {}, invalid: {} },
  "rtdb.get": { values: {"path": "protocol-invalid"}, invalid: {"path": 7} },
  "rtdb.set": { values: {"path": "protocol-invalid", "value": null}, invalid: {"path": 7} },
  "rtdb.setPriority": { values: {"path": "protocol-invalid", "priority": null}, invalid: {"path": 7, "priority": {}} },
  "rtdb.setWithPriority": { values: {"path": "protocol-invalid", "value": null, "priority": null}, invalid: {"path": 7, "priority": {}} },
  "rtdb.update": { values: {"path": "protocol-invalid", "values": {}}, invalid: {"path": 7, "values": []} },
  "rtdb.remove": { values: {"path": "protocol-invalid"}, invalid: {"path": 7} },
  "rtdb.push": { values: {"path": "protocol-invalid"}, invalid: {"path": 7} },
  "sandbox.clock": { values: {}, invalid: {} },
  "rtdb.adminSnapshot": { values: {}, invalid: {} },
  "rtdb.onDisconnectSet": { values: {"path": "protocol-invalid", "value": null}, invalid: {"path": 7} },
  "rtdb.onDisconnectUpdate": { values: {"path": "protocol-invalid", "values": {}}, invalid: {"path": 7, "values": []} },
  "rtdb.onDisconnectRemove": { values: {"path": "protocol-invalid"}, invalid: {"path": 7} },
  "rtdb.onDisconnectCancel": { values: {"path": "protocol-invalid"}, invalid: {"path": 7} },
  "rtdb.goOffline": { values: {}, invalid: {} },
  "rtdb.goOnline": { values: {}, invalid: {} },
  "rtdb.transactionCommit": { values: {"path": "protocol-invalid", "expected": null, "value": null}, invalid: {"path": 7} },
  "listRootCollections": { values: {}, invalid: {} },
  "listSubcollections": { values: {"docPath": "protocol-invalid/document"}, invalid: {"docPath": 7} },
  "auth.createUser": { values: {"email": "protocol-invalid@example.test", "password": "password-123"}, invalid: {"email": 7, "password": 7} },
  "auth.signInEmail": { values: {"email": "protocol-invalid@example.test", "password": "password-123"}, invalid: {"email": 7, "password": 7} },
  "auth.signInAnonymously": { values: {}, invalid: {} },
  "auth.signOut": { values: {}, invalid: {} },
  "auth.getIdToken": { values: {}, invalid: {} },
  "auth.getIdTokenResult": { values: {}, invalid: {} },
  "auth.setPersistence": { values: {"mode": "NONE"}, invalid: {"mode": 7} },
  "auth.getCurrentUser": { values: {}, invalid: {} },
  "auth.updateProfile": { values: {}, invalid: {} },
  "auth.setTenantId": { values: {"tenantId": null}, invalid: {"tenantId": 7} },
  "auth.reload": { values: {}, invalid: {} },
  "auth.deleteUser": { values: {}, invalid: {} },
  "auth.updateEmail": { values: {"newEmail": "protocol-invalid@example.test"}, invalid: {"newEmail": 7} },
  "auth.updatePassword": { values: {"newPassword": "password-123"}, invalid: {"newPassword": 7} },
  "auth.updateCurrentUser": { values: {"uid": null}, invalid: {"uid": 7} },
  "auth.signInWithCredential": { values: {"credential": {"providerId": "google.com", "uid": "protocol-invalid"}}, invalid: {"credential": []} },
  "auth.restorePortSession": { values: {"uid": "protocol-invalid"}, invalid: {"uid": 7} },
  "auth.acceptIdentity": { values: {"identity": {"uid": "protocol-invalid", "providerId": "google.com", "email": null, "displayName": null, "photoURL": null, "customClaims": {}}}, invalid: {"identity": []} },
  "auth.listUsers": { values: {}, invalid: {} },
  "auth.adminCreateUser": { values: {"request": {"uid": "protocol-invalid"}}, invalid: {"request": []} },
  "auth.adminUpdateUser": { values: {"uid": "protocol-invalid", "request": {}}, invalid: {"uid": 7, "request": []} },
  "auth.adminDeleteUser": { values: {"uid": "protocol-invalid"}, invalid: {"uid": 7} },
  "auth.adminClearUsers": { values: {}, invalid: {} },
  "auth.getProviderConfig": { values: {}, invalid: {} },
  "auth.setProviderConfig": { values: {"providerId": "google.com", "enabled": true}, invalid: {"providerId": 7, "enabled": 7} },
  "storage.listAll": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "storage.getMetadata": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "storage.getBlob": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "storage.putBytes": { values: {"path": "protocol-invalid/blob", "dataB64": ""}, invalid: {"path": 7, "dataB64": 7} },
  "storage.getBytes": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "storage.deleteObject": { values: {"path": "protocol-invalid/document"}, invalid: {"path": 7} },
  "ai.generateContent": { values: {"model": "local", "request": {"contents": [{"role": "user", "parts": [{"text": "hello"}]}]}}, invalid: {"model": 7, "request": []} },
  "ai.countTokens": { values: {"model": "local", "request": {"contents": [{"role": "user", "parts": [{"text": "hello"}]}]}}, invalid: {"model": 7, "request": []} },
  "getRuntimeEpoch": { values: {}, invalid: {} },
  "retireRuntime": { values: {"targetEpoch": "not-the-current-epoch"}, invalid: {"targetEpoch": 7} },
  "getVersion": { values: {}, invalid: {} },
  "exportState": { values: {}, invalid: {} },
  "importState": { values: {"bundle": "not-a-state-bundle"}, invalid: {"bundle": 7} },
  "checkpoint": { values: {"name": "protocol-invalid"}, invalid: {"name": 7} },
  "listCheckpoints": { values: {}, invalid: {} },
  "restore": { values: {"name": "protocol-invalid"}, invalid: {"name": 7} },
  "deleteCheckpoint": { values: {"name": "protocol-invalid"}, invalid: {"name": 7} },
  "getSnapshot": { values: {}, invalid: {} },
  "resetAll": { values: {}, invalid: {} },
  "messaging.getToken": { values: {}, invalid: {} },
  "messaging.deleteToken": { values: {}, invalid: {} },
  "messaging.send": { values: {"message": {"topic": "news", "data": {"hello": "world"}}}, invalid: {"message": []} },
  "messaging.subscribeToTopic": { values: {"tokens": [], "topic": "news"}, invalid: {"tokens": "bad", "topic": 7} },
  "messaging.unsubscribeFromTopic": { values: {"tokens": [], "topic": "news"}, invalid: {"tokens": "bad", "topic": 7} },
  "messaging.deliver": { values: {"spec": {"data": {"hello": "world"}}}, invalid: {"spec": []} },
  "messaging.acknowledge": { values: {"subId": "protocol-invalid", "messageId": "protocol-invalid", "stage": "received"}, invalid: {"subId": 7, "messageId": 7, "stage": "unsupported"} },
  "messaging.setVisibility": { values: {"state": "visible"}, invalid: {"state": 7} },
  "presence.register": { values: {"clientId": "protocol-invalid", "kind": "app", "route": "/", "visibility": "visible"}, invalid: {"clientId": 7, "kind": 7, "route": 7, "visibility": 7} },
  "presence.heartbeat": { values: {"clientId": "protocol-invalid"}, invalid: {"clientId": 7} },
  "presence.update": { values: {"clientId": "protocol-invalid"}, invalid: {"clientId": 7} },
  "presence.disconnect": { values: {"clientId": "protocol-invalid"}, invalid: {"clientId": 7} },
};


export interface ProtocolCase { label: string; payload: Record<string, unknown> }

/** Exercise actual native ports or hosted sockets against the running disposable CLI. */
export async function exerciseProtocolCases(page: Page, mode: string, cases: ProtocolCase[], controls: unknown[] = []) {
  return page.evaluate(async ({ mode, cases, controls }) => {
        let connectionClosed = false;
        const received: unknown[] = [];
        const errors: string[] = [];
        const pending = new Map<string, (reply: unknown) => void>();
        function receive(frame: unknown): void {
          const hasReplyFields = frame !== null && typeof frame === 'object' && 't' in frame && 'id' in frame;
          if (hasReplyFields) {
            const id = frame.id;
            const isResponse = frame.t === 'res' && typeof id === 'string';
            if (isResponse) pending.get(id)?.(frame);
          }
        }
        function receiveSnapshot(frame: unknown): void {
          received.push(frame);
          const hasSnapshotFields = frame !== null && typeof frame === 'object' && 't' in frame && 'subId' in frame;
          if (hasSnapshotFields) {
            const id = frame.subId;
            const hasSubscriptionReply = frame.t === 'snap' || frame.t === 'event';
            const isSnapshot = hasSubscriptionReply && typeof id === 'string';
            if (isSnapshot) pending.get(id)?.(frame);
          }
          receive(frame);
        }
        let send: (message: unknown) => void;
        let close: () => void;
        const usesHostedRuntime = mode === 'hosted';
        const usesServiceWorkerRelay = mode === 'service-worker-relay';
        if (usesHostedRuntime) {
          const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/__pyric/sandbox`);
          const attached = Promise.withResolvers<void>();
          socket.onclose = () => {
            connectionClosed = true;
            for (const resolve of pending.values()) resolve({ connectionClosed: true });
          };
          socket.onopen = () => socket.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' }));
          socket.onmessage = event => {
            const frame: unknown = JSON.parse(event.data);
            const hasType = frame !== null && typeof frame === 'object' && 'type' in frame;
            if (hasType) {
              const isAcknowledgment = frame.type === 'attach-ack';
              if (isAcknowledgment) attached.resolve();
              const isWorkerReply = frame.type === 'worker-message-result' && 'message' in frame;
              if (isWorkerReply) receiveSnapshot(frame.message);
            }
          };
          send = message => socket.send(JSON.stringify({ type: 'worker-message', message }));
          close = () => socket.close();
          await attached.promise;
        } else if (usesServiceWorkerRelay) {
          const channel = new BroadcastChannel('pyric-shared-worker:service-worker');
          const clientId = crypto.randomUUID();
          const sessionId = crypto.randomUUID();
          channel.onmessage = event => {
            const envelope: unknown = event.data;
            const hasMessage = envelope !== null && typeof envelope === 'object' && 'direction' in envelope
              && envelope.direction === 'client' && 'clientId' in envelope && envelope.clientId === clientId && 'message' in envelope;
            if (hasMessage) receiveSnapshot(envelope.message);
          };
          channel.postMessage({ direction: 'host', phase: 'attach', clientId, sessionId });
          send = message => channel.postMessage({ direction: 'host', phase: 'message', clientId, sessionId, message });
          close = () => channel.close();
        } else {
          const snapshot = globalThis.__pyricRuntime?.getSnapshot();
          const epoch = snapshot?.runningEpoch;
          const hasNoWorker = snapshot?.mode !== 'shared-worker' || typeof epoch !== 'string';
          if (hasNoWorker) throw new Error('The real SharedWorker must be running.');
          const worker = new SharedWorker('/__pyric/sdk/worker.js', {
            type: 'classic', name: `pyric-shared-worker:${epoch}`,
          });
          worker.onerror = event => errors.push(event.message);
          worker.port.onmessage = event => receiveSnapshot(event.data);
          worker.port.start();
          send = message => worker.port.postMessage(message);
          close = () => worker.port.close();
        }
        async function call(id: string, payload: Record<string, unknown>): Promise<unknown> {
          if (connectionClosed) return { connectionClosed: true };
          const reply = Promise.withResolvers<unknown>();
          pending.set(id, reply.resolve);
          const deadline = setTimeout(() => reply.resolve({ timedOut: true }), 3_000);
          try {
            send({ t: 'op', id, subId: id, actAs: { mode: 'admin' }, ...payload });
            return await reply.promise;
          } finally {
            clearTimeout(deadline);
            pending.delete(id);
          }
        }
        try {
          await call('establish-owner', { method: 'auth.signInAnonymously' });
          const owner = await call('read-owner', { method: 'auth.getCurrentUser' });
          const before = await call('before-provider-config', { method: 'auth.getProviderConfig' });
          const usersBefore = await call('before-users', { method: 'auth.listUsers' });
          const replies: { label: string; reply: unknown }[] = [];
          for (const [index, scenario] of cases.entries()) {
            const reply = await call(`malformed-${index}`, scenario.payload);
            replies.push({ label: scenario.label, reply });
          }
          const hasSubscriptionCases = cases.some(scenario => scenario.payload.t === 'sub');
          if (hasSubscriptionCases) {
            await call('after-subscription-write', { method: 'setDoc', path: 'shared/greeting', data: {
              message: 'Hello from the other browser', verification: 'subscription-refusal',
            } });
          }
          for (const message of controls) send(message);
          const after = await call('after-provider-config', { method: 'auth.getProviderConfig' });
          const usersAfter = await call('after-users', { method: 'auth.listUsers' });
          const healthy = await call('same-caller', { method: 'getVersion' });
          const rtdb = await call('check-rtdb-state', { method: 'rtdb.get', path: 'protocol-invalid' });
          return { replies, before, after, healthy, rtdb, usersBefore, usersAfter, owner, received, errors, connectionClosed };
        } finally {
          send({ t: 'disconnect', id: 'close-protocol-fixture' });
          close();
        }
  }, { mode, cases, controls });
}
