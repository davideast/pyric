/**
 * `pyric-admin/data-connect`: deferred service handle for `firebase-admin/data-connect`.
 */
import { defineDeferredMembers } from 'pyric/app/internal';
import type { PyricAdminApp } from '../app/index.js';
import {
  DEFERRED_SERVICE_TOKEN,
  deferredAdminEntry,
  guardDeferredServiceApp,
  resolveActiveAdminApp,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export interface ConnectorConfig {
  location: string;
  serviceId: string;
  connector?: string;
}

export class DataConnect {
  readonly #app: PyricAdminApp;
  readonly connectorConfig: ConnectorConfig;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('data-connect', 'DataConnect', args);
    this.connectorConfig = args[2] as ConnectorConfig;
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare executeGraphql: (...args: unknown[]) => Promise<never>;
  declare executeGraphqlRead: (...args: unknown[]) => Promise<never>;
  declare executeMutation: (...args: unknown[]) => Promise<never>;
  declare executeQuery: (...args: unknown[]) => Promise<never>;
  declare insert: (...args: unknown[]) => Promise<never>;
  declare insertMany: (...args: unknown[]) => Promise<never>;
  declare upsert: (...args: unknown[]) => Promise<never>;
  declare upsertMany: (...args: unknown[]) => Promise<never>;
}

defineDeferredMembers(DataConnect.prototype, 'pyric-admin/data-connect', 'DataConnect', {
  async: [
    'executeGraphql',
    'executeGraphqlRead',
    'executeMutation',
    'executeQuery',
    'insert',
    'insertMany',
    'upsert',
    'upsertMany',
  ],
});

const instancesByApp = new WeakMap<PyricAdminApp, Map<string, DataConnect>>();

export function getDataConnect(connectorConfig: ConnectorConfig, app?: PyricAdminApp): DataConnect {
  const resolved = resolveActiveAdminApp(app);
  let byId = instancesByApp.get(resolved);
  if (!byId) {
    byId = new Map();
    instancesByApp.set(resolved, byId);
  }
  const id = `${connectorConfig.location}-${connectorConfig.serviceId}`;
  const existing = byId.get(id);
  if (existing !== undefined) return existing;
  const created = new DataConnect(DEFERRED_SERVICE_TOKEN, resolved, connectorConfig);
  byId.set(id, created);
  return created;
}

export const { validateAdminArgs } = deferredAdminEntry('data-connect');
