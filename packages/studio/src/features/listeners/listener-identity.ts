/**
 * Short display text for a listener's `authLens` (feature: Listeners).
 */

import type { AuthLens } from 'pyric/sandbox';

export function formatAuthLens(lens: AuthLens): string {
  if (lens.mode === 'admin') return 'admin';
  if (lens.mode === 'as') return `as ${lens.uid}`;
  if (lens.mode === 'app-session') return 'app session';
  return 'anonymous';
}
