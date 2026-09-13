import { sdkActivity, type SdkActivityHandle, type SdkActivityRecord } from '../sandbox/internal/sdk-activity.js';
import { listenerAttachOwners, type ListenerAttribution } from '../sandbox/attribution/listener-owners.js';
import { queryIdentifier, isQuery } from './query-shape.js';
import { targetOf } from './routing.js';
import type { DatabaseReference, Query } from './types.js';

export function beginDatabaseActivity(
  ref: DatabaseReference | Query,
  method: string,
  kind: SdkActivityRecord['kind'],
  attribution?: ListenerAttribution,
): SdkActivityHandle {
  const base = isQuery(ref) ? (ref as Query).ref : ref as DatabaseReference;
  const target = targetOf(base);
  return sdkActivity.begin({
    app: target.activityApp ?? target,
    source: {
      service: 'database', target: base._path,
      key: JSON.stringify([target.activityScope, base._path, queryIdentifier(ref._spec)]),
      isQuery: isQuery(ref),
    },
    method, kind, owners: listenerAttachOwners(attribution?.owner, attribution?.owners),
  });
}
