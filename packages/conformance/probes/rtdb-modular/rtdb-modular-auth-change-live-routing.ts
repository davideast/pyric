import type { Database, DataSnapshot } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount } from '../../src/oracle-credential.ts';
import {
  sanitizeOracleCustomUid,
  signInOracleClientAuth,
} from '../../src/oracle-run-auth-session.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export const AUTH_CHANGE_LIVE_ROUTING_RUN_RULES: Record<string, unknown> = {
  public: {
    '.read': true,
    '.write': true,
  },
  authed: {
    '.read': 'auth != null',
    '.write': 'auth != null',
  },
  marker: {
    '.read': true,
    '.write': true,
  },
  users: {
    $uid: {
      '.read': 'auth != null && auth.uid === $uid',
      '.write': 'auth != null && auth.uid === $uid',
    },
  },
};

export interface AuthChangeOpOutcome {
  ok: boolean;
  errorName: string | null;
  code: string | null;
}

export interface AuthChangeReadOutcome extends AuthChangeOpOutcome {
  val: unknown;
}

export interface AuthChangeProbeSubject {
  db: Database;
  basePath: string;
  aliceUid: string;
  bobUid: string;
  ref: typeof import('firebase/database').ref;
  get: typeof import('firebase/database').get;
  set: typeof import('firebase/database').set;
  onValue: typeof import('firebase/database').onValue;
  onChildAdded: typeof import('firebase/database').onChildAdded;
  seedAdminData(subpath: string, value: unknown): Promise<void>;
  signInAs(role: 'alice' | 'bob'): Promise<void>;
  signOut(): Promise<void>;
}

function extractErrorCode(err: unknown): { errorName: string; code: string | null } {
  let errorName: string = typeof err;
  if (err instanceof Error) {
    errorName = err.name;
  }
  let code: string | null;
  code = null;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
  }
  return { errorName, code };
}

async function captureWrite(invoke: () => Promise<unknown>): Promise<AuthChangeOpOutcome> {
  try {
    await invoke();
    return { ok: true, errorName: null, code: null };
  } catch (err) {
    const { errorName, code } = extractErrorCode(err);
    return { ok: false, errorName, code };
  }
}

