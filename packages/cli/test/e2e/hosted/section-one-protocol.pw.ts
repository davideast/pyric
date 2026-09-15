import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { exerciseProtocolCases, operationShapes, type ProtocolCase } from './section-one-protocol-fixture.js';

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode}: a missing operation method rejects without stranding the caller`, async ({ page }) => {
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    try {
      await page.goto(fixture.info.url);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      const result = await page.evaluate(async mode => {
        const pending = new Map<string, (reply: unknown) => void>();
        function receive(frame: unknown): void {
          const hasReplyFields = frame !== null && typeof frame === 'object' && 't' in frame && 'id' in frame;
          if (hasReplyFields) {
            const id = frame.id;
            const isResponse = frame.t === 'res' && typeof id === 'string';
            if (isResponse) pending.get(id)?.(frame);
          }
        }
        let send: (message: unknown) => void;
        let close: () => void;
        const usesHostedRuntime = mode === 'hosted';
        if (usesHostedRuntime) {
          const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/__pyric/sandbox`);
          const attached = Promise.withResolvers<void>();
          socket.onopen = () => socket.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' }));
          socket.onmessage = event => {
            const frame: unknown = JSON.parse(event.data);
            const hasType = frame !== null && typeof frame === 'object' && 'type' in frame;
            if (hasType) {
              const isAcknowledgment = frame.type === 'attach-ack';
              if (isAcknowledgment) attached.resolve();
              const isWorkerReply = frame.type === 'worker-message-result' && 'message' in frame;
              if (isWorkerReply) receive(frame.message);
            }
          };
          send = message => socket.send(JSON.stringify({ type: 'worker-message', message }));
          close = () => socket.close();
          await attached.promise;
        } else {
          const snapshot = globalThis.__pyricRuntime?.getSnapshot();
          const epoch = snapshot?.runningEpoch;
          const hasNoWorker = snapshot?.mode !== 'shared-worker' || typeof epoch !== 'string';
          if (hasNoWorker) throw new Error('The real SharedWorker must be running.');
          const worker = new SharedWorker('/__pyric/sdk/worker.js', {
            type: 'classic', name: `pyric-shared-worker:${epoch}`,
          });
          worker.port.onmessage = event => receive(event.data);
          worker.port.start();
          send = message => worker.port.postMessage(message);
          close = () => worker.port.close();
        }
        async function call(id: string, payload: Record<string, unknown>): Promise<unknown> {
          const reply = Promise.withResolvers<unknown>();
          pending.set(id, reply.resolve);
          const deadline = setTimeout(() => reply.resolve({ timedOut: true }), 3_000);
          try {
            send({ t: 'op', id, ...payload });
            return await reply.promise;
          } finally {
            clearTimeout(deadline);
            pending.delete(id);
          }
        }
        try {
          const malformed = await call('missing-method', {
            path: 'shared/greeting', data: { message: 'Malformed operation changed state' },
          });
          const healthy = await call('same-caller', { method: 'getVersion' });
          return { malformed, healthy };
        } finally {
          send({ t: 'disconnect', id: 'close-protocol-fixture' });
          close();
        }
      }, mode);
      expect(result.malformed).toMatchObject({ t: 'res', id: 'missing-method', ok: false, error: { code: 'invalid-argument' } });
      expect(result.healthy).toMatchObject({ t: 'res', id: 'same-caller', ok: true });
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), { message: 'Independent client still works' });
      });
      await expect(page.locator('#document')).toHaveText('Independent client still works');
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}


