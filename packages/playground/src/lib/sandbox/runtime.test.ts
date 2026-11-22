/**
 * #1433: Playground in-process (`isolated`) and shared (`SharedWorker`) runtimes
 * agree on Firestore rules deploy `ok`, lint messages, and active-rules preservation
 * when production's load check (`rulesSourceRejection`) refuses a candidate.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { handleMessage, type HostCtx, type PortLike } from '../../../../cli/src/serve/worker/host.js';
import type { InboundMessage } from '../../../../cli/src/serve/worker/protocol.js';
import { disposeRunner, getRunner } from './runner';
import { deployFirestoreRules, setActivePlaygroundSandboxMode, sharedWorkerRuntime } from './runtime';

const ALLOW_ALL_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

const OPEN_NOTES_ONLY_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /notes/{id} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

const DUPLICATE_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /notes/{id} { allow read: if true; }',
  '  }',
  '}',
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /items/{id} { allow read: if true; }',
  '  }',
  '}',
].join('\n');

const SYNTAX_ERROR_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /notes/{id} { allow read, write: if true }',
  '  }',
  '}',
].join('\n');

const globalScope = globalThis as { SharedWorker?: unknown };
const priorSharedWorker = globalScope.SharedWorker;
const channels: MessageChannel[] = [];
let sharedCtx: HostCtx;

beforeAll(async () => {
  const existingWindow = (globalThis as { window?: Record<string, unknown> }).window;
  if (existingWindow !== undefined && typeof existingWindow.addEventListener !== 'function') {
    existingWindow.addEventListener = () => {};
    existingWindow.removeEventListener = () => {};
  }
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: 'playground-parity-test',
    injectedBackend: createMemoryBackend(),
  });
  sharedCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'playground-parity-test',
    subs: new Map(),
  };

  class InMemorySharedWorker {
    readonly port: MessagePort;

    constructor() {
      const channel = new MessageChannel();
      channels.push(channel);
      this.port = channel.port1;
      const hostPort: PortLike = {
        postMessage(msg: unknown) {
          channel.port2.postMessage(msg);
        },
      };
      channel.port2.onmessage = (event: MessageEvent) => {
        void handleMessage(sharedCtx, hostPort, event.data as InboundMessage);
      };
      channel.port2.start();
    }

    addEventListener(): void {}
  }

  globalScope.SharedWorker = InMemorySharedWorker;
});

afterEach(() => {
  setActivePlaygroundSandboxMode('isolated');
  disposeRunner();
});

afterAll(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
  sharedCtx.sandbox.dispose();
  if (priorSharedWorker === undefined) {
    delete globalScope.SharedWorker;
  } else {
    globalScope.SharedWorker = priorSharedWorker;
  }
});

describe('playground in-process and shared runtimes deployFirestoreRules parity (#1433)', () => {
  it('answers ok: true with error-severity lint findings on an allow-all ruleset in both runtimes', async () => {
    setActivePlaygroundSandboxMode('isolated');
    const inProcess = await deployFirestoreRules(ALLOW_ALL_RULES);

    setActivePlaygroundSandboxMode('shared');
    const shared = await deployFirestoreRules(ALLOW_ALL_RULES);

    expect(inProcess.ok).toBe(true);
    expect(shared.ok).toBe(true);
    expect(inProcess.ok).toBe(shared.ok);
    expect(inProcess.messages.some((m) => m.severity === 'error')).toBe(true);
    expect(inProcess.messages).toEqual(shared.messages);

    setActivePlaygroundSandboxMode('isolated');
    await setDoc(doc(getRunner().getDb(), 'items/in-proc'), { ok: true });
    await sharedWorkerRuntime.setDoc(
      sharedWorkerRuntime.doc(sharedWorkerRuntime.getFirestore('/__pyric/sdk/worker.js'), 'items/shared'),
      { ok: true },
    );
  });

  it('answers ok: false and preserves active rules when rulesSourceRejection refuses the source', async () => {
    setActivePlaygroundSandboxMode('isolated');
    expect((await deployFirestoreRules(OPEN_NOTES_ONLY_RULES)).ok).toBe(true);
    const inProcDup = await deployFirestoreRules(DUPLICATE_FIRESTORE_RULES);
    const inProcSyntax = await deployFirestoreRules(SYNTAX_ERROR_RULES);
    await setDoc(doc(getRunner().getDb(), 'notes/still-open'), { ok: true });
    await expect(setDoc(doc(getRunner().getDb(), 'locked/still-closed'), { ok: false })).rejects.toMatchObject({
      code: 'permission-denied',
    });

    setActivePlaygroundSandboxMode('shared');
    expect((await deployFirestoreRules(OPEN_NOTES_ONLY_RULES)).ok).toBe(true);
    const sharedDup = await deployFirestoreRules(DUPLICATE_FIRESTORE_RULES);
    const sharedSyntax = await deployFirestoreRules(SYNTAX_ERROR_RULES);
    await setDoc(doc(sharedCtx.db, 'notes/still-open'), { ok: true });
    await expect(setDoc(doc(sharedCtx.db, 'locked/still-closed'), { ok: false })).rejects.toMatchObject({
      code: 'permission-denied',
    });

    expect(inProcDup.ok).toBe(false);
    expect(sharedDup.ok).toBe(false);
    expect(inProcDup).toEqual(sharedDup);

    expect(inProcSyntax.ok).toBe(false);
    expect(sharedSyntax.ok).toBe(false);
    expect(inProcSyntax).toEqual(sharedSyntax);
  });
});
