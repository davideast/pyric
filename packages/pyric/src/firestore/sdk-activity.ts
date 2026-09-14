import { sdkActivity, type SdkActivityRecord, type SdkActivityHandle } from '../sandbox/internal/sdk-activity.js';
import { listenerAttachOwners, type ListenerAttribution } from '../sandbox/attribution/listener-owners.js';
import { underlyingOf, type Target } from './state.js';
import type { QueryImpl } from './sandbox/admin-compat/query.js';

/** One public invocation, independent of backend reads and listener reauthorization. */
export function beginFirestoreActivity(
  target: Target,
  ref: object,
  method: string,
  kind: SdkActivityRecord['kind'],
  attribution?: ListenerAttribution,
): SdkActivityHandle {
  const raw = underlyingOf(ref) as QueryImpl & { path?: string };
  const source = typeof raw.sdkActivitySource === 'function'
    ? raw.sdkActivitySource()
    : { service: 'firestore' as const, target: raw.path!, key: `doc:${raw.path}` };
  return sdkActivity.begin({
    app: target.activityApp ?? target,
    source,
    method,
    kind,
    owners: listenerAttachOwners(attribution?.owner, attribution?.owners),
  });
}
