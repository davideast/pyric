/**
 * The reasons a Firestore rules case is refused before either engine runs it,
 * and the instant form a case's `requestTime` takes. A leaf module: the case
 * schema (`spec.ts`), the wire builder and the case-shape check all read it.
 */

/** Read a property from an arbitrary caller value without throwing on hostile getters or proxies. */
export function safeReadProp(obj: unknown, key: string): unknown {
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** An ISO-8601 instant with an explicit offset or `Z`, to the nanosecond. */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/** An ISO-8601 instant allowing omitted seconds (`HH:MM`) or arbitrary fractional digits. */
const ISO_INSTANT_RELAXED_PRECISION =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/** 0001-01-01T00:00:00.000Z in epoch milliseconds. */
const MIN_ISO_TIMESTAMP_MILLIS = -62_135_596_800_000;
/** 9999-12-31T23:59:59.999Z in epoch milliseconds. */
const MAX_ISO_TIMESTAMP_MILLIS = 253_402_300_799_999;

function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) return isGregorianLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * Parse an ISO-8601 instant string with strict calendar and range checks,
 * returning epoch milliseconds or `null` when the date, time, offset, or
 * resulting UTC instant is invalid or outside `[0001-01-01T00:00:00Z,
 * 9999-12-31T23:59:59.999999999Z]`.
 */
export function parseStrictIsoMillis(
  value: string,
  options?: { allowShortSeconds?: boolean },
): number | null {
  const pattern = options?.allowShortSeconds ? ISO_INSTANT_RELAXED_PRECISION : ISO_INSTANT;
  const match = pattern.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] !== undefined ? Number(match[6]) : 0;

  if (year < 1 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInGregorianMonth(year, month)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;

  if (match[8] !== 'Z') {
    const offsetHours = Number(match[10]);
    const offsetMinutes = Number(match[11]);
    if (offsetHours < 0 || offsetHours > 23) return null;
    if (offsetMinutes < 0 || offsetMinutes > 59) return null;
  }

  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < MIN_ISO_TIMESTAMP_MILLIS || ms > MAX_ISO_TIMESTAMP_MILLIS) {
    return null;
  }
  return ms;
}

/** The instant form a case accepts, for a message that has to name it. */
export const ISO_INSTANT_FORM =
  'an ISO-8601 instant with Z or an explicit offset, such as 2026-01-01T00:00:00Z';

/**
 * `true` when `value` is an ISO-8601 instant with an explicit offset or `Z`
 * that names a real date. A string without an offset reads in the machine's
 * time zone, so it would give a verdict that depends on where it runs.
 */
export function isIsoInstant(value: string): boolean {
  return parseStrictIsoMillis(value) !== null;
}

/** Why a `requestTime` can't be used, or `undefined` when it can. */
export function requestTimeRefusal(requestTime: unknown): string | undefined {
  if (requestTime === undefined) return undefined;
  const isUsable = typeof requestTime === 'string' && isIsoInstant(requestTime);
  if (isUsable) return undefined;
  return `Case refused: requestTime is ${JSON.stringify(requestTime)}, which is not ${ISO_INSTANT_FORM}.`;
}

/** The reason a `create` case that names an existing `resource` is refused.
 *  A real create always finds no document, so `resource` is null. The Rules
 *  Test API binds a supplied one anyway (FS2-CON-12), so such a case describes
 *  a request that can't happen. */
export const CREATE_RESOURCE_REFUSAL =
  "Case refused: a create case has no existing resource; use 'update' or remove 'resource'.";

/** Why a case's method and resource can't go together, or `undefined`. */
export function createResourceRefusal(tc: { method?: unknown; resource?: unknown }): string | undefined {
  const isCreateWithResource = tc.method === 'create' && tc.resource !== undefined && tc.resource !== null;
  return isCreateWithResource ? CREATE_RESOURCE_REFUSAL : undefined;
}
