// Re-exports provider capability profiles from provider-contract/fixtures.
// This experiment uses the observable fixture profile only.
// Live inference is disabled; the production opt-in flag is not set.

export { contractProfile } from '../provider-contract/fixtures/contract-profile.mjs';
export { fixtureProfiles, fixtureVersion } from '../provider-contract/fixtures/capabilities.mjs';

/** This experiment uses the observable fixture profile only.
 * The oracle survives gateway crashes and supports deduplication.
 */
export const ACTIVE_PROFILE = 'observable';

/** Real inference is never enabled in this experiment. */
export const REAL_INFERENCE_ENABLED = false;
