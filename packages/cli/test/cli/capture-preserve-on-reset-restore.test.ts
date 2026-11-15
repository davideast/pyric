import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBackend, initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { recordCheckpointBackend, saveCheckpoint } from 'pyric/sandbox/checkpoints';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { getAdminDatabase, getDatabase, ref as databaseRef, sandbox as rtdbSandbox, set as databaseSet } from 'pyric/database';
import { getActiveRules as getActiveDatabaseRules } from 'pyric/sandbox/database';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { createCaptureStore, CAPTURE_RELATIVE_PATH } from '../../src/serve/capture-store.js';
import { handleConnectionOp } from '../../src/serve/worker/host/connection.js';
import { exportStateBundle } from '../../src/serve/worker/host/state-transfer.js';
import { handleStudioOp } from '../../src/serve/worker/host/studio.js';
import type { HostCtx, PortLike } from '../../src/serve/worker/host-context.js';
import { createSurfaceContext } from '../../src/bridge/surface/context.js';
import checkpointMethod from '../../src/bridge/surface/methods/sandbox/checkpoint.js';
import restoreMethod from '../../src/bridge/surface/methods/sandbox/restore.js';
import resetMethod from '../../src/bridge/surface/methods/sandbox/reset.js';
import { buildVerifyFixture, type PyricVerifyFixture } from '../../src/verify/index.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerify } from '../../src/cli/verify.js';

const PREVIOUS_CAPTURE_RELATIVE_PATH = '.pyric/previous-session.json';

const STRICT_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if true;
      allow write: if request.resource.data.state != 'refused';
    }
  }
}`;

const LOOSE_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read, write: if true;
    }
  }
}`;

const STRICT_RTDB_RULES = {
  rules: {
    items: {
      $id: {
        '.read': true,
        '.write': "newData.val() != 'refused'",
      },
    },
  },
};

const LOOSE_RTDB_RULES = {
  rules: {
    items: {
      $id: {
        '.read': true,
        '.write': true,
      },
    },
  },
};

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-capture-preserve-'));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, 'firebase.json'),
    JSON.stringify({
      firestore: { rules: 'firestore.rules' },
      database: { rules: 'database.rules.json' },
    }),
  );
  writeFileSync(join(dir, 'firestore.rules'), STRICT_FIRESTORE_RULES);
  writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(STRICT_RTDB_RULES));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureJson(sandbox: LocalSandbox): string {
  const adminDb = getAdminDatabase(sandbox);
  const rtdbRules = getActiveDatabaseRules(adminDb) ?? STRICT_RTDB_RULES;
  const fixture = buildVerifyFixture({
    sandbox,
    firestoreRules: STRICT_FIRESTORE_RULES,
    rtdbRules,
    rtdbState: rtdbSandbox.snapshotState(adminDb, { includePriorities: true }),
    authState: {
      users: authSandbox.exportUsers(getAuth(sandbox)),
      currentUser: sandbox.currentUser,
    },
  });
  return JSON.stringify(fixture);
}

function deniedCountIn(fixture: PyricVerifyFixture): number {
  let denied = 0;
  for (const event of fixture.events) {
    if ('result' in event && event.result === 'deny') denied++;
  }
  return denied;
}

function decodeChunk(chunk: string | Uint8Array): string {
  if (typeof chunk === 'string') return chunk;
  return Buffer.from(chunk).toString('utf8');
}