const malformedArguments: ProtocolCase[] = [
  { label: 'null method', payload: { method: null } },
  { label: 'numeric method', payload: { method: 7 } },
  { label: 'unknown method', payload: { method: 'not-a-method' } },
  { label: 'unknown AI method', payload: { method: 'ai.not-a-method' } },
  { label: 'missing document path', payload: { method: 'getDoc' } },
  { label: 'numeric document path', payload: { method: 'getDoc', path: 7 } },
  { label: 'numeric collection path', payload: { method: 'addDoc', collectionPath: 7, data: {} } },
  { label: 'missing document data', payload: { method: 'setDoc', path: 'protocol-invalid/document' } },
  { label: 'array update data', payload: { method: 'updateDoc', path: 'shared/greeting', data: [] } },
  { label: 'invalid set options', payload: { method: 'setDoc', path: 'protocol-invalid/options', data: {}, options: 7 } },
  { label: 'invalid aggregate descriptor', payload: { method: 'aggregate', source: { __ref: 'collection', path: 'shared' }, spec: { bad: { kind: 'unsupported' } } } },
  { label: 'invalid batch writes', payload: { method: 'batchCommit', writes: null } },
  { label: 'invalid transaction reads', payload: { method: 'txnCommit', reads: null, writes: [] } },
  { label: 'invalid rules source', payload: { method: 'setFirestoreRules', source: 7 } },
  { label: 'invalid rules service', payload: { method: 'getActiveRules', service: 'unsupported' } },
  { label: 'numeric subcollection path', payload: { method: 'listSubcollections', docPath: 7 } },
  { label: 'invalid import bundle', payload: { method: 'importState', bundle: {} } },
  { label: 'invalid checkpoint name', payload: { method: 'checkpoint', name: 7 } },
  { label: 'array admin data', payload: { method: 'admin.setDocument', path: 'protocol-invalid/admin', data: [] } },
  { label: 'invalid admin depth', payload: { method: 'admin.readState', maxDepth: 'deep' } },
  { label: 'invalid RTDB query', payload: { method: 'rtdb.get', path: 'protocol-invalid', query: 7 } },
  { label: 'invalid RTDB priority', payload: { method: 'rtdb.setPriority', path: 'protocol-invalid', priority: {} } },
  { label: 'invalid RTDB update', payload: { method: 'rtdb.update', path: 'protocol-invalid', values: [] } },
  { label: 'numeric RTDB push key', payload: { method: 'rtdb.push', path: 'protocol-invalid/children', key: 7, value: 'must not be stored' } },
  { label: 'invalid disconnect update', payload: { method: 'rtdb.onDisconnectUpdate', path: 'protocol-invalid', values: [] } },
  { label: 'invalid persistence mode', payload: { method: 'auth.setPersistence', mode: 'unsupported' } },
  { label: 'invalid tenant value', payload: { method: 'auth.setTenantId', tenantId: 7 } },
  { label: 'invalid provider enabled flag', payload: { method: 'auth.setProviderConfig', providerId: 'google.com', enabled: 'yes' } },
  { label: 'invalid admin user request', payload: { method: 'auth.adminCreateUser', request: null } },
  { label: 'invalid credential', payload: { method: 'auth.signInWithCredential', credential: null } },
  { label: 'invalid accepted identity', payload: { method: 'auth.acceptIdentity', identity: null } },
  { label: 'invalid storage byte string', payload: { method: 'storage.putBytes', path: 'protocol-invalid/blob', dataB64: 7 } },
  { label: 'invalid storage metadata', payload: { method: 'storage.putBytes', path: 'protocol-invalid/metadata', dataB64: '', metadata: [] } },
  { label: 'invalid AI engine kind', payload: { method: 'ai.countTokens', model: 'local', request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }, engine: { kind: 'unsupported' } } },
  { label: 'invalid messaging tokens', payload: { method: 'messaging.subscribeToTopic', tokens: 'not-an-array', topic: 'news' } },
  { label: 'invalid messaging spec', payload: { method: 'messaging.deliver', spec: 7 } },
  { label: 'invalid messaging visibility', payload: { method: 'messaging.setVisibility', state: 'unsupported' } },
  { label: 'invalid presence visibility', payload: { method: 'presence.register', clientId: 'protocol-invalid', kind: 'app', route: '/', visibility: 'unsupported' } },
];

