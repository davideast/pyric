import { resolve as resolvePath } from 'node:path';
import { createRtdbDeployTools } from '../tools.js';
import type { DeployProvider, ResolveResult } from '../provider.js';
import { SCOPES } from '../../credentials/core/scopes.js';

interface DatabaseRulesArgs {
  rulesJson: unknown;
  databaseUrl?: string;
}

function stringFlag(flags: ReadonlyMap<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const databaseRulesProvider: DeployProvider<DatabaseRulesArgs> = {
  target: 'database',
  summary: 'Deploy Realtime Database security rules',
  operations: [{ name: 'deploy', default: true, toolName: 'rtdb_deploy_rules' }],
  requiredScope: SCOPES.firebaseDatabase,
  requiredApis: ['firebasedatabase.googleapis.com'],
  tools: (scope) => createRtdbDeployTools({ scope }),
  async resolveConfig(_op, src): Promise<ResolveResult<DatabaseRulesArgs>> {
    const rulesPath = src.firebaseJson.database?.rules;
    if (!rulesPath) return { ok: false, message: 'firebase.json has no `database.rules` path.' };

    const raw = await src.readFile(resolvePath(src.cwd, rulesPath));
    let rulesJson: unknown;
    try {
      rulesJson = JSON.parse(raw);
    } catch (e) {
      return { ok: false, message: `failed to parse ${rulesPath}: ${e instanceof Error ? e.message : String(e)}` };
    }

    const databaseUrl =
      stringFlag(src.flags, 'database-url') ??
      stringFlag(src.flags, 'databaseUrl') ??
      src.env?.FIREBASE_DATABASE_URL ??
      src.firebaseJson.database?.url;
    return {
      ok: true,
      units: [{ rulesJson, ...(databaseUrl ? { databaseUrl } : {}) }],
    };
  },
};
