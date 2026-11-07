import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  formatSdkSnippet,
  normalizeServiceName,
} from '../../skills/improve-firebase/scripts/lib/op-snippet.mjs';
import {
  IsolatedSandbox,
  createSnapshot,
  findPyricExecutable,
} from '../../skills/improve-firebase/scripts/lib/sandbox-client.mjs';
import { signInActorPage } from '../../skills/improve-firebase/scripts/lib/identity.mjs';
import {
  createSingleFlightRunner,
  executeStep,
} from '../../skills/improve-firebase/scripts/lib/steps.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const ORBIT_EXAMPLE_DIR = path.join(REPO_ROOT, 'examples', 'teams-workspace');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function directoryMtimeSnapshot(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return null;
  }
  const entries = [];
  function walk(current) {
    const items = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const full = path.join(current, item.name);
      const st = fs.lstatSync(full);
      entries.push(`${path.relative(dirPath, full)}:${st.size}:${st.mtimeMs}`);
      if (item.isDirectory()) {
        walk(full);
      }
    }
  }
  walk(dirPath);
  return entries.join('|');
}

function createMockPlaywrightPage() {
  const local = new Map();
  const session = new Map();
  let currentUrl = 'about:blank';
  let initScript = null;
  let reloadCount = 0;
  let bodyText = 'Orbit Workspace — General channel';
  const cursorMoves = [];

  function makeStorage(map) {
    return {
      getItem(k) {
        return map.has(k) ? map.get(k) : null;
      },
      setItem(k, v) {
        map.set(k, String(v));
      },
      removeItem(k) {
        map.delete(k);
      },
    };
  }

  return {
    get reloadCount() {
      return reloadCount;
    },
    get localStorageMap() {
      return local;
    },
    get cursorMoves() {
      return cursorMoves;
    },
    setBodyText(text) {
      bodyText = text;
    },
    async addInitScript(fn, arg) {
      initScript = { fn, arg };
    },
    async goto(url) {
      currentUrl = url;
      if (initScript) {
        await this.evaluate(initScript.fn, initScript.arg);
      }
    },
    async reload() {
      reloadCount += 1;
      if (initScript) {
        await this.evaluate(initScript.fn, initScript.arg);
      }
    },
    async evaluate(fn, arg) {
      const prevWindow = globalThis.window;
      const prevDocument = globalThis.document;
      const cursorEl = { style: {}, setAttribute() {} };
      globalThis.window = {
        localStorage: makeStorage(local),
        sessionStorage: makeStorage(session),
      };
      globalThis.document = {
        body: { innerText: bodyText, appendChild() {} },
        querySelector(sel) {
          if (sel === '[data-pyric-cursor]') {
            cursorMoves.push(cursorEl.style);
            return cursorEl;
          }
          return null;
        },
        createElement() {
          cursorMoves.push(cursorEl.style);
          return cursorEl;
        },
      };
      try {
        return await fn(arg);
      } finally {
        if (prevWindow === undefined) {
          delete globalThis.window;
        } else {
          globalThis.window = prevWindow;
        }
        if (prevDocument === undefined) {
          delete globalThis.document;
        } else {
          globalThis.document = prevDocument;
        }
      }
    },
    locator(selector) {
      return {
        first() {
          return {
            async isVisible() {
              return selector !== 'input[type="email"]' && selector !== 'input[type="password"]';
            },
            async boundingBox() {
              return { x: 100, y: 200, width: 80, height: 32 };
            },
            async click() {
              bodyText += ` [clicked:${selector}]`;
            },
            async fill(val) {
              bodyText += ` [filled:${val}]`;
            },
            async waitFor() {
              return true;
            },
          };
        },
      };
    },
    mouse: {
      async move() {},
      async down() {},
      async up() {},
      async click() {},
    },
    keyboard: {
      async press() {},
    },
    url() {
      return currentUrl;
    },
  };
}