async function captureRead(invoke: () => Promise<DataSnapshot>): Promise<AuthChangeReadOutcome> {
  try {
    const snap = await invoke();
    return { ok: true, errorName: null, code: null, val: snap.val() };
  } catch (err) {
    const { errorName, code } = extractErrorCode(err);
    return { ok: false, errorName, code, val: null };
  }
}

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCondition(
  label: string,
  predicate: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export async function observeAuthChangeLiveRouting(subject: AuthChangeProbeSubject): Promise<{
  initialSignedOut: {
    readAuthed: AuthChangeReadOutcome;
    writeAuthed: AuthChangeOpOutcome;
    readPublic: AuthChangeReadOutcome;
    initialPublicValues: unknown[];
    initialPublicChildren: string[];
  };
  afterSignInAlice: {
    spuriousPublicValueDeliveries: number;
    spuriousPublicChildDeliveries: number;
    writeAliceOwn: AuthChangeOpOutcome;
    writeBobOther: AuthChangeOpOutcome;
    readAuthed: AuthChangeReadOutcome;
    initialAuthedValues: unknown[];
    initialAuthedChildren: string[];
    initialAliceOwnValues: unknown[];
  };
  afterSwitchToBob: {
    aliceOwnCancelCodes: Array<string | null>;
    spuriousPublicValueDeliveries: number;
    spuriousPublicChildDeliveries: number;
    spuriousAuthedValueDeliveries: number;
    spuriousAuthedChildDeliveries: number;
    writeBobOwn: AuthChangeOpOutcome;
    writeAliceOther: AuthChangeOpOutcome;
    readBobOwn: AuthChangeReadOutcome;
    readAliceOther: AuthChangeReadOutcome;
    authedWriteVisibleToSurvivingListeners: {
      authedValues: unknown[];
      authedChildren: string[];
    };
  };
  afterSignOut: {
    authedValueCancelCodes: Array<string | null>;
    authedChildCancelCodes: Array<string | null>;
    spuriousPublicValueDeliveries: number;
    spuriousPublicChildDeliveries: number;
    writeAuthedDenied: AuthChangeOpOutcome;
    readAuthedDenied: AuthChangeReadOutcome;
    publicWriteDeliveredToSurvivingListeners: {
      writeOutcome: AuthChangeOpOutcome;
      publicValues: unknown[];
      publicChildren: string[];
    };
  };
  afterReSignInAlice: {
    writeAuthedAllowed: AuthChangeOpOutcome;
    writeAliceOwnAllowed: AuthChangeOpOutcome;
    readAuthedAllowed: AuthChangeReadOutcome;
    cancelledAuthedValueCountUnchanged: boolean;
    cancelledAuthedChildCountUnchanged: boolean;
    cancelledAliceOwnValueCountUnchanged: boolean;
  };
}> {
  const { db, aliceUid, bobUid, ref, get, set, onValue, onChildAdded } = subject;
  const cleanBase = subject.basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase.length > 0) {
    prefix = `${cleanBase}/`;
  }

  await subject.seedAdminData('public', { a: 1 });
  await subject.seedAdminData('authed', { seed: 10 });
  await subject.seedAdminData('marker', { step: 0 });
  await subject.signOut();
  await yieldMacrotask();

  const unsubs: Array<() => void> = [];
  let latestMarkerStep = -1;
  let markerSeq = 0;

  try {
    const markerRef = ref(db, `${prefix}marker`);
    unsubs.push(
      onValue(markerRef, (snap) => {
        const val = snap.val() as { step?: unknown } | null;
        if (val !== null && typeof val === 'object' && typeof val.step === 'number') {
          latestMarkerStep = val.step;
        }
      }),
    );
    await waitForCondition('initial marker listener step 0', () => latestMarkerStep === 0);

    const flushWireBarrier = async (label: string): Promise<void> => {
      markerSeq += 1;
      const targetStep = markerSeq;
      await set(markerRef, { step: targetStep });
      await waitForCondition(`wire barrier (${label})`, () => latestMarkerStep === targetStep);
    };

    await flushWireBarrier('initial-signed-out');

    const publicRef = ref(db, `${prefix}public`);
    const authedRef = ref(db, `${prefix}authed`);
    const aliceRef = ref(db, `${prefix}users/${aliceUid}`);
    const bobRef = ref(db, `${prefix}users/${bobUid}`);

    const publicValues: unknown[] = [];
    const publicChildren: string[] = [];
    unsubs.push(
      onValue(publicRef, (snap) => {
        publicValues.push(snap.val());
      }),
    );
    unsubs.push(
      onChildAdded(publicRef, (snap) => {
        publicChildren.push(`${String(snap.key)}:${JSON.stringify(snap.val())}`);
      }),
    );
    await waitForCondition(
      'initial public value and child listeners',
      () => publicValues.length >= 1 && publicChildren.length >= 1,
    );

    const initialSignedOutReadAuthed = await captureRead(() => get(authedRef));
    const initialSignedOutWriteAuthed = await captureWrite(() =>
      set(ref(db, `${prefix}authed/attempt`), 1),
    );
    const initialSignedOutReadPublic = await captureRead(() => get(publicRef));
    const initialPublicValues = [...publicValues];
    const initialPublicChildren = [...publicChildren];

    // Transition 1: signedOut -> alice on the same Database handle without re-binding.
    const pubValBeforeAlice = publicValues.length;
    const pubChildBeforeAlice = publicChildren.length;
    await subject.signInAs('alice');
    await yieldMacrotask();
    await flushWireBarrier('after-signin-alice');
    const spuriousPublicValAlice = publicValues.length - pubValBeforeAlice;
    const spuriousPublicChildAlice = publicChildren.length - pubChildBeforeAlice;

    const writeAliceOwn = await captureWrite(() => set(aliceRef, { role: 'owner' }));
    const writeBobOther = await captureWrite(() => set(bobRef, { role: 'intruder' }));
    const aliceReadAuthed = await captureRead(() => get(authedRef));

    const authedValues: unknown[] = [];
    const authedChildren: string[] = [];
    const authedValueCancelCodes: Array<string | null> = [];
    const authedChildCancelCodes: Array<string | null> = [];
    const aliceOwnValues: unknown[] = [];
    const aliceOwnCancelCodes: Array<string | null> = [];

    unsubs.push(
      onValue(
        authedRef,
        (snap) => {
          authedValues.push(snap.val());
        },
        (err) => {
          authedValueCancelCodes.push(extractErrorCode(err).code);
        },
      ),
    );
    unsubs.push(
      onChildAdded(
        authedRef,
        (snap) => {
          authedChildren.push(`${String(snap.key)}:${JSON.stringify(snap.val())}`);
        },
        (err) => {
          authedChildCancelCodes.push(extractErrorCode(err).code);
        },
      ),
    );
    unsubs.push(
      onValue(
        aliceRef,
        (snap) => {
          aliceOwnValues.push(snap.val());
        },
        (err) => {
          aliceOwnCancelCodes.push(extractErrorCode(err).code);
        },
      ),
    );
    await waitForCondition(
      'initial authed and alice-own listeners',
      () =>
        authedValues.length >= 1
        && authedChildren.length >= 1
        && aliceOwnValues.length >= 1,
    );
    const initialAuthedValues = [...authedValues];
    const initialAuthedChildren = [...authedChildren];
    const initialAliceOwnValues = [...aliceOwnValues];

    // Transition 2: uninterrupted alice -> bob on the same Database handle (no mid-sequence signOut/deleteUser).
    const pubValBeforeBob = publicValues.length;
    const pubChildBeforeBob = publicChildren.length;
    const authValBeforeBob = authedValues.length;
    const authChildBeforeBob = authedChildren.length;
    await subject.signInAs('bob');
    await yieldMacrotask();
    await waitForCondition(
      'alice-own listener cancels on direct alice -> bob switch',
      () => aliceOwnCancelCodes.length >= 1,
    );
    await flushWireBarrier('after-switch-bob');

    const aliceOwnValCountAtCancel = aliceOwnValues.length;
    const spuriousPublicValBob = publicValues.length - pubValBeforeBob;
    const spuriousPublicChildBob = publicChildren.length - pubChildBeforeBob;
    const spuriousAuthedValBob = authedValues.length - authValBeforeBob;
    const spuriousAuthedChildBob = authedChildren.length - authChildBeforeBob;

    const writeBobOwn = await captureWrite(() => set(bobRef, { role: 'member' }));
    const writeAliceOther = await captureWrite(() => set(aliceRef, { role: 'overwrite' }));
    const readBobOwn = await captureRead(() => get(bobRef));
    const readAliceOther = await captureRead(() => get(aliceRef));

    await set(ref(db, `${prefix}authed/fromBob`), 20);
    await waitForCondition(
      'surviving authed listeners receive bob write',
      () => authedValues.length >= 2 && authedChildren.length >= 2,
    );
    const authedValuesAfterBobWrite = [...authedValues];
    const authedChildrenAfterBobWrite = [...authedChildren];

    // Transition 3: bob -> signedOut; authed listeners cancel while public listeners stay silent and live.
    const pubValBeforeSignOut = publicValues.length;
    const pubChildBeforeSignOut = publicChildren.length;
    await subject.signOut();
    await yieldMacrotask();
    await waitForCondition(
      'authed listeners cancel on signOut',
      () => authedValueCancelCodes.length >= 1 && authedChildCancelCodes.length >= 1,
    );
    await flushWireBarrier('after-signout');

    const spuriousPublicValSignOut = publicValues.length - pubValBeforeSignOut;
    const spuriousPublicChildSignOut = publicChildren.length - pubChildBeforeSignOut;
    const authedValCountAtCancel = authedValues.length;
    const authedChildCountAtCancel = authedChildren.length;

    const writeAuthedDenied = await captureWrite(() => set(ref(db, `${prefix}authed/denied`), 99));
    const readAuthedDenied = await captureRead(() => get(authedRef));

    const publicWriteOutcome = await captureWrite(() => set(ref(db, `${prefix}public/b`), 2));
    await waitForCondition(
      'surviving public listeners receive signed-out public write',
      () => publicValues.length > pubValBeforeSignOut && publicChildren.length > pubChildBeforeSignOut,
    );
    const publicValuesAfterWrite = [...publicValues];
    const publicChildrenAfterWrite = [...publicChildren];

    // Transition 4: signedOut -> alice; cancelled authed and alice-own listeners must not resurrect.
    await subject.signInAs('alice');
    await yieldMacrotask();
    await flushWireBarrier('after-resignin-alice');
    const writeAuthedAllowed = await captureWrite(() => set(ref(db, `${prefix}authed/reauthed`), 30));
    const writeAliceOwnAllowed = await captureWrite(() => set(aliceRef, { role: 'owner-v2' }));
    const readAuthedAllowed = await captureRead(() => get(authedRef));
    await flushWireBarrier('after-reauthed-write');

    return {
      initialSignedOut: {
        readAuthed: initialSignedOutReadAuthed,
        writeAuthed: initialSignedOutWriteAuthed,
        readPublic: initialSignedOutReadPublic,
        initialPublicValues,
        initialPublicChildren,
      },
      afterSignInAlice: {
        spuriousPublicValueDeliveries: spuriousPublicValAlice,
        spuriousPublicChildDeliveries: spuriousPublicChildAlice,
        writeAliceOwn,
        writeBobOther,
        readAuthed: aliceReadAuthed,
        initialAuthedValues,
        initialAuthedChildren,
        initialAliceOwnValues,
      },
      afterSwitchToBob: {
        aliceOwnCancelCodes: [...aliceOwnCancelCodes],
        spuriousPublicValueDeliveries: spuriousPublicValBob,
        spuriousPublicChildDeliveries: spuriousPublicChildBob,
        spuriousAuthedValueDeliveries: spuriousAuthedValBob,
        spuriousAuthedChildDeliveries: spuriousAuthedChildBob,
        writeBobOwn,
        writeAliceOther,
        readBobOwn,
        readAliceOther,
        authedWriteVisibleToSurvivingListeners: {
          authedValues: authedValuesAfterBobWrite,
          authedChildren: authedChildrenAfterBobWrite,
        },
      },
      afterSignOut: {
        authedValueCancelCodes: [...authedValueCancelCodes],
        authedChildCancelCodes: [...authedChildCancelCodes],
        spuriousPublicValueDeliveries: spuriousPublicValSignOut,
        spuriousPublicChildDeliveries: spuriousPublicChildSignOut,
        writeAuthedDenied,
        readAuthedDenied,
        publicWriteDeliveredToSurvivingListeners: {
          writeOutcome: publicWriteOutcome,
          publicValues: publicValuesAfterWrite,
          publicChildren: publicChildrenAfterWrite,
        },
      },
      afterReSignInAlice: {
        writeAuthedAllowed,
        writeAliceOwnAllowed,
        readAuthedAllowed,
        cancelledAuthedValueCountUnchanged: authedValues.length === authedValCountAtCancel,
        cancelledAuthedChildCountUnchanged: authedChildren.length === authedChildCountAtCancel,
        cancelledAliceOwnValueCountUnchanged: aliceOwnValues.length === aliceOwnValCountAtCancel,
      },
    };
  } finally {
    for (const unsub of unsubs) {
      unsub();
    }
  }
}

