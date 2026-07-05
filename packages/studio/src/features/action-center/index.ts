/**
 * Action Center feature (Wave 2, F1): public surface.
 *
 * The pure aggregation reducer + phrasing, the live-feed seam, the React hook,
 * and the view. The shell mounts {@link ActionCenter} on the Action Center tab.
 */

export { ActionCenter, type ActionCenterProps } from './ActionCenter.js';
export {
  useActionDigest,
  type UseActionDigestOptions,
  type UseActionDigestResult,
} from './useActionDigest.js';
export {
  emptyEventFeed,
  feedFromSandboxLike,
  makeWorkerEventFeed,
  type EventFeed,
} from './feed.js';
export {
  digestFromEvents,
  foldDigest,
  emptyDigestState,
  toMutation,
  phraseDigest,
  attribution,
  SAMPLE_CAP,
  type DigestItem,
  type DigestState,
  type DigestVerb,
  type DigestActor,
} from './reducer.js';
