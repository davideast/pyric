/**
 * Node host: the RTDB instances a `database` method may name.
 *
 * The host already knows its instances: one entry per instance `firebase.json`
 * deployed rules to, and one per instance a client opened. The sandbox may
 * also hold an instance restored from saved state that no client has opened
 * yet. A name resolves as the host resolves a client's `instance` field
 * (`rtdbInstanceKey`), so the project's default instance name selects the
 * default instance, and a selected instance's entry is opened as a client's
 * would be, with its own rules.
 */
import { heldDatabaseInstances } from 'pyric/database/internal';
import { UNNAMED_DEFAULT_DATABASE_INSTANCE } from 'pyric/sandbox/internal';

import {
  distinctNames,
  type DatabaseInstanceCatalog,
  type KnownDatabaseInstances,
} from '../../../bridge/surface/database-instance-catalog.js';
import type { HostCtx } from '../host-context.js';
import { defaultInstanceNameOf, rtdbInstance, rtdbInstanceKey, rtdbInstances } from './rtdb-instances.js';

function known(ctx: HostCtx): KnownDatabaseInstances {
  const registry = rtdbInstances(ctx);
  const served = [...registry.entries()].map(([key]) => key);
  const named = distinctNames([...served, ...heldDatabaseInstances(ctx.sandbox)], registry.defaultKey)
    .filter((name) => name !== UNNAMED_DEFAULT_DATABASE_INSTANCE && rtdbInstanceKey(ctx, name) !== registry.defaultKey);
  const defaultInstance = defaultInstanceNameOf(ctx);
  const isNamed = defaultInstance !== undefined && defaultInstance !== UNNAMED_DEFAULT_DATABASE_INSTANCE;
  return { ...(isNamed ? { defaultInstance } : {}), named, pending: [] };
}

/** The catalog a hosted `database` method resolves its `instance` against. */
export function hostDatabaseInstances(ctx: HostCtx): DatabaseInstanceCatalog {
  return {
    select(name) {
      const isDefault = rtdbInstanceKey(ctx, name) === rtdbInstances(ctx).defaultKey;
      if (isDefault) return undefined;
      if (!known(ctx).named.includes(name)) return null;
      return rtdbInstance(ctx, name).selector;
    },
    known: () => known(ctx),
  };
}
