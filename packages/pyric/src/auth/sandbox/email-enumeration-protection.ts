/**
 * Project-level Email Enumeration Protection state (`EmailPrivacyConfig.enableImprovedEmailPrivacy`).
 *
 * Production Firebase projects enable Email Enumeration Protection by default,
 * collapsing unknown-email and wrong-password login errors into
 * `auth/invalid-credential` and resolving `sendPasswordResetEmail` silently for
 * unknown addresses. Toggling the project setting to `false` models projects
 * where Email Enumeration Protection is disabled (`auth/user-not-found` and
 * `auth/wrong-password`).
 */
import { SandboxError } from 'pyric/sandbox';
import type { AuthProjectStore } from './project-store.js';

export function getProjectEmailEnumerationProtection(store: AuthProjectStore): boolean {
  return store.emailEnumerationProtection;
}

export function setProjectEmailEnumerationProtection(
  store: AuthProjectStore,
  enabled: boolean,
): void {
  if (typeof enabled !== 'boolean') {
    throw new SandboxError(
      'invalid-argument',
      'sandbox.setEmailEnumerationProtection: enabled must be a boolean.',
    );
  }
  if (store.emailEnumerationProtection === enabled) {
    return;
  }
  store.emailEnumerationProtection = enabled;
  notifyEmailEnumerationProtectionSubscribers(store);
}

export function notifyEmailEnumerationProtectionSubscribers(store: AuthProjectStore): void {
  for (const subscriber of [...store.emailEnumerationProtectionSubscribers]) {
    try {
      subscriber();
    } catch (err) {
      // Observational listener: swallow subscriber errors so config updates succeed.
      void err;
    }
  }
}

export function subscribeProjectEmailEnumerationProtection(
  store: AuthProjectStore,
  callback: () => void,
): () => void {
  store.emailEnumerationProtectionSubscribers.add(callback);
  return () => {
    store.emailEnumerationProtectionSubscribers.delete(callback);
  };
}