// One finite row per declared method; mutation cases vary one required field at a time.
for (const [method, shape] of Object.entries(operationShapes)) {
  for (const field of Object.keys(shape.values)) {
    const payload: Record<string, unknown> = { method, ...shape.values };
    delete payload[field];
    malformedArguments.push({ label: `${method}: missing ${field}`, payload });
  }
  for (const [field, invalid] of Object.entries(shape.invalid)) {
    malformedArguments.push({ label: `${method}: invalid ${field}`, payload: { method, ...shape.values, [field]: invalid } });
  }
}
malformedArguments.push(
  { label: 'numeric logical owner', payload: { method: 'auth.getCurrentUser', clientSessionId: 7 } },
  { label: 'invalid resume flag', payload: { method: 'auth.getCurrentUser', resumeSession: 'yes' } },
  { label: 'invalid identity lens', payload: { method: 'getVersion', actAs: { mode: 'unsupported' } } },
  { label: 'missing tool name', payload: { t: 'tool', args: {} } },
  { label: 'invalid tool arguments', payload: { t: 'tool', name: 'firestore_get', args: [] } },
  { label: 'invalid set merge flag', payload: { method: 'setDoc', path: 'protocol-invalid/options', data: {}, options: { merge: 'yes' } } },
  { label: 'invalid merge fields', payload: { method: 'setDoc', path: 'protocol-invalid/options', data: {}, options: { mergeFields: [7] } } },
  { label: 'unknown document encoding', payload: { method: 'setDoc', path: 'protocol-invalid/encoding', data: {}, valueEncoding: 'unsupported' } },
  { label: 'invalid update profile', payload: { method: 'auth.updateProfile', displayName: 7 } },
  { label: 'invalid token refresh flag', payload: { method: 'auth.getIdToken', forceRefresh: 'yes' } },
  { label: 'invalid anonymous tenant', payload: { method: 'auth.signInAnonymously', tenantId: 7 } },
  { label: 'invalid storage content type', payload: { method: 'storage.putBytes', path: 'protocol-invalid/type', dataB64: '', contentType: 7 } },
  { label: 'invalid visibility in delivery', payload: { method: 'messaging.deliver', spec: { visibilityState: 'unsupported' } } },
  { label: 'invalid messaging validation flag', payload: { method: 'messaging.send', message: { topic: 'news' }, validateOnly: 'yes' } },
  { label: 'invalid messaging registration', payload: { method: 'messaging.getToken', registrationId: 7 } },
  { label: 'invalid presence route update', payload: { method: 'presence.update', clientId: 'protocol-invalid', route: 7 } },
  { label: 'invalid presence visibility update', payload: { method: 'presence.update', clientId: 'protocol-invalid', visibility: 'unsupported' } },
  { label: 'invalid RTDB query order', payload: { method: 'rtdb.get', path: 'protocol-invalid', query: { orderBy: { kind: 'unsupported' }, bounds: [], limit: null } } },
  { label: 'invalid RTDB query bounds', payload: { method: 'rtdb.get', path: 'protocol-invalid', query: { orderBy: null, bounds: {}, limit: null } } },
  { label: 'invalid RTDB query limit', payload: { method: 'rtdb.get', path: 'protocol-invalid', query: { orderBy: null, bounds: [], limit: { kind: 'unsupported', n: 1 } } } },
);

