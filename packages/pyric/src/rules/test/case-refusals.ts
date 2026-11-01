/**
 * The reasons a Firestore rules case is refused before either engine runs it,
 * and the instant form a case's `requestTime` takes. A leaf module: the case
 * schema (`spec.ts`), the wire builder and the case-shape check all read it.
 */

/** An ISO-8601 instant with an explicit offset or `Z`, to the nanosecond. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** The instant form a case accepts, for a message that has to name it. */
export const ISO_INSTANT_FORM =
  'an ISO-8601 instant with Z or an explicit offset, such as 2026-01-01T00:00:00Z';

/**
 * `true` when `value` is an ISO-8601 instant with an explicit offset or `Z`
 * that names a real date. A string without an offset reads in the machine's
 * time zone, so it would give a verdict that depends on where it runs.
 */
export function isIsoInstant(value: string): boolean {
  const hasInstantShape = ISO_INSTANT.test(value);
  if (!hasInstantShape) return false;
  return !Number.isNaN(Date.parse(value));
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
