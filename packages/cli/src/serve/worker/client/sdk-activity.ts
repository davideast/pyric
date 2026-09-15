import { captureIndexQuery, captureDatabaseIndexQuery, sdkActivity, type SdkActivityHandle, type SdkActivityRecord } from 'pyric/sandbox/internal';
import { activityValue, activityStructuralIdentity } from 'pyric/firestore/internal';
import { queryIdentifier } from 'pyric/database/internal';
import type { ListenerOwner } from 'pyric/sandbox';
import type { DocRefHandle, CollRefHandle, QueryHandle } from './handles.js';
import type { QueryConstraintDescriptor, FilterConstraintDescriptor } from '../protocol.js';
import { targetParts, type RtdbTarget } from './rtdb-references.js';
import { pageListenerOwners } from './listener-owners.js';

function filter(value: FilterConstraintDescriptor): unknown {
  if (value.kind === 'where') return { ...value, value: activityValue(value.value) };
  return { kind: value.kind, filters: value.filters.map(filter) };
}
function constraint(value: QueryConstraintDescriptor): unknown {
  if (value.kind === 'where' || value.kind === 'and' || value.kind === 'or') return filter(value);
  if ('values' in value) return { ...value, values: value.values.map(activityValue) };
  return value;
}
export function beginWorkerFirestoreActivity(
  target: DocRefHandle | CollRefHandle | QueryHandle,
  method: string,
  kind: SdkActivityRecord['kind'],
  owners: readonly ListenerOwner[] | undefined = pageListenerOwners(undefined),
): SdkActivityHandle {
  const descriptor = target.descriptor;
  const base = descriptor.__ref === 'query' ? descriptor.source : descriptor;
  const path = base.__ref === 'group' ? base.collectionId : base.path;
  const constraints = descriptor.__ref === 'query' ? descriptor.constraints : [];
  return sdkActivity.begin({
    app: target.port, method, kind, owners,
    source: {
      service: 'firestore', target: path, isQuery: descriptor.__ref !== 'doc',
      ...(descriptor.__ref === 'doc' ? {} : { indexQuery: captureIndexQuery(path, base.__ref === 'group', constraints.filter(item => ['where', 'and', 'or'].includes(item.kind)), constraints.filter(item => item.kind === 'orderBy').map(item => ({ ...item, direction: item.direction ?? 'asc' }))) }),
      key: activityStructuralIdentity({ base, constraints: descriptor.__ref === 'query' ? descriptor.constraints.map(constraint) : [] }),
    },
  });
}
export function beginWorkerDatabaseActivity(
  target: RtdbTarget,
  method: string,
  kind: SdkActivityRecord['kind'],
  owners: readonly ListenerOwner[] | undefined = pageListenerOwners(undefined),
): SdkActivityHandle {
  const { ref, query } = targetParts(target);
  return sdkActivity.begin({
    app: ref.port, method, kind, owners,
    source: { service: 'database', target: ref.path, isQuery: !!query,
      ...(query ? { indexQuery: captureDatabaseIndexQuery(ref.path, query) } : {}),
      key: JSON.stringify([ref.path, query ? queryIdentifier(query) : 'default']),
    },
  });
}
