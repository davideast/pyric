/** An application's data-layer wrapper: every listener in the app opens here. */
import { pageListenerOwners } from '../../../../../src/serve/worker/client/listener-owners.js';

export function watch(owner?: string): ReturnType<typeof pageListenerOwners> {
  // Not a tail call: JavaScriptCore drops a tail caller's frame.
  const owners = [pageListenerOwners(owner === undefined ? undefined : { owner })];
  return owners[0];
}
