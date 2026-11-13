/**
 * Claim-map algebra (`unionClaims`, `intersectClaimList`, `nestedClaim`) and
 * standard ID-token claim exclusions for assurance rule-claim extraction.
 */

/** Claims set on every Firebase ID token; never inferred as custom claims. */
export const STANDARD_CLAIMS = new Set([
  'email',
  'email_verified',
  'name',
  'picture',
  'uid',
  'sub',
  'firebase',
  'phone_number',
  'sign_in_provider',
]);

export type Claims = Record<string, unknown>;

const EXISTENCE_CLAIMS = new WeakMap<Claims, Set<string>>();

function isPlainClaimMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function setClaimOwn(target: Claims, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function singleClaim(key: string, value: unknown): Claims {
  const out: Claims = {};
  setClaimOwn(out, key, value);
  return out;
}

export function presenceClaim(key: string): Claims {
  const out = singleClaim(key, true);
  EXISTENCE_CLAIMS.set(out, new Set([key]));
  return out;
}

export function nestedClaim(
  path: readonly string[],
  value: unknown,
  existenceOnly = false,
): Claims {
  if (path.length === 0 || STANDARD_CLAIMS.has(path[0]!)) return {};
  if (path.length === 1) {
    if (existenceOnly) return presenceClaim(path[0]!);
    return singleClaim(path[0]!, value);
  }
  let cur: Record<string, unknown> = {};
  setClaimOwn(cur, path[path.length - 1]!, value);
  for (let i = path.length - 2; i >= 1; i -= 1) {
    const wrapper: Record<string, unknown> = {};
    setClaimOwn(wrapper, path[i]!, cur);
    cur = wrapper;
  }
  return singleClaim(path[0]!, cur);
}

function mergeClaimMaps(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(left)) {
    setClaimOwn(merged, k, Object.getOwnPropertyDescriptor(left, k)?.value);
  }
  for (const k of Object.getOwnPropertyNames(right)) {
    const rVal = Object.getOwnPropertyDescriptor(right, k)?.value;
    if (!Object.hasOwn(merged, k)) {
      setClaimOwn(merged, k, rVal);
      continue;
    }
    const lVal = Object.getOwnPropertyDescriptor(merged, k)?.value;
    if (isPlainClaimMap(lVal) && isPlainClaimMap(rVal)) {
      setClaimOwn(merged, k, mergeClaimMaps(lVal, rVal));
    }
  }
  return merged;
}

export function unionClaims(left: Claims, right: Claims): Claims {
  const out: Claims = {};
  const outExistence = new Set<string>();
  const leftExistence = EXISTENCE_CLAIMS.get(left);
  const rightExistence = EXISTENCE_CLAIMS.get(right);
  for (const key of Object.getOwnPropertyNames(left)) {
    if (STANDARD_CLAIMS.has(key)) continue;
    setClaimOwn(out, key, Object.getOwnPropertyDescriptor(left, key)?.value);
    if (leftExistence?.has(key)) outExistence.add(key);
  }
  for (const key of Object.getOwnPropertyNames(right)) {
    if (STANDARD_CLAIMS.has(key)) continue;
    const rightVal = Object.getOwnPropertyDescriptor(right, key)?.value;
    const rightIsExistence = rightExistence?.has(key) === true;
    if (!Object.hasOwn(out, key)) {
      setClaimOwn(out, key, rightVal);
      if (rightIsExistence) outExistence.add(key);
      continue;
    }
    if (outExistence.has(key) && !rightIsExistence) {
      setClaimOwn(out, key, rightVal);
      outExistence.delete(key);
      continue;
    }
    const existingVal = Object.getOwnPropertyDescriptor(out, key)?.value;
    if (isPlainClaimMap(existingVal) && isPlainClaimMap(rightVal)) {
      setClaimOwn(out, key, mergeClaimMaps(existingVal, rightVal));
      outExistence.delete(key);
    }
  }
  if (outExistence.size > 0) EXISTENCE_CLAIMS.set(out, outExistence);
  return out;
}

export function intersectClaimList(list: Claims[]): Claims {
  if (list.length === 0) return {};
  const first = list[0]!;
  const out: Claims = {};
  const outExistence = new Set<string>();
  const firstExistence = EXISTENCE_CLAIMS.get(first);
  for (const key of Object.getOwnPropertyNames(first)) {
    if (STANDARD_CLAIMS.has(key)) continue;
    const value = Object.getOwnPropertyDescriptor(first, key)?.value;
    const inAll = list
      .slice(1)
      .every(
        (item) =>
          Object.hasOwn(item, key)
          && JSON.stringify(Object.getOwnPropertyDescriptor(item, key)?.value) === JSON.stringify(value),
      );
    if (inAll) {
      setClaimOwn(out, key, value);
      if (firstExistence?.has(key) && list.slice(1).every((item) => EXISTENCE_CLAIMS.get(item)?.has(key))) {
        outExistence.add(key);
      }
    }
  }
  if (outExistence.size > 0) EXISTENCE_CLAIMS.set(out, outExistence);
  return out;
}

export function copyClaimsInto(source: Claims, into: Claims): Claims {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (STANDARD_CLAIMS.has(key) || Object.hasOwn(into, key)) continue;
    setClaimOwn(into, key, Object.getOwnPropertyDescriptor(source, key)?.value);
  }
  return into;
}
