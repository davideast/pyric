import type { AssuranceCapabilityRecord } from './types.ts';

/** Acquiring an actor through a real provider flow: OAuth popup/redirect,
 *  custom tokens, MFA enrollment/resolution, token revocation, and email-action
 *  links. An actor a campaign cannot ACQUIRE is an actor it cannot probe as. */
export const capability: AssuranceCapabilityRecord = {
  service: 'auth',
  description: 'OAuth provider, custom-token, MFA, revocation, and email-action acquisition flows are outside v1.',
  dependencies: [
    { kind: 'registry-row', id: 'auth#44' },
    { kind: 'registry-row', id: 'auth#45' },
    { kind: 'registry-row', id: 'auth#48' },
    { kind: 'registry-row', id: 'auth#49' },
    {
      kind: 'unbacked',
      behavior: 'custom-token sign-in, MFA enrollment/resolution, refresh-token revocation, and email-action link acquisition',
      reason:
        'the auth registry has no rows for these flows: they are unmirrored surface, so the graph holds no evidence that an actor acquired through them matches production',
    },
  ],
};