describe('op-snippet formatter', () => {
  it('normalizes service aliases cleanly', () => {
    assert.equal(normalizeServiceName('rtdb'), 'database');
    assert.equal(normalizeServiceName('database'), 'database');
    assert.equal(normalizeServiceName('firestore'), 'firestore');
    assert.equal(normalizeServiceName('storage'), 'storage');
    assert.equal(normalizeServiceName('auth'), 'auth');
  });

  it('formats modular RTDB set, update, and remove snippets', () => {
    const setSnippet = formatSdkSnippet({
      service: 'rtdb',
      method: 'set',
      path: '/channels/general/messages/msg_1',
      data: { text: 'hello' },
    });
    assert.equal(
      setSnippet,
      'await set(ref(db, "/channels/general/messages/msg_1"), {\n  text: "hello"\n});',
    );

    const updateSnippet = formatSdkSnippet({
      service: 'database',
      method: 'update',
      path: 'presence/alice',
      data: { status: 'offline' },
    });
    assert.equal(
      updateSnippet,
      'await update(ref(db, "/presence/alice"), {\n  status: "offline"\n});',
    );

    const removeSnippet = formatSdkSnippet({
      service: 'rtdb',
      method: 'remove',
      path: '/presence/alice',
    });
    assert.equal(removeSnippet, 'await remove(ref(db, "/presence/alice"));');
  });

  it('formats modular Firestore setDoc, updateDoc, and deleteDoc snippets', () => {
    const setDocSnippet = formatSdkSnippet({
      service: 'firestore',
      method: 'setDoc',
      path: 'boards/b1/cards/c1',
      data: { title: 'Audit rules', priority: 1 },
    });
    assert.equal(
      setDocSnippet,
      'await setDoc(doc(db, "boards/b1/cards/c1"), {\n  title: "Audit rules",\n  priority: 1\n});',
    );

    const updateDocSnippet = formatSdkSnippet({
      service: 'firestore',
      method: 'update',
      collection: 'boards/b1/cards',
      doc: 'c1',
      data: { title: 'Fixed' },
    });
    assert.equal(
      updateDocSnippet,
      'await updateDoc(doc(db, "boards/b1/cards/c1"), {\n  title: "Fixed"\n});',
    );

    const deleteDocSnippet = formatSdkSnippet({
      service: 'firestore',
      method: 'delete',
      path: 'boards/b1/cards/c1',
    });
    assert.equal(deleteDocSnippet, 'await deleteDoc(doc(db, "boards/b1/cards/c1"));');
  });

  it('formats modular Storage uploadBytes snippet', () => {
    const uploadSnippet = formatSdkSnippet({
      service: 'storage',
      method: 'uploadBytes',
      path: 'uploads/a.txt',
      contentType: 'text/plain',
    });
    assert.equal(
      uploadSnippet,
      'await uploadBytes(ref(storage, "uploads/a.txt"), file, {\n  contentType: "text/plain"\n});',
    );
  });
});

describe('createSingleFlightRunner coalescing and ordering', () => {
  it('coalesces 50 rapid calls while a 20ms write is in flight without overlapping and flushes final value', async () => {
    const runner = createSingleFlightRunner();
    let concurrent = 0;
    const executedSeqs = [];
    const writtenValues = [];

    const tasks = [];
    for (let i = 1; i <= 50; i += 1) {
      const value = `frame-${i}`;
      tasks.push(
        runner.enqueue(async ({ seq }) => {
          concurrent += 1;
          assert.equal(concurrent, 1, 'Writes must never overlap');
          executedSeqs.push(seq);
          await sleep(20);
          writtenValues.push(value);
          concurrent -= 1;
          return value;
        }),
      );
      await sleep(1);
    }

    const results = await Promise.all(tasks);
    await runner.flush();

    const stats = runner.stats();
    assert.equal(stats.maxConcurrent, 1);
    assert.equal(stats.enqueuedCount, 50);
    assert.ok(stats.executedCount < 50, `Expected coalescing, executed=${stats.executedCount}`);
    assert.equal(stats.executedCount + stats.droppedCount, 50);

    // Monotonic strictly increasing sequence numbers
    for (let i = 1; i < executedSeqs.length; i += 1) {
      assert.ok(
        executedSeqs[i] > executedSeqs[i - 1],
        `Expected monotonic seq, got ${executedSeqs[i - 1]} then ${executedSeqs[i]}`,
      );
    }

    // Final value from call #50 is guaranteed to be written last
    assert.equal(writtenValues[writtenValues.length - 1], 'frame-50');
    const lastResult = results[results.length - 1];
    assert.equal(lastResult.status, 'executed');
    assert.equal(lastResult.seq, 50);
    assert.equal(lastResult.value, 'frame-50');
  });
});