async function runVerifyCaptured(dir: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const prevCwd = process.cwd();
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += decodeChunk(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err += decodeChunk(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.chdir(dir);
  try {
    const code = await runVerify(parseArgs(['verify', ...argv]));
    return { code, out, err };
  } finally {
    process.chdir(prevCwd);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

async function exerciseAllowedAndDeniedWrites(sandbox: LocalSandbox, itemKey: string): Promise<void> {
  const userSandbox = sandbox.withAuth({ uid: 'owner-1' });
  const fsDb = getFirestore(userSandbox);
  await setDoc(doc(fsDb, `items/${itemKey}`), { state: 'kept' });
  await setDoc(doc(fsDb, `items/${itemKey}`), { state: 'refused' }).catch(() => {});

  const rtdb = getDatabase(userSandbox);
  await databaseSet(databaseRef(rtdb, `items/${itemKey}`), 'kept');
  await databaseSet(databaseRef(rtdb, `items/${itemKey}`), 'refused').catch(() => {});
}

describe('preserve previous session capture across restore and reset', () => {
  it('rotates a non-empty capture to .pyric/previous-session.json on clearing flush and never clobbers it with an empty flush', async () => {
    const dir = makeTempProject();
    const sandbox = initializeSandbox();
    try {
      setFirestoreRules(sandbox, STRICT_FIRESTORE_RULES);
      rtdbSandbox.setRules(getAdminDatabase(sandbox), STRICT_RTDB_RULES);
      await exerciseAllowedAndDeniedWrites(sandbox, 'a');

      const store = createCaptureStore(dir);
      const nonEmptyBody = captureJson(sandbox);
      store.write(nonEmptyBody);

      sandbox.reset();
      const emptyBody = captureJson(sandbox);
      store.write(emptyBody);

      const previousPath = join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(existsSync(previousPath)).toBe(true);
      const previous = JSON.parse(readFileSync(previousPath, 'utf8')) as PyricVerifyFixture;
      expect(previous.events.length).toBeGreaterThan(0);
      expect(deniedCountIn(previous)).toBeGreaterThan(0);

      const active = JSON.parse(readFileSync(join(dir, CAPTURE_RELATIVE_PATH), 'utf8')) as PyricVerifyFixture;
      expect(active.events).toHaveLength(0);

      // A second empty flush must not overwrite the preserved non-empty capture.
      store.write(emptyBody);
      const stillPrevious = JSON.parse(readFileSync(previousPath, 'utf8')) as PyricVerifyFixture;
      expect(stillPrevious.events.length).toBe(previous.events.length);
      expect(deniedCountIn(stillPrevious)).toBe(deniedCountIn(previous));
    } finally {
      sandbox.dispose();
    }
  });

  it('preserves the denied write on sandbox restore, reports it in the result, and flags empty captures in pyric verify', async () => {
    const dir = makeTempProject();
    const sandbox = initializeSandbox();
    try {
      setFirestoreRules(sandbox, STRICT_FIRESTORE_RULES);
      rtdbSandbox.setRules(getAdminDatabase(sandbox), STRICT_RTDB_RULES);
      const ctx = createSurfaceContext(sandbox, dir);
      const store = createCaptureStore(dir);

      await exerciseAllowedAndDeniedWrites(sandbox, 'a');
      const cp = await checkpointMethod.handler({ name: 'c1' }, ctx);
      expect(cp.ok).toBe(true);

      await exerciseAllowedAndDeniedWrites(sandbox, 'b');
      const preRestoreEvents = sandbox.history().length;
      const preRestoreDenials = sandbox.history().filter((e) => 'result' in e && e.result === 'deny').length;
      expect(preRestoreDenials).toBeGreaterThanOrEqual(4);
      store.write(captureJson(sandbox));

      const restored = await restoreMethod.handler({ name: 'c1', confirm: true }, ctx);
      expect(restored.ok).toBe(true);
      expect(restored.summary).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(restored.summary).toContain(String(preRestoreEvents));
      expect(restored.summary).toContain(String(preRestoreDenials));

      // Simulate the host debounce posting the emptied post-restore capture.
      store.write(captureJson(sandbox));

      const previousPath = join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(existsSync(previousPath)).toBe(true);
      const previous = JSON.parse(readFileSync(previousPath, 'utf8')) as PyricVerifyFixture;
      expect(deniedCountIn(previous)).toBe(preRestoreDenials);

      const emptyVerify = await runVerifyCaptured(dir, []);
      expect(emptyVerify.code).toBe(0);
      expect(emptyVerify.out).toMatch(/no operations/i);
      expect(emptyVerify.out).not.toContain('all selected services replay cleanly');
      expect(emptyVerify.out).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);

      // Explicit `.pyric/last-session.json` target and `--json` output also expose previousCapture.
      const explicitVerify = await runVerifyCaptured(dir, [CAPTURE_RELATIVE_PATH]);
      expect(explicitVerify.code).toBe(0);
      expect(explicitVerify.out).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);

      const jsonVerify = await runVerifyCaptured(dir, ['--json']);
      expect(jsonVerify.code).toBe(0);
      const jsonPayload = JSON.parse(jsonVerify.out) as {
        empty?: boolean;
        previousCapture?: { path: string; eventCount: number; denialCount: number };
      };
      expect(jsonPayload.empty).toBe(true);
      expect(jsonPayload.previousCapture?.path).toBe(PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(jsonPayload.previousCapture?.denialCount).toBe(preRestoreDenials);

      // Verifying the preserved capture still replays cleanly under strict rules.
      const prevClean = await runVerifyCaptured(dir, [PREVIOUS_CAPTURE_RELATIVE_PATH]);
      expect(prevClean.code).toBe(0);
      expect(prevClean.out).toContain('all selected services replay cleanly');

      // When .pyric/last-session.json is absent, pyric verify points to previous-session.json.
      unlinkSync(join(dir, CAPTURE_RELATIVE_PATH));
      const missingActive = await runVerifyCaptured(dir, []);
      expect(missingActive.code).toBe(2);
      expect(missingActive.err).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);

      // Loosening rules so previously denied writes now pass must fail verification.
      writeFileSync(join(dir, 'firestore.rules'), LOOSE_FIRESTORE_RULES);
      writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(LOOSE_RTDB_RULES));
      const prevRegressed = await runVerifyCaptured(dir, [PREVIOUS_CAPTURE_RELATIVE_PATH]);
      expect(prevRegressed.code).toBe(1);
    } finally {
      sandbox.dispose();
    }
  });

  it('prefers current live events over a larger stale disk capture on standalone restore and preserves named RTDB instances', async () => {
    const dir = makeTempProject();
    const sandbox = initializeSandbox();
    try {
      setFirestoreRules(sandbox, STRICT_FIRESTORE_RULES);
      rtdbSandbox.setRules(getAdminDatabase(sandbox), STRICT_RTDB_RULES);
      const namedAdminDb = getAdminDatabase(sandbox, 'secondary-db');
      rtdbSandbox.setRules(namedAdminDb, STRICT_RTDB_RULES);
      await databaseSet(databaseRef(namedAdminDb, 'items/seed'), 'ok');
      const ctx = createSurfaceContext(sandbox, dir);
      const store = createCaptureStore(dir);

      const cp = await checkpointMethod.handler({ name: 'c1' }, ctx);
      expect(cp.ok).toBe(true);

      // Plant an unrelated stale capture on disk with more events than live history.
      const staleEvents = Array.from({ length: 20 }, (_, i) => ({
        id: `stale-${i}`,
        at: i + 1,
        service: 'firestore',
        method: 'setDoc',
        path: `stale/${i}`,
        result: 'allow',
      }));
      store.write(
        JSON.stringify({
          schema: 'pyric.verify.fixture.v1',
          createdAt: '2026-01-01T00:00:00.000Z',
          events: staleEvents,
          services: {},
        }),
      );

      await exerciseAllowedAndDeniedWrites(sandbox, 'live');
      const liveEvents = sandbox.history();
      const liveDenials = liveEvents.filter((e) => 'result' in e && e.result === 'deny').length;
      expect(liveEvents.length).toBeLessThan(staleEvents.length);
      expect(liveDenials).toBeGreaterThanOrEqual(2);

      const restored = await restoreMethod.handler({ name: 'c1', confirm: true }, ctx);
      expect(restored.ok).toBe(true);
      expect(restored.summary).toContain(String(liveEvents.length));

      const previous = JSON.parse(
        readFileSync(join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH), 'utf8'),
      ) as PyricVerifyFixture;
      expect(previous.events.length).toBe(liveEvents.length);
      expect(deniedCountIn(previous)).toBe(liveDenials);
      expect(previous.capturedBy).toBe('sandbox-restore');
      expect(previous.services.rtdb?.instances?.['secondary-db']).toBeDefined();
    } finally {
      sandbox.dispose();
    }
  });

  it('omits false preservation claims on standalone in-process reset while captureStore rotates clearing flushes', async () => {
    const dir = makeTempProject();
    const sandbox = initializeSandbox();
    try {
      setFirestoreRules(sandbox, STRICT_FIRESTORE_RULES);
      rtdbSandbox.setRules(getAdminDatabase(sandbox), STRICT_RTDB_RULES);
      const ctx = createSurfaceContext(sandbox, dir);
      const store = createCaptureStore(dir);

      await exerciseAllowedAndDeniedWrites(sandbox, 'a');
      const preResetDenials = sandbox.history().filter((e) => 'result' in e && e.result === 'deny').length;
      expect(preResetDenials).toBeGreaterThanOrEqual(2);
      store.write(captureJson(sandbox));

      const firstReset = await resetMethod.handler({ confirm: true, scope: 'all' }, ctx);
      expect(firstReset.ok).toBe(true);
      // Standalone sandbox-side reset does not write disk itself, so it makes no false preservation claim.
      expect(firstReset.summary).not.toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);

      // Host flushes the emptied capture after reset.
      store.write(captureJson(sandbox));

      const previousPath = join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(existsSync(previousPath)).toBe(true);
      const previous = JSON.parse(readFileSync(previousPath, 'utf8')) as PyricVerifyFixture;
      expect(deniedCountIn(previous)).toBe(preResetDenials);

      // A second reset with zero events must not erase the preserved previous capture.
      const secondReset = await resetMethod.handler({ confirm: true, scope: 'all' }, ctx);
      expect(secondReset.ok).toBe(true);
      store.write(captureJson(sandbox));
      const afterSecondReset = JSON.parse(readFileSync(previousPath, 'utf8')) as PyricVerifyFixture;
      expect(deniedCountIn(afterSecondReset)).toBe(preResetDenials);

      const emptyVerify = await runVerifyCaptured(dir, []);
      expect(emptyVerify.code).toBe(0);
      expect(emptyVerify.out).toMatch(/no operations/i);

      const prevClean = await runVerifyCaptured(dir, [PREVIOUS_CAPTURE_RELATIVE_PATH]);
      expect(prevClean.code).toBe(0);
    } finally {
      sandbox.dispose();
    }
  });

  it('flushes pre-reset events in Studio resetAll before clearing so fast resets rotate to previous-session.json', async () => {
    const dir = makeTempProject();
    const sandbox = initializeSandbox();
    try {
      setFirestoreRules(sandbox, STRICT_FIRESTORE_RULES);
      rtdbSandbox.setRules(getAdminDatabase(sandbox), STRICT_RTDB_RULES);
      await exerciseAllowedAndDeniedWrites(sandbox, 'fast');

      // Intentionally do not write to captureStore yet (simulates reset before 400ms debounce).
      const store = createCaptureStore(dir);
      const replies: unknown[] = [];
      const port: PortLike = {
        postMessage(message: unknown) {
          replies.push(message);
        },
      };
      const hostCtx: HostCtx = {
        sandbox,
        db: getFirestore(sandbox),
        instanceId: 'studio-reset-test',
        subs: new Map(),
        captureFlush: async () => {
          store.write(captureJson(sandbox));
        },
      };

      await handleStudioOp(hostCtx, port, { t: 'op', id: 'reset-1', method: 'resetAll' });

      const previousPath = join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH);
      expect(existsSync(previousPath)).toBe(true);
      const previous = JSON.parse(readFileSync(previousPath, 'utf8')) as PyricVerifyFixture;
      expect(deniedCountIn(previous)).toBeGreaterThanOrEqual(2);
      const active = JSON.parse(readFileSync(join(dir, CAPTURE_RELATIVE_PATH), 'utf8')) as PyricVerifyFixture;
      expect(active.events).toHaveLength(0);
    } finally {
      sandbox.dispose();
    }
  });

  it('flushes pre-clear captures in worker connection restore and importState before clearing', async () => {
    const dir = makeTempProject();
    const sandbox = initializeSandbox();
    try {
      setFirestoreRules(sandbox, STRICT_FIRESTORE_RULES);
      rtdbSandbox.setRules(getAdminDatabase(sandbox), STRICT_RTDB_RULES);
      const checkpointBackend = recordCheckpointBackend(createMemoryBackend());
      await saveCheckpoint(checkpointBackend, 'c1', sandbox);
      const exportedBundle = await exportStateBundle(sandbox);

      const store = createCaptureStore(dir);
      const replies: unknown[] = [];
      const port: PortLike = {
        postMessage(message: unknown) {
          replies.push(message);
        },
      };
      const hostCtx: HostCtx = {
        sandbox,
        db: getFirestore(sandbox),
        instanceId: 'worker-conn-test',
        subs: new Map(),
        checkpointBackend,
        captureFlush: async () => {
          store.write(captureJson(sandbox));
        },
      };

      // Exercise writes without pre-flushing captureStore (inside 400ms debounce).
      await exerciseAllowedAndDeniedWrites(sandbox, 'conn-restore');

      // Missing checkpoint must not clear or write previous-session.json.
      await handleConnectionOp(hostCtx, port, { t: 'op', id: 'r-missing', method: 'restore', name: 'missing' });
      expect(existsSync(join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH))).toBe(false);

      // Valid checkpoint restore rotates un-debounced events into previous-session.json.
      await handleConnectionOp(hostCtx, port, { t: 'op', id: 'r-ok', method: 'restore', name: 'c1' });
      const afterRestorePrev = JSON.parse(
        readFileSync(join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH), 'utf8'),
      ) as PyricVerifyFixture;
      expect(deniedCountIn(afterRestorePrev)).toBeGreaterThanOrEqual(2);
      const afterRestoreActive = JSON.parse(
        readFileSync(join(dir, CAPTURE_RELATIVE_PATH), 'utf8'),
      ) as PyricVerifyFixture;
      expect(afterRestoreActive.events).toHaveLength(0);

      // Exercise new writes and verify invalid importState does not rotate, then valid importState does.
      await exerciseAllowedAndDeniedWrites(sandbox, 'conn-import');
      const denialsBeforeImport = sandbox.history().filter((e) => 'result' in e && e.result === 'deny').length;
      await handleConnectionOp(hostCtx, port, { t: 'op', id: 'imp-bad', method: 'importState', bundle: '{bad-json' });
      expect(sandbox.history().length).toBeGreaterThan(0);

      await handleConnectionOp(hostCtx, port, {
        t: 'op',
        id: 'imp-ok',
        method: 'importState',
        bundle: exportedBundle,
      });
      const afterImportPrev = JSON.parse(
        readFileSync(join(dir, PREVIOUS_CAPTURE_RELATIVE_PATH), 'utf8'),
      ) as PyricVerifyFixture;
      expect(deniedCountIn(afterImportPrev)).toBe(denialsBeforeImport);
      const afterImportActive = JSON.parse(
        readFileSync(join(dir, CAPTURE_RELATIVE_PATH), 'utf8'),
      ) as PyricVerifyFixture;
      expect(afterImportActive.events).toHaveLength(0);
    } finally {
      sandbox.dispose();
    }
  });
});
