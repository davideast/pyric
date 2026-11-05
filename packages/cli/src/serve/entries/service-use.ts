/**
 * Whether this page has used a Firebase service: the first in-page
 * `getAuth`, `getFirestore`, `getDatabase` or `getStorage` call marks it. The
 * in-page runtime claims the persist writer role then, so a tab that uses a
 * service holds the role or learns it is read-only before it can save a stale
 * world over another tab's, while a page that uses no service never claims it
 * (#2039). Reachable from `firebase/auth`, so no top-level await (#697).
 */
let used = false;
const listeners: Array<() => void> = [];

/** Record that the page used a service. Idempotent. */
export function markServiceUsed(): void {
  if (used) return;
  used = true;
  for (const listener of listeners.splice(0)) listener();
}

/** Run `listener` once the page uses a service; at once if it already has. */
export function onServiceUsed(listener: () => void): void {
  if (used) listener();
  else listeners.push(listener);
}