export type AuthChangeLiveRoutingObservation = Awaited<
  ReturnType<typeof observeAuthChangeLiveRouting>
>;

/**
 * Upstream `firebase/database` 12.19.0 cold `"g"`-wire `PersistentConnection.get`
 * rejects rules-denied `get()` with `Error("Permission denied")` (`code: null`),
 * whereas Pyric's `get()` sets `code: "PERMISSION_DENIED"` per `rtdb-modular#110`
 * (`rtdb-rules-denied-error-code`). Normalize only the three denied-read `code`
 * slots after explicitly asserting both shapes in replay suites.
 */
export function withDeniedGetCode(
  observed: AuthChangeLiveRoutingObservation,
  deniedReadCode: string | null,
): AuthChangeLiveRoutingObservation {
  return {
    ...observed,
    initialSignedOut: {
      ...observed.initialSignedOut,
      readAuthed: { ...observed.initialSignedOut.readAuthed, code: deniedReadCode },
    },
    afterSwitchToBob: {
      ...observed.afterSwitchToBob,
      readAliceOther: { ...observed.afterSwitchToBob.readAliceOther, code: deniedReadCode },
    },
    afterSignOut: {
      ...observed.afterSignOut,
      readAuthedDenied: { ...observed.afterSignOut.readAuthedDenied, code: deniedReadCode },
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  matrixRow: 'rtdb-modular#M38',
  rowIds: ['rtdb-modular#M38'],
  description:
    'Live firebase/auth custom-token sign-in, uninterrupted user switch, and sign-out routing on a single getDatabase(app) handle without re-binding: immediate next-op auth.uid enforcement, zero spurious deliveries on readable onValue/onChildAdded listeners, and permanent PERMISSION_DENIED cancellation without resurrection across user-scoped and auth-gated paths.',
  observe() {
    return withRtdbProbeSession(
      { runRules: AUTH_CHANGE_LIVE_ROUTING_RUN_RULES },
      async ({ runId, runPath, rtdbSdk, openClient, adminWrite }) => {
        const [{ deleteUser, getAuth, signOut }, sa] = await Promise.all([
          import('firebase/auth'),
          loadOracleServiceAccount(),
        ]);

        const actor = await openClient('actor');
        const actorAuth = getAuth(actor.app);
        const bootstrapHint = `sdk-rtdb-${runId}-actor`;
        const aliceHint = `rtdb-auth-change-${runId}-alice`;
        const bobHint = `rtdb-auth-change-${runId}-bob`;
        const aliceUid = sanitizeOracleCustomUid(aliceHint);
        const bobUid = sanitizeOracleCustomUid(bobHint);

        try {
          return await observeAuthChangeLiveRouting({
            db: actor.db,
            basePath: runPath,
            aliceUid,
            bobUid,
            ref: rtdbSdk.ref,
            get: rtdbSdk.get,
            set: rtdbSdk.set,
            onValue: rtdbSdk.onValue,
            onChildAdded: rtdbSdk.onChildAdded,
            seedAdminData: adminWrite,
            async signInAs(role) {
              let hint = bobHint;
              if (role === 'alice') {
                hint = aliceHint;
              }
              await signInOracleClientAuth(actorAuth, sa, hint);
            },
            async signOut() {
              await signOut(actorAuth);
            },
          });
        } finally {
          for (const hint of [bootstrapHint, aliceHint, bobHint]) {
            await signInOracleClientAuth(actorAuth, sa, hint).catch(() => undefined);
            if (actorAuth.currentUser) {
              await deleteUser(actorAuth.currentUser).catch(() => undefined);
            }
          }
        }
      },
    );
  },
};
