/**
 * Deduplicates post-sign-in provisioning per user while keeping failures
 * observable. Concurrent callers share one in-flight attempt, so a failure
 * reaches every caller instead of being masked by an "already started"
 * short-circuit. A failed attempt is forgotten, letting the next sign-in
 * retry from scratch; a successful attempt stays cached so provisioning
 * runs once per user.
 */
export const createProvisioner = <TUser extends { uid: string }>(
  provision: (user: TUser) => Promise<void>,
): ((user: TUser) => Promise<void>) => {
  const attempts = new Map<string, Promise<void>>();
  return (user) => {
    const inFlight = attempts.get(user.uid);
    if (inFlight) return inFlight;
    const attempt = provision(user).catch((error: unknown) => {
      attempts.delete(user.uid);
      throw error;
    });
    attempts.set(user.uid, attempt);
    return attempt;
  };
};
