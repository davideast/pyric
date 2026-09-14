import { test, expect, type Browser } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

type AtomicFault =
  | 'unknown-method'
  | 'null-write'
  | 'non-array-writes'
  | 'non-array-reads'
  | 'null-read'
  | 'array-read-path'
  | 'missing-read-data'
  | 'missing-read-json'
  | 'invalid-read-json'
  | 'scalar-read-json'
  | 'unsupported-read-encoding';
type AtomicOperation = 'batch' | 'transaction';
type Transport = 'hosted' | 'SharedWorker';

const cases: { fault: AtomicFault; input: string; outcome: string; operations: AtomicOperation[] }[] = [
  { fault: 'unknown-method', input: 'an unknown write method', outcome: 'its valid sibling', operations: ['batch', 'transaction'] },
  { fault: 'null-write', input: 'a null write descriptor', outcome: 'its valid sibling', operations: ['batch', 'transaction'] },
  { fault: 'non-array-writes', input: 'a non-array write list', outcome: 'any document', operations: ['batch', 'transaction'] },
  { fault: 'non-array-reads', input: 'a non-array read set', outcome: 'any document', operations: ['transaction'] },
  { fault: 'null-read', input: 'a null read descriptor', outcome: 'any document', operations: ['transaction'] },
  { fault: 'array-read-path', input: 'an array read path', outcome: 'any document', operations: ['transaction'] },
  { fault: 'missing-read-data', input: 'missing read data', outcome: 'any document', operations: ['transaction'] },
  { fault: 'missing-read-json', input: 'missing serialized read JSON', outcome: 'any document', operations: ['transaction'] },
  { fault: 'invalid-read-json', input: 'malformed serialized read JSON', outcome: 'any document', operations: ['transaction'] },
  { fault: 'scalar-read-json', input: 'a scalar serialized read document', outcome: 'any document', operations: ['transaction'] },
  { fault: 'unsupported-read-encoding', input: 'an unsupported read encoding', outcome: 'any document', operations: ['transaction'] },
];
const transports: Transport[] = ['hosted', 'SharedWorker'];
const readDataFaults: Partial<Record<AtomicFault, { data?: unknown }>> = {
  'missing-read-data': {},
  'missing-read-json': { data: {} },
  'invalid-read-json': { data: { json: '{' } },
  'scalar-read-json': { data: { json: '0' } },
  'unsupported-read-encoding': { data: { json: '{}', valueEncoding: 'pyric/firestore-values/999' } },
};

for (const transport of transports) {
  for (const scenario of cases) {
    for (const operation of scenario.operations) {
      test(`${transport} ${operation} rejects ${scenario.input} without committing ${scenario.outcome}`, async ({ browser }) => {
        await rejectMalformedAtomicWrite(browser, scenario.fault, operation, transport);
      });
    }
  }
}