const identity = { uid: 'protocol-invalid', providerId: 'google.com', email: null, displayName: null, photoURL: null, customClaims: {} };
for (const field of ['uid', 'providerId', 'email', 'displayName', 'photoURL', 'customClaims']) {
  malformedArguments.push({ label: `invalid identity.${field}`, payload: { method: 'auth.acceptIdentity', identity: { ...identity, [field]: 7 } } });
}
for (const field of ['providerId', 'uid', 'email', 'displayName', 'photoURL', 'idToken', 'accessToken', 'rawNonce']) {
  malformedArguments.push({ label: `invalid credential.${field}`, payload: { method: 'auth.signInWithCredential', credential: { providerId: 'google.com', uid: 'protocol-invalid', [field]: 7 } } });
}
for (const engine of [
  { kind: 'scripted', script: {} }, { kind: 'scripted', script: [7] },
  { kind: 'openai', baseUrl: 7 }, { kind: 'openai', model: 7 },
  { kind: 'openai', modelMap: [] }, { kind: 'openai', modelMap: { local: 7 } },
  { kind: 'gemini', apiKey: 7 }, { kind: 'gemini', baseUrl: 7 },
]) {
  malformedArguments.push({ label: `invalid engine ${JSON.stringify(engine)}`, payload: { method: 'ai.countTokens', model: 'local', request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }, engine } });
}
for (const descriptor of [null, 7, { kind: 'unsupported', field: 'message' }, { kind: 'sum', field: 7 }, { kind: 'average' }]) {
  malformedArguments.push({ label: `invalid aggregate member ${JSON.stringify(descriptor)}`, payload: { method: 'aggregate', source: { __ref: 'collection', path: 'shared' }, spec: { bad: descriptor } } });
}
for (const bound of [null, { kind: 'unsupported', value: 1 }, { kind: 'startAt' }, { kind: 'endAt', value: 1, key: 7 }]) {
  malformedArguments.push({ label: `invalid RTDB bound ${JSON.stringify(bound)}`, payload: { method: 'rtdb.get', path: 'protocol-invalid', query: { orderBy: null, bounds: [bound], limit: null } } });
}
for (const n of ['1', null]) {
  malformedArguments.push({ label: `invalid RTDB limit number ${JSON.stringify(n)}`, payload: { method: 'rtdb.get', path: 'protocol-invalid', query: { orderBy: null, bounds: [], limit: { kind: 'limitToFirst', n } } } });
}
for (const spec of [{ data: [] }, { data: { message: 7 } }, { notification: [] }, { notification: { title: 7 } }, { from: 7 }, { messageId: 7 }]) {
  malformedArguments.push({ label: `invalid delivery member ${JSON.stringify(spec)}`, payload: { method: 'messaging.deliver', spec } });
}

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode}: malformed operation arguments refuse before mutation`, async ({ page }) => {
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    try {
      await page.goto(fixture.info.url);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      expect(Object.keys(operationShapes)).toHaveLength(93);
      const result = await exerciseProtocolCases(page, mode, malformedArguments);
      for (const entry of result.replies) {
        const isRoutingHint = entry.label === 'numeric logical owner' || entry.label === 'invalid resume flag';
        const isIgnoredHostedHint = usesHostedRuntime && isRoutingHint;
        if (isIgnoredHostedHint) {
          const owner = result.owner;
          const hasOwner = owner !== null && typeof owner === 'object' && 'value' in owner;
          expect(hasOwner).toBe(true);
          if (hasOwner) expect.soft(entry.reply, entry.label).toMatchObject({ ok: true, value: owner.value });
        } else {
          expect.soft(entry.reply, entry.label).toMatchObject({ ok: false, error: { code: expect.any(String), message: expect.any(String) } });
        }
      }
      expect(result.healthy).toMatchObject({ ok: true });
      expect(result.rtdb).toMatchObject({ ok: true, value: { exists: false, value: null } });
      const documents = await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        const snapshot = await sdk.getDocs(sdk.collection(sdk.getFirestore(), 'protocol-invalid'));
        return snapshot.size;
      });
      expect(documents).toBe(0);
      const usersBefore = result.usersBefore;
      const usersAfter = result.usersAfter;
      const hasUsersBefore = usersBefore !== null && typeof usersBefore === 'object' && 'value' in usersBefore;
      const hasUsersAfter = usersAfter !== null && typeof usersAfter === 'object' && 'value' in usersAfter;
      const hasUsers = hasUsersBefore && hasUsersAfter;
      expect(hasUsers).toBe(true);
      if (hasUsers) expect(usersAfter.value).toEqual(usersBefore.value);
      const before = result.before;
      const after = result.after;
      const hasBeforeValue = before !== null && typeof before === 'object' && 'value' in before;
      const hasAfterValue = after !== null && typeof after === 'object' && 'value' in after;
      expect(hasBeforeValue).toBe(true);
      expect(hasAfterValue).toBe(true);
      const hasValues = hasBeforeValue && hasAfterValue;
      if (hasValues) expect(after.value).toEqual(before.value);
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), { message: 'Independent client still works' });
      });
      await expect(page.locator('#document')).toHaveText('Independent client still works');
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}


const subscriptionCases: ProtocolCase[] = [
  { label: 'missing target', payload: { t: 'sub' } },
  { label: 'unknown named target', payload: { t: 'sub', target: 'unsupported' } },
  { label: 'invalid RTDB path', payload: { t: 'sub', target: { service: 'rtdb', path: 7 } } },
  { label: 'missing RTDB path', payload: { t: 'sub', target: { service: 'rtdb' } } },
  { label: 'invalid RTDB query', payload: { t: 'sub', target: { service: 'rtdb', path: 'protocol-invalid', query: {} } } },
  { label: 'unknown AI subscription operation', payload: { t: 'sub', target: { service: 'ai', op: 'unsupported' }, model: 'local', request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } } },
  { label: 'invalid AI subscription model', payload: { t: 'sub', target: { service: 'ai', op: 'streamGenerateContent' }, model: 7, request: {} } },
  { label: 'invalid AI subscription request', payload: { t: 'sub', target: { service: 'ai', op: 'streamGenerateContent' }, model: 'local', request: [] } },
  { label: 'unknown AI subscription engine', payload: { t: 'sub', target: { service: 'ai', op: 'streamGenerateContent' }, model: 'local', request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }, engine: { kind: 'unsupported' } } },
  { label: 'invalid owner list', payload: { t: 'sub', target: { __ref: 'doc', path: 'shared/greeting' }, owners: {} } },
  { label: 'invalid owner member', payload: { t: 'sub', target: { __ref: 'doc', path: 'shared/greeting' }, owners: [null] } },
  { label: 'unknown owner kind', payload: { t: 'sub', target: { __ref: 'doc', path: 'shared/greeting' }, owners: [{ kind: 'unsupported' }] } },
];
for (const owner of [
  { kind: 'frame', file: 7, line: 1 }, { kind: 'frame', file: 'main.ts', line: '1' },
  { kind: 'tag', name: 7 }, { kind: 'regions', selectors: [7] },
  { kind: 'component', name: 7 }, { kind: 'component', name: 'App', path: [7] },
]) {
  subscriptionCases.push({ label: `invalid owner fields ${JSON.stringify(owner)}`, payload: { t: 'sub', target: { __ref: 'doc', path: 'shared/greeting' }, owners: [owner] } });
}

for (const target of ['authState', 'idToken', 'events', 'messaging.foreground', 'messaging.background', 'presence']) {
  subscriptionCases.push({ label: `invalid owner on ${target}`, payload: { t: 'sub', target, clientSessionId: 7 } });
}

const malformedControls: { label: string; message: unknown }[] = [
  { label: 'null message', message: null },
  { label: 'array message', message: [] },
  { label: 'unknown kind', message: { t: 'unsupported' } },
  { label: 'missing operation ID', message: { t: 'op', method: 'setDoc', path: 'shared/greeting', data: { message: 'Malformed operation changed state' }, actAs: { mode: 'admin' } } },
  { label: 'numeric operation ID', message: { t: 'op', id: 7, method: 'setDoc', path: 'shared/greeting', data: { message: 'Malformed operation changed state' }, actAs: { mode: 'admin' } } },
  { label: 'numeric subscription ID', message: { t: 'sub', subId: 7, target: { __ref: 'doc', path: 'shared/greeting' }, actAs: { mode: 'admin' } } },
  { label: 'numeric unsubscribe ID', message: { t: 'unsub', subId: 7 } },
  { label: 'missing disconnect ID', message: { t: 'disconnect' } },
  { label: 'numeric disconnect ID', message: { t: 'disconnect', id: 7 } },
  { label: 'missing app configuration', message: { t: 'appConfig' } },
  { label: 'null app configuration', message: { t: 'appConfig', options: null } },
  { label: 'invalid clock owner', message: { t: 'clock-subscribe', clientSessionId: 7 } },
  { label: 'missing tool ID', message: { t: 'tool', name: 'firestore_get', args: {} } },
];

for (const mode of ['hosted', 'shared-worker', 'service-worker-relay']) {
  test(`${mode}: malformed subscription families refuse without registration`, async ({ page }) => {
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
    const fixture = await startSoakServe({ flags, extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    } });
    try {
      await page.goto(fixture.info.url);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      const cases = subscriptionCases.filter(scenario => {
        const usesIgnoredHostedHint = usesHostedRuntime && scenario.label.startsWith('invalid owner on');
        const includesScenario = !usesIgnoredHostedHint;
        return includesScenario;
      });
      const result = await exerciseProtocolCases(page, mode, cases);
      for (const [index, entry] of result.replies.entries()) {
        expect.soft(entry.reply, entry.label).toMatchObject({ t: 'snap', value: { __error: { code: expect.any(String), message: expect.any(String) } } });
        const expectedId = `malformed-${index}`;
        const deliveries = result.received.filter(frame => {
          const ownsDelivery = frame !== null && typeof frame === 'object' && 'subId' in frame && frame.subId === expectedId;
          return ownsDelivery;
        });
        expect.soft(deliveries, `${entry.label}: no delivery after refusal`).toHaveLength(1);
      }
      expect(result.healthy).toMatchObject({ ok: true });
      expect(result.errors).toEqual([]);
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await page.close();
      await fixture.stop();
    }
  });

  test(`${mode}: malformed controls cannot mutate or poison an app connection`, async ({ page }) => {
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
    const fixture = await startSoakServe({ flags, extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    } });
    try {
      await page.goto(fixture.info.url);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      for (const scenario of malformedControls) {
        await test.step(scenario.label, async () => {
          await page.evaluate(async () => {
            const sdk = await import('firebase/firestore');
            await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), { message: 'Hello from the other browser' });
          });
          const result = await exerciseProtocolCases(page, mode, [], [scenario.message]);
          const terminatedHostedConnection = usesHostedRuntime && result.connectionClosed;
          const keptConnection = !terminatedHostedConnection;
          if (keptConnection) expect.soft(result.healthy, scenario.label).toMatchObject({ ok: true });
          expect.soft(result.errors, scenario.label).toEqual([]);
          const malformedCorrelations = result.received.filter(frame => {
            const isRecord = frame !== null && typeof frame === 'object';
            const isNotRecord = !isRecord;
            if (isNotRecord) return false;
            const hasInvalidId = 'id' in frame && typeof frame.id !== 'string';
            const hasInvalidSubId = 'subId' in frame && typeof frame.subId !== 'string';
            const hasInvalidOwner = 'clientSessionId' in frame && frame.clientSessionId !== undefined && typeof frame.clientSessionId !== 'string';
            return hasInvalidId || hasInvalidSubId || hasInvalidOwner;
          });
          expect.soft(malformedCorrelations, scenario.label).toEqual([]);
          const message = await page.evaluate(async () => {
            const sdk = await import('firebase/firestore');
            const snapshot = await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'));
            return snapshot.data()?.message;
          });
          expect.soft(message, scenario.label).toBe('Hello from the other browser');
        });
      }
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), { message: 'Independent client still works' });
      });
      await expect(page.locator('#document')).toHaveText('Independent client still works');
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
