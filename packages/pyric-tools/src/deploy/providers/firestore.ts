/**
 * The `rules` and `indexes` deploy providers (Firestore). Both are simple
 * single-unit wraps over the existing `createFirestoreDeployTools` factory; their
 * `resolveConfig` lifts the old if-ladder's firebase.json reading verbatim.
 */
import { resolve as resolvePath } from 'node:path';
import { createFirestoreDeployTools } from '../tools.js';
import type { DeployProvider, ConfigSource, ResolveResult } from '../provider.js';
import { SCOPES } from '../../credentials/core/scopes.js';

interface FirestoreRulesArgs {
  source: string;
}
interface FirestoreIndexesArgs {
  config: unknown;
}

export const firestoreRulesProvider: DeployProvider<FirestoreRulesArgs> = {
  target: 'rules',
  summary: 'Deploy Firestore security rules',
  operations: [{ name: 'deploy', default: true, toolName: 'firestore_deploy_rules' }],
  requiredScope: SCOPES.firebase,
  requiredApis: ['firebaserules.googleapis.com', 'firestore.googleapis.com'],
  tools: (scope) => createFirestoreDeployTools({ scope }),
  async resolveConfig(_op, src): Promise<ResolveResult<FirestoreRulesArgs>> {
    const rulesPath = src.firebaseJson.firestore?.rules;
    if (!rulesPath) return { ok: false, message: 'firebase.json has no `firestore.rules` path.' };
    return { ok: true, units: [{ source: await src.readFile(resolvePath(src.cwd, rulesPath)) }] };
  },
};

export const firestoreIndexesProvider: DeployProvider<FirestoreIndexesArgs> = {
  target: 'indexes',
  summary: 'Deploy Firestore indexes',
  operations: [{ name: 'deploy', default: true, toolName: 'firestore_deploy_indexes' }],
  requiredScope: SCOPES.datastore,
  requiredApis: ['firestore.googleapis.com'],
  tools: (scope) => createFirestoreDeployTools({ scope }),
  async resolveConfig(_op, src): Promise<ResolveResult<FirestoreIndexesArgs>> {
    const indexesPath = src.firebaseJson.firestore?.indexes;
    if (!indexesPath) return { ok: false, message: 'firebase.json has no `firestore.indexes` path.' };
    const raw = await src.readFile(resolvePath(src.cwd, indexesPath));
    try {
      return { ok: true, units: [{ config: JSON.parse(raw) }] };
    } catch (e) {
      return { ok: false, message: `failed to parse ${indexesPath}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
