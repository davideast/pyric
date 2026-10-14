/**
 * The named RTDB instance a request frame addressed: an operation's
 * `instance`, or a listener registration's `target.instance`. Undefined for
 * the default instance and for every other service. Engine-free, so the page
 * client and the Node CLI read the protocol the same way.
 */
export function requestInstance(frame: unknown): string | undefined {
  if (frame === null || typeof frame !== 'object') return undefined;
  const carrier = frame as { instance?: unknown; target?: unknown };
  const target = carrier.target;
  const hasTarget = typeof target === 'object' && target !== null;
  const named = hasTarget ? (target as { instance?: unknown }).instance : carrier.instance;
  return typeof named === 'string' && named.length > 0 ? named : undefined;
}