describe('IsolatedSandbox live Orbit integration & hygiene', () => {
  it('runs isolated multi-actor RTDB & Firestore ALLOW -> hot-reload rules -> DENY without touching projectDir/.pyric and cleans up completely', async () => {
    const execInfo = findPyricExecutable(ORBIT_EXAMPLE_DIR);
    assert.ok(execInfo, 'Pyric CLI executable must be discoverable in workspace');

    // Create a clean temp project without .pyric to verify non-mutation from scratch
    const cleanProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-clean-proj-'));
    fs.writeFileSync(
      path.join(cleanProjectDir, 'firebase.json'),
      JSON.stringify({ database: { rules: 'database.rules.json' } }),
    );
    fs.copyFileSync(
      path.join(ORBIT_EXAMPLE_DIR, 'database.rules.json'),
      path.join(cleanProjectDir, 'database.rules.json'),
    );
    const snapOutDir = path.join(os.tmpdir(), `pyric-snap-${Date.now()}`);
    const snapRes = createSnapshot({ projectDir: cleanProjectDir, outDir: snapOutDir });
    assert.equal(snapRes.exists, false);
    assert.equal(
      fs.existsSync(path.join(cleanProjectDir, '.pyric')),
      false,
      'createSnapshot must not create .pyric on an uninitialized project',
    );
    fs.rmSync(cleanProjectDir, { recursive: true, force: true });

    // Record baseline of Orbit example's .pyric directory before starting IsolatedSandbox
    const orbitPyricDir = path.join(ORBIT_EXAMPLE_DIR, '.pyric');
    const beforeOrbitPyricSnapshot = directoryMtimeSnapshot(orbitPyricDir);
    const beforeOrbitRulesContent = fs.readFileSync(
      path.join(ORBIT_EXAMPLE_DIR, 'database.rules.json'),
      'utf8',
    );

    const sandbox = await IsolatedSandbox.start({
      projectDir: ORBIT_EXAMPLE_DIR,
    });

    const tempSandboxDir = sandbox.tempDir;
    const childPid = sandbox.pid;
    let disposed = false;

    try {
      assert.ok(sandbox.url.startsWith('http://'), `Expected http URL, got ${sandbox.url}`);
      assert.ok(sandbox.instanceId, 'Expected non-empty instanceId');
      assert.ok(
        tempSandboxDir.includes('pyric-sandbox-'),
        `Expected isolated temp dir, got ${tempSandboxDir}`,
      );
      assert.equal(
        directoryMtimeSnapshot(orbitPyricDir),
        beforeOrbitPyricSnapshot,
        'IsolatedSandbox.start must NOT create or mutate projectDir/.pyric',
      );

      // Mint tokens for alice and mallory
      const aliceToken = await sandbox.mintCustomToken('alice', { role: 'member' });
      const malloryToken = await sandbox.mintCustomToken('mallory', { role: 'peer' });
      assert.equal(typeof aliceToken, 'string');
      assert.equal(typeof malloryToken, 'string');

      // Anonymous write to /presence/alice must be DENIED with 401
      const anonWrite = await sandbox.executeOperation({
        operation: {
          service: 'database',
          method: 'set',
          path: '/presence/alice',
          data: { status: 'anon' },
        },
        idToken: null,
      });
      assert.equal(anonWrite.decision, 'DENY');
      assert.equal(anonWrite.status, 401);

      // Seed initial presence state as alice
      const seedRes = await sandbox.executeOperation({
        operation: {
          service: 'database',
          method: 'set',
          path: '/presence/alice',
          data: { status: 'online', note: 'Legit status' },
        },
        idToken: aliceToken,
      });
      assert.equal(seedRes.decision, 'ALLOW');
      assert.equal(seedRes.status, 200);

      // Under open rule (".write": "auth != null"), mallory can overwrite /presence/alice
      const hijackRes = await sandbox.executeOperation({
        operation: {
          service: 'database',
          method: 'set',
          path: '/presence/alice',
          data: { status: 'hijacked', note: 'Written by mallory' },
        },
        idToken: malloryToken,
      });
      assert.equal(hijackRes.decision, 'ALLOW');
      assert.equal(hijackRes.status, 200);

      // Verify readState reflects mallory's mutation
      const stateAfterHijack = await sandbox.readState('database', '/presence/alice');
      assert.deepEqual(stateAfterHijack, {
        status: 'hijacked',
        note: 'Written by mallory',
      });

      // Hot-swap owner-only RTDB rule inside the isolated sandbox
      const hardenedRtdbRules = JSON.parse(beforeOrbitRulesContent);
      hardenedRtdbRules.rules.presence = {
        '.read': 'auth != null',
        $uid: {
          '.write': 'auth != null && auth.uid == $uid',
        },
      };

      const reloadStepRes = await executeStep({
        step: {
          kind: 'reload-rules',
          rtdbRules: hardenedRtdbRules,
        },
        sandbox,
      });
      assert.equal(reloadStepRes.ok, true);

      // Verify projectDir's original database.rules.json was NEVER touched
      assert.equal(
        fs.readFileSync(path.join(ORBIT_EXAMPLE_DIR, 'database.rules.json'), 'utf8'),
        beforeOrbitRulesContent,
      );

      // Subsequent write as mallory to /presence/alice must be DENIED (401/403)
      const blockedStep = await executeStep({
        step: {
          kind: 'sdk',
          actor: 'mallory',
          operation: {
            service: 'database',
            method: 'set',
            path: '/presence/alice',
            data: { status: 'hijacked-again' },
          },
        },
        actors: {
          alice: { uid: 'alice' },
          mallory: { uid: 'mallory' },
        },
        sandbox,
      });
      assert.equal(blockedStep.decision, 'DENY');
      assert.ok(
        blockedStep.status === 401 || blockedStep.status === 403,
        `Expected 401 or 403 on rule denial, got ${blockedStep.status}`,
      );
      assert.ok(blockedStep.error, 'Expected denial error message');

      // State must remain unchanged after mallory's blocked write
      const stateAfterBlock = await sandbox.readState('database', '/presence/alice');
      assert.deepEqual(stateAfterBlock, {
        status: 'hijacked',
        note: 'Written by mallory',
      });

      // Owner alice can still write to /presence/alice and get ALLOW
      const aliceRecovery = await sandbox.executeOperation({
        operation: {
          service: 'database',
          method: 'set',
          path: '/presence/alice',
          data: { status: 'online', note: 'Restored by alice' },
        },
        idToken: aliceToken,
      });
      assert.equal(aliceRecovery.decision, 'ALLOW');
      assert.equal(aliceRecovery.status, 200);

      // Denials log should record mallory's blocked attempt
      const denials = await sandbox.getDenials();
      assert.ok(denials.length >= 1, 'Expected at least one recorded rule denial');

      // Exercise Firestore write (Orbit's open /scenarios rule) + readState + hot-reload owner-only rule -> DENY
      const fsAllow = await sandbox.executeOperation({
        operation: {
          service: 'firestore',
          method: 'setDoc',
          path: 'scenarios/sc_1',
          data: { name: 'Design Sync', ownerId: 'alice' },
        },
        idToken: aliceToken,
      });
      assert.equal(fsAllow.decision, 'ALLOW');
      assert.equal(fsAllow.status, 200);
      const fsDoc = await sandbox.readState('firestore', 'scenarios/sc_1');
      assert.deepEqual(fsDoc, { name: 'Design Sync', ownerId: 'alice' });

      await sandbox.updateRules({
        firestoreRules: [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /scenarios/{scId} {',
          '      allow read: if request.auth != null;',
          '      allow write: if request.auth != null && resource.data.ownerId == request.auth.uid;',
          '    }',
          '  }',
          '}',
        ].join('\n'),
      });

      const fsDeny = await sandbox.executeOperation({
        operation: {
          service: 'firestore',
          method: 'updateDoc',
          path: 'scenarios/sc_1',
          data: { ownerId: 'mallory' },
        },
        idToken: malloryToken,
      });
      assert.equal(fsDeny.decision, 'DENY');
      assert.equal(fsDeny.status, 403);

      // Exercise continuous 60Hz SDK stream routed through single-flight coalescing
      const streamEvents = [];
      const streamResult = await executeStep({
        step: {
          kind: 'sdk',
          actor: 'alice',
          rateHz: 60,
          operation: {
            service: 'database',
            method: 'set',
            path: '/typing/alice',
          },
          frames: Array.from({ length: 12 }, (_, idx) => ({
            active: true,
            cursor: idx + 1,
          })),
        },
        actors: { alice: { uid: 'alice' } },
        sandbox,
        onEvent: (evt) => streamEvents.push(evt),
      });
      assert.equal(streamResult.kind, 'sdk');
      assert.equal(streamResult.stats.maxConcurrent, 1);
      assert.ok(streamEvents.length >= 1);
      assert.equal(streamEvents[streamEvents.length - 1].decision, 'ALLOW');
      const finalTyping = await sandbox.readState('database', '/typing/alice');
      assert.equal(finalTyping.cursor, 12);

      // Test identity + UI + wait-expect steps with mock Playwright page
      const mockPage = createMockPlaywrightPage();
      const signedIn = await signInActorPage({
        page: mockPage,
        sandbox,
        actor: { uid: 'alice', view: '/?channel=general' },
      });
      assert.equal(signedIn.uid, 'alice');
      assert.equal(signedIn.strategy, 'auth-lens');
      assert.ok(signedIn.url.includes('channel=general'));
      assert.equal(mockPage.reloadCount, 0);
      assert.equal(
        mockPage.localStorageMap.get('pyric:serve:auth-session'),
        JSON.stringify({ uid: 'alice' }),
      );

      await executeStep({
        step: {
          kind: 'ui',
          actor: 'alice',
          action: 'click',
          selector: 'button#send-status',
          showActions: true,
        },
        actorPages: { alice: mockPage },
        sandbox,
      });
      assert.ok(mockPage.cursorMoves.length >= 1, 'Expected synthetic cursor indicator update');

      await executeStep({
        step: {
          kind: 'wait-expect',
          actor: 'alice',
          text: '[clicked:button#send-status]',
          notText: 'Hijacked by mallory',
          timeoutMs: 1000,
        },
        actorPages: { alice: mockPage },
        sandbox,
      });

      // Dispose and verify complete cleanup
      await sandbox.dispose();
      disposed = true;

      assert.equal(
        fs.existsSync(tempSandboxDir),
        false,
        `Expected temp sandbox dir ${tempSandboxDir} to be removed on dispose`,
      );
      assert.equal(
        directoryMtimeSnapshot(orbitPyricDir),
        beforeOrbitPyricSnapshot,
        'projectDir/.pyric must remain completely untouched after dispose',
      );

      if (childPid) {
        let processStillAlive = false;
        try {
          process.kill(childPid, 0);
          processStillAlive = true;
        } catch {
          processStillAlive = false;
        }
        assert.equal(processStillAlive, false, `Expected child PID ${childPid} to have exited`);
      }
    } finally {
      if (!disposed) {
        await sandbox.dispose();
      }
    }
  });
});