async function rejectMalformedAtomicWrite(browser: Browser, fault: AtomicFault, operation: AtomicOperation, transport: Transport): Promise<void> {
  const readDataFault = readDataFaults[fault];
  let write = `
    const batch = writeBatch(db);
    batch.set(first, { message: 'First' });
    batch.set(second, { message: 'Second' });
    await batch.commit();
  `;
  const usesTransaction = operation === 'transaction';
  if (usesTransaction) {
    write = `
      await runTransaction(db, async (transaction) => {
        await transaction.get(first);
        transaction.set(first, { message: 'First' });
        transaction.set(second, { message: 'Second' });
      });
    `;
  }
  const isHosted = transport === 'hosted';
  const usesSharedWorker = transport === 'SharedWorker';
  const flags = ['--no-capture'];
  if (isHosted) flags.push('--hosted');
  const serve = await startSoakServe({
    flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /payloads/{id} { allow read, write: if true; } } }",
      'index.html': '<button id="write">Write documents</button><button id="read">Read documents</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, writeBatch, runTransaction } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const first = doc(db, 'payloads/first');
        const second = doc(db, 'payloads/second');
        const result = document.querySelector('#result');
        document.querySelector('#write').addEventListener('click', async () => {
          try {
            ${write}
            result.textContent = 'Written';
          } catch (error) {
            result.textContent = error.code;
          }
        });
        document.querySelector('#read').addEventListener('click', async () => {
          try {
            const values = await Promise.all([first, second].map(async (reference) => {
              const snapshot = await getDoc(reference);
              const documentExists = snapshot.exists();
              if (documentExists) return snapshot.data().message;
              return 'Missing';
            }));
            result.textContent = JSON.stringify(values);
          } catch (error) {
            result.textContent = error.code;
          }
        });
        result.textContent = 'Ready';
      `,
    },
  });
  const brokenContext = await browser.newContext();
  let healthyContext = brokenContext;
  if (isHosted) healthyContext = await browser.newContext();
  try {
    await brokenContext.routeWebSocket('**/*', (route) => {
      const server = route.connectToServer();
      route.onMessage((data) => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        if (isBridgeFrame) {
          const isWorkerRequest = frame.type === 'worker-message';
          if (isWorkerRequest) {
            const request = frame.message;
            const isAtomicWrite = request.t === 'op' && (request.method === 'batchCommit' || request.method === 'txnCommit');
            if (isAtomicWrite) {
              const corruptsReadData = readDataFault !== undefined && request.method === 'txnCommit';
              if (corruptsReadData) {
                const reads = request.reads.map((read) => ({ path: read.path, ...readDataFault }));
                server.send(JSON.stringify({ ...frame, message: { ...request, reads } }));
                return;
              }
              const usesArrayReadPath = fault === 'array-read-path' && request.method === 'txnCommit';
              if (usesArrayReadPath) {
                const reads = request.reads.map((read) => ({ ...read, path: [read.path] }));
                server.send(JSON.stringify({ ...frame, message: { ...request, reads } }));
                return;
              }
              const usesNullRead = fault === 'null-read' && request.method === 'txnCommit';
              if (usesNullRead) {
                const reads = request.reads.map(() => null);
                server.send(JSON.stringify({ ...frame, message: { ...request, reads } }));
                return;
              }
              const usesNonArrayReads = fault === 'non-array-reads';
              if (usesNonArrayReads) {
                server.send(JSON.stringify({ ...frame, message: { ...request, reads: '' } }));
                return;
              }
              const usesNonArrayWrites = fault === 'non-array-writes';
              if (usesNonArrayWrites) {
                const writes = { ...request.writes };
                server.send(JSON.stringify({ ...frame, message: { ...request, writes } }));
                return;
              }
              const writes = request.writes.map((write, index) => {
                const isInvalidWrite = index === 1;
                if (isInvalidWrite) {
                  const usesNullWrite = fault === 'null-write';
                  if (usesNullWrite) return null;
                  return { ...write, method: 'unknown-write' };
                }
                return write;
              });
              server.send(JSON.stringify({ ...frame, message: { ...request, writes } }));
              return;
            }
          }
        }
        server.send(data);
      });
      server.onMessage((data) => route.send(data));
    });
    const brokenPage = await brokenContext.newPage();
    if (usesSharedWorker) {
      await brokenPage.addInitScript({ content: `
        const fault = ${JSON.stringify(fault)};
        const readDataFault = ${JSON.stringify(readDataFault)};
        function corruptAtomicRequest(message) {
          const corruptsReadData = readDataFault !== undefined;
          if (corruptsReadData) return { ...message, reads: message.reads.map((read) => ({ path: read.path, ...readDataFault })) };
          const usesArrayReadPath = fault === 'array-read-path';
          if (usesArrayReadPath) return { ...message, reads: message.reads.map((read) => ({ ...read, path: [read.path] })) };
          const usesNullRead = fault === 'null-read';
          if (usesNullRead) return { ...message, reads: message.reads.map(() => null) };
          const usesNonArrayReads = fault === 'non-array-reads';
          if (usesNonArrayReads) return { ...message, reads: '' };
          const usesNonArrayWrites = fault === 'non-array-writes';
          if (usesNonArrayWrites) return { ...message, writes: { ...message.writes } };
          const writes = message.writes.map((write, index) => {
            const isInvalidWrite = index === 1;
            if (isInvalidWrite) {
              const usesNullWrite = fault === 'null-write';
              if (usesNullWrite) return null;
              return { ...write, method: 'unknown-write' };
            }
            return write;
          });
          return { ...message, writes };
        }
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (message, ...options) {
          const isMessage = message !== null && typeof message === 'object';
          if (isMessage) {
            const isAtomicWrite = message.t === 'op' && (message.method === 'batchCommit' || message.method === 'txnCommit');
            if (isAtomicWrite) message = corruptAtomicRequest(message);
          }
          return post.call(this, message, ...options);
        };
      ` });
    }
    const errors: string[] = [];
    brokenPage.on('pageerror', (error) => errors.push(error.message));
    await brokenPage.goto(serve.info.url);
    await expect(brokenPage.locator('#result')).toHaveText('Ready');
    await brokenPage.getByRole('button', { name: 'Write documents', exact: true }).click();
    await expect(brokenPage.locator('#result')).not.toHaveText('Ready');

    const healthyPage = await healthyContext.newPage();
    healthyPage.on('pageerror', (error) => errors.push(error.message));
    await healthyPage.goto(serve.info.url);
    await expect(healthyPage.locator('#result')).toHaveText('Ready');
    await healthyPage.getByRole('button', { name: 'Read documents', exact: true }).click();
    await expect(healthyPage.locator('#result')).toHaveText('["Missing","Missing"]');
    await expect(brokenPage.locator('#result')).toHaveText('invalid-argument');
    await healthyPage.getByRole('button', { name: 'Write documents', exact: true }).click();
    await expect(healthyPage.locator('#result')).toHaveText('Written');
    await healthyPage.getByRole('button', { name: 'Read documents', exact: true }).click();
    await expect(healthyPage.locator('#result')).toHaveText('["First","Second"]');
    await brokenPage.getByRole('button', { name: 'Read documents', exact: true }).click();
    await expect(brokenPage.locator('#result')).toHaveText('["First","Second"]');
    expect(errors).toEqual([]);
  } finally {
    const hasSeparateContext = healthyContext !== brokenContext;
    if (hasSeparateContext) await healthyContext.close();
    await brokenContext.close();
    await serve.stop();
  }
}
