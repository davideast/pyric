/**
 * The Firebase specifiers live mode serves, each with the live module that
 * wraps it, in the order the refusals name them. `rows.ts` builds the live
 * row set from this list, and `refusal.ts` derives what live mode serves and
 * what can pass through from it, so a new row is one line here. It is its
 * own file because `refusal.ts` cannot import `rows.ts`: rows import the
 * modules, and the modules import the refusals.
 *
 * Loaded in the page too, so it imports only types.
 */
import type { ServedFirebaseSpecifier } from '@pyric/cli/vite/internal/supplied-rows';
import type { LiveModuleKey } from './modules.js';

/** One live row: the specifier an app imports and the live module that serves it. */
export type LiveRowSpecifier = readonly [specifier: ServedFirebaseSpecifier, key: LiveModuleKey];

export const LIVE_ROW_SPECIFIERS: readonly LiveRowSpecifier[] = [
  ['firebase/app', 'live-app'],
  ['firebase/auth', 'live-auth'],
  ['firebase/firestore', 'live-firestore'],
  ['firebase/app-check', 'live-app-check'],
  ['firebase/database', 'live-database'],
  ['firebase/ai', 'live-ai'],
];
