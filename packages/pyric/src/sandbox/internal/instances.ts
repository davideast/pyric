export { undeployedInstanceNotice, defaultDatabaseInstanceName, isDefaultDatabaseInstance, defaultDatabaseInstance, parseDatabaseUrl, parseDatabaseLocationUrl, isCustomDatabaseHost, databaseInstanceNamed, resolveDatabaseInstance, databaseInstanceKey, createDatabaseInstanceRegistry, UNNAMED_DEFAULT_DATABASE_INSTANCE, LOCKED_DATABASE_RULES } from '@pyric/rules/internal/rtdb';
export type { DatabaseInstance, DatabaseLocationUrl, DatabaseInstanceRegistry } from '@pyric/rules/internal/rtdb';

/** What Pyric logs the first time a Storage bucket without deployed rules is used, under the runtime's policy for unconfigured rules. */
export function undeployedBucketNotice(name: string, policy: 'allow' | 'deny'): string {
  let access = 'it denies every client operation';
  if (policy === 'allow') {
    access = 'permissive mode allows every client operation';
  }
  return `pyric: Storage bucket "${name}" has no rules in firebase.json; ${access}. Add {"bucket": "${name}", "rules": "<file>"} to the storage array.`;
}
