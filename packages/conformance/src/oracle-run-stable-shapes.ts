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

const FIRESTORE_AUTO_ID_PATTERN = /^[A-Za-z0-9]{20}$/;
const DECIMAL_DIGITS_PATTERN = /^[0-9]+$/;

interface FirestoreQueryFireShape {
  size: number;
  ids: string[];
}

export function scrubOracleRunToken(
  value: string | null | undefined,
  runId: string,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (runId.length === 0) {
    return value;
  }
  return value.split(runId).join('<runId>');
}

export function scrubOracleRunTokenList(
  values: readonly string[],
  runId: string,
): string[] {
  if (runId.length === 0) {
    return [...values];
  }
  return values.map((item) => item.split(runId).join('<runId>'));
}

export function isFirestoreAutoId(id: string | null | undefined): boolean {
  if (typeof id !== 'string') {
    return false;
  }
  return FIRESTORE_AUTO_ID_PATTERN.test(id);
}

export function describeFirestoreQueryFires(
  fires: ReadonlyArray<{ size: number; ids: readonly string[] }>,
  autoId: string,
): FirestoreQueryFireShape[] {
  return fires.map((entry) => {
    const mapped = entry.ids.map((docId) => {
      if (docId === autoId) {
        return '<autoId>';
      }
      return docId;
    });
    mapped.sort();
    return {
      size: entry.size,
      ids: mapped,
    };
  });
}

export function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isNanosecondsInRange(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < 1_000_000_000
  );
}

export function isDecimalDigitString(value: string | null | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return DECIMAL_DIGITS_PATTERN.test(value);
}

export function isRtdbPushKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.length === 20 && key.startsWith('-');
}

export function describeRtdbServerTimestampReadBack(
  readBack: unknown,
): Record<string, unknown> | null {
  if (typeof readBack !== 'object' || readBack === null || Array.isArray(readBack)) {
    return null;
  }
  const record = readBack as Record<string, unknown>;
  return {
    label: record.label ?? null,
    createdAtIsPositiveInteger: isPositiveSafeInteger(record.createdAt),
  };
}
