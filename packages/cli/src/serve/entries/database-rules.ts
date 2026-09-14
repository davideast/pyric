import type { Sandbox } from 'pyric/sandbox';
import { getDatabase, sandbox as controls, type Database } from 'pyric/database';
import { canonicalizeDatabaseUrl } from 'pyric/database/internal';

/** Deploy the served project's rules to each local database without sharing its data. */
export function createDatabaseRulesDeployment(sandbox: Sandbox) {
  const databases = new Map<string, Database>();
  let rules: { rules: Record<string, unknown> } | null = null;
  let defaultPolicy: 'allow' | 'deny' = 'deny';

  function apply(database: Database): void {
    controls.setDefaultPolicy(database, defaultPolicy);
    controls.setRules(database, rules);
  }

  function register(url?: string): void {
    const key = canonicalizeDatabaseUrl(url);
    if (databases.has(key)) return;
    const database = getDatabase(sandbox, url);
    apply(database);
    databases.set(key, database);
  }

  register();
  return {
    register,
    deploy(nextRules: typeof rules, policy: typeof defaultPolicy = 'deny'): void {
      rules = nextRules;
      defaultPolicy = policy;
      for (const database of databases.values()) apply(database);
    },
  };
}
