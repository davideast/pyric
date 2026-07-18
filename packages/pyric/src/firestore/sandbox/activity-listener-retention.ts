/** Drop only the physical listener correlations owned by an evicted target bucket. */
export function releaseActivityListenerBucket<T>(
  active: ReadonlyMap<string, unknown>,
  correlations: Map<string, T>,
): void {
  for (const physicalListenerId of active.keys()) {
    correlations.delete(physicalListenerId);
  }
}

/** Evict the oldest retained physical listener and its exact correlation. */
export function releaseOldestActivityListener<T, U>(
  active: Map<string, T>,
  correlations: Map<string, U>,
): boolean {
  const physicalListenerId = active.keys().next().value as string | undefined;
  if (physicalListenerId === undefined) return false;
  active.delete(physicalListenerId);
  correlations.delete(physicalListenerId);
  return true;
}
