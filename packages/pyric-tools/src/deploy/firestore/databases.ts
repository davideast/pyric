/**
 * Firestore database provisioning. Idempotent — probes first,
 * creates if absent. Takes `ProjectScope` per F3.
 */

import { AdminApiError, type ProjectScope } from '../scope.js';

const FIRESTORE_ADMIN_API = 'https://firestore.googleapis.com/v1';

export interface ProvisionDatabaseOptions {
  /** Name of the database. Default `'(default)'`. */
  databaseId?: string;
  /** Multi-region or region. Default `'nam5'`. */
  locationId?: string;
  /** Default `'FIRESTORE_NATIVE'`. */
  type?: 'FIRESTORE_NATIVE' | 'DATASTORE_MODE';
}

export type ProvisionDatabaseOutcome =
  | { ok: true; status: 'created'; operationName: string }
  | { ok: true; status: 'already-exists' }
  | {
      ok: false;
      code: 'permission-denied' | 'unknown';
      message: string;
    };

/**
 * Create the default (or named) Firestore database in the project.
 * Idempotent: probes first via `GET .../databases/<id>` and
 * short-circuits with `already-exists` when present.
 *
 * Returns the long-running-operation name on a fresh provision;
 * callers that want strict ordering should poll the LRO before
 * issuing writes (Firestore's data plane comes online ~30s after
 * the initial 200).
 *
 * Required IAM (subsumed by Owner/Editor):
 *   - `datastore.databases.get`
 *   - `datastore.databases.create`
 */
export async function provision(
  scope: ProjectScope,
  options: ProvisionDatabaseOptions = {},
): Promise<ProvisionDatabaseOutcome> {
  const databaseId = options.databaseId ?? '(default)';
  const locationId = options.locationId ?? 'nam5';
  const type = options.type ?? 'FIRESTORE_NATIVE';

  try {
    const token = await scope.resolveToken();
    const probe = await fetch(
      `${FIRESTORE_ADMIN_API}/projects/${encodeURIComponent(scope.projectId)}/databases/${encodeURIComponent(databaseId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (probe.ok) return { ok: true, status: 'already-exists' };
    if (probe.status !== 404) {
      throw new AdminApiError(
        probe.status,
        await probe.text(),
        `Failed to probe database: ${probe.status}`,
      );
    }

    const createRes = await fetch(
      `${FIRESTORE_ADMIN_API}/projects/${encodeURIComponent(scope.projectId)}/databases?databaseId=${encodeURIComponent(databaseId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ locationId, type }),
      },
    );
    if (!createRes.ok) {
      throw new AdminApiError(
        createRes.status,
        await createRes.text(),
        `Failed to create database: ${createRes.status}`,
      );
    }
    const lro = (await createRes.json()) as { name?: string };
    return {
      ok: true,
      status: 'created',
      operationName: lro.name ?? '',
    };
  } catch (e) {
    if (
      e instanceof AdminApiError &&
      (e.status === 401 || e.status === 403)
    ) {
      return { ok: false, code: 'permission-denied', message: e.message };
    }
    return {
      ok: false,
      code: 'unknown',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
