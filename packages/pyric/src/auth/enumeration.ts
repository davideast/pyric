import type { Auth } from './types.js';

/**
 * Returns an empty list when Email Enumeration Protection is enabled in production.
 * In modern Firebase, enumeration protection is on by default, so this consistently resolves to `[]`.
 */
export function fetchSignInMethodsForEmail(_auth: Auth, _email: string): Promise<string[]> {
  return Promise.resolve([]);
}
