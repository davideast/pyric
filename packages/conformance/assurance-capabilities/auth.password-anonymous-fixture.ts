import type { AssuranceCapabilityRecord } from './types.ts';

/** The actor lenses an assurance campaign acquires before it probes: an
 *  anonymous account, a password account, a seeded fixture user (with custom
 *  claims), and the anonymous-request lens. Auth has no rules-language
 *  constructs, so this capability rests on the auth SDK registry rows that
 *  adjudicate each acquisition against production — an actor whose uid, claims,
 *  or session shape differs from production is probing a different subject. */
export const capability: AssuranceCapabilityRecord = {
  service: 'auth',
  description: 'Password, anonymous-account, anonymous-request, fixture-user, and synthetic lenses.',
  dependencies: [
    { kind: 'registry-row', id: 'auth#6' },
    { kind: 'registry-row', id: 'auth#7' },
    { kind: 'registry-row', id: 'auth#8' },
    { kind: 'registry-row', id: 'auth#9' },
    { kind: 'registry-row', id: 'auth#11' },
    { kind: 'registry-row', id: 'auth#13' },
    { kind: 'registry-row', id: 'auth#14' },
    { kind: 'registry-row', id: 'auth#15' },
    { kind: 'registry-row', id: 'auth#16' },
    { kind: 'registry-row', id: 'auth#69' },
    { kind: 'registry-row', id: 'auth#63' },
    { kind: 'registry-row', id: 'auth#73' },
    { kind: 'registry-row', id: 'auth#75' },
  ],
};
