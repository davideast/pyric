import type { RtdbDataTransport, UserAuth } from 'pyric/database';

interface SnapshotLike {
  val(): unknown;
}

interface AdminReferenceLike {
  get(): Promise<SnapshotLike>;
  set(value: unknown): Promise<void>;
  update(values: Record<string, unknown>): Promise<void>;
  push(value: unknown): PromiseLike<{ key: string | null }>;
  remove(): Promise<void>;
}

interface AdminDatabaseLike {
  ref(path: string): AdminReferenceLike;
}

interface ClientDataApi {
  ref(database: unknown, path: string): unknown;
  get(reference: unknown): Promise<SnapshotLike>;
  set(reference: unknown, value: unknown): Promise<void>;
  update(reference: unknown, values: Record<string, unknown>): Promise<void>;
  push(reference: unknown, value: unknown): PromiseLike<{ key: string | null }>;
  remove(reference: unknown): Promise<void>;
}

export interface FirebaseRtdbDataTransportDeps {
  readonly databaseUrl: string;
  getAdminDatabase(databaseUrl: string): AdminDatabaseLike;
  getClientDatabase(auth: UserAuth, databaseUrl: string): Promise<unknown>;
  readonly client: ClientDataApi;
}

/** Build the production Firebase adapter for Pyric's RTDB data-tool port. */
export function createFirebaseRtdbDataTransport(
  deps: FirebaseRtdbDataTransportDeps,
): RtdbDataTransport {
  return {
    async get(path, auth) {
      if (auth) {
        const database = await deps.getClientDatabase(auth, deps.databaseUrl);
        const reference = deps.client.ref(database, path);
        return (await deps.client.get(reference)).val();
      }
      return (await deps.getAdminDatabase(deps.databaseUrl).ref(path).get()).val();
    },
    async set(path, value, auth) {
      if (auth) {
        const database = await deps.getClientDatabase(auth, deps.databaseUrl);
        await deps.client.set(deps.client.ref(database, path), value);
        return;
      }
      await deps.getAdminDatabase(deps.databaseUrl).ref(path).set(value);
    },
    async update(path, values, auth) {
      if (auth) {
        const database = await deps.getClientDatabase(auth, deps.databaseUrl);
        await deps.client.update(deps.client.ref(database, path), values);
        return;
      }
      await deps.getAdminDatabase(deps.databaseUrl).ref(path).update(values);
    },
    async push(path, value, auth) {
      if (auth) {
        const database = await deps.getClientDatabase(auth, deps.databaseUrl);
        const result = await deps.client.push(
          deps.client.ref(database, path),
          value,
        );
        return { key: result.key };
      }
      const result = await deps
        .getAdminDatabase(deps.databaseUrl)
        .ref(path)
        .push(value);
      return { key: result.key };
    },
    async remove(path, auth) {
      if (auth) {
        const database = await deps.getClientDatabase(auth, deps.databaseUrl);
        await deps.client.remove(deps.client.ref(database, path));
        return;
      }
      await deps.getAdminDatabase(deps.databaseUrl).ref(path).remove();
    },
  };
}
