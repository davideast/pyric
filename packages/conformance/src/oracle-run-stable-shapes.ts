/**
 * Deterministic shape helpers for `packages/conformance/src/run.ts` probes so
 * live `oracle-run` captures record stable structural invariants instead of
 * per-run random UIDs, throwaway email timestamps, or wall-clock latencies.
 */

const FIREBASE_AUTH_UID_PATTERN = /^[A-Za-z0-9]{20,128}$/;
const ORACLE_PROBE_EMAIL_PATTERN = /^oracle-[a-z0-9-]+@oracle\.test$/i;

interface AuthUidShape {
  present: boolean;
  uidLength: number | null;
  uidMatchesPattern: boolean;
}

interface AuthFireShape {
  userSlot: number | null;
  uidLength: number | null;
  uidMatchesPattern: boolean;
}

interface FencedAuthFireShape extends AuthFireShape {
  fence: string;
}

interface AuthUserSlotTracker {
  describeSequence(fires: ReadonlyArray<{ uid: string | null }>): AuthFireShape[];
  describeFencedSequence(
    fires: ReadonlyArray<{ uid: string | null; fence: string }>,
  ): FencedAuthFireShape[];
}

export function isFirebaseAuthUid(uid: string | null | undefined): boolean {
  if (typeof uid !== 'string') {
    return false;
  }
  return FIREBASE_AUTH_UID_PATTERN.test(uid);
}

export function describeAuthUid(uid: string | null | undefined): AuthUidShape {
  if (typeof uid !== 'string' || uid.length === 0) {
    return {
      present: false,
      uidLength: null,
      uidMatchesPattern: false,
    };
  }
  return {
    present: true,
    uidLength: uid.length,
    uidMatchesPattern: isFirebaseAuthUid(uid),
  };
}

export function describeUserUid(
  user: { uid?: string | null } | null | undefined,
): AuthUidShape {
  if (user === null || user === undefined) {
    return describeAuthUid(null);
  }
  return describeAuthUid(user.uid);
}

export function isOracleProbeEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') {
    return false;
  }
  return ORACLE_PROBE_EMAIL_PATTERN.test(email);
}

export function createAuthUserSlotTracker(): AuthUserSlotTracker {
  const slots = new Map<string, number>();

  function describeOne(uid: string | null): AuthFireShape {
    if (uid === null) {
      return {
        userSlot: null,
        uidLength: null,
        uidMatchesPattern: false,
      };
    }
    let slot = slots.get(uid);
    if (slot === undefined) {
      slot = slots.size + 1;
      slots.set(uid, slot);
    }
    return {
      userSlot: slot,
      uidLength: uid.length,
      uidMatchesPattern: isFirebaseAuthUid(uid),
    };
  }

  return {
    describeSequence(fires) {
      return fires.map((entry) => describeOne(entry.uid));
    },
    describeFencedSequence(fires) {
      return fires.map((entry) => ({
        ...describeOne(entry.uid),
        fence: entry.fence,
      }));
    },
  };
}

export function describeAuthFireSequence(
  fires: ReadonlyArray<{ uid: string | null }>,
): AuthFireShape[] {
  return createAuthUserSlotTracker().describeSequence(fires);
}

export function describeFencedAuthFireSequence(
  fires: ReadonlyArray<{ uid: string | null; fence: string }>,
): FencedAuthFireShape[] {
  return createAuthUserSlotTracker().describeFencedSequence(fires);
}
