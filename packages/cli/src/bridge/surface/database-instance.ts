/**
 * The Realtime Database instance a `database` method call selects.
 *
 * `instance` is parsed by the SDK's own rules (`resolveDatabaseInstance`):
 * a bare name, any database URL, or `default`. The project's default instance
 * name selects the default instance, as `getDatabase(app)` and that URL reach
 * one instance in production. Any other name must be one the project has;
 * a typo would otherwise open an empty instance and read back nothing.
 */
import { resolveDatabaseInstance } from 'pyric/sandbox/internal';
import { projectDatabaseInstances, type KnownDatabaseInstances } from './database-instance-catalog.js';
import type { SurfaceContext } from './types.js';

/** The instances listed in a refusal, the default first. */
function describeKnown(known: KnownDatabaseInstances): string {
  const defaultLabel = known.defaultInstance === undefined ? 'default' : `${known.defaultInstance} (default)`;
  return [defaultLabel, ...known.named].join(', ');
}

/** The refusal for an instance the project does not have. */
export function unknownInstanceMessage(name: string, known: KnownDatabaseInstances): string {
  const sentences = [
    `database instance "${name}" is not declared in firebase.json and holds no data in this sandbox.`,
    `Known instances: ${describeKnown(known)}.`,
    ...known.pending,
  ];
  return sentences.join(' ');
}

/**
 * The `getDatabase` selector for a call's `instance` argument: `undefined` for
 * the default instance, else the instance name. Throws the refusal for an
 * instance the project does not have.
 */
export async function instanceSelector(ctx: SurfaceContext, raw: unknown): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  const instance = resolveDatabaseInstance(String(raw));
  if (instance === undefined) return undefined;
  const catalog = ctx.databaseInstances ?? await projectDatabaseInstances(ctx.sandbox, ctx.projectDir);
  const selector = catalog.select(instance.name);
  if (selector === null) throw new Error(unknownInstanceMessage(instance.name, catalog.known()));
  return selector;
}

/** A summary that names the instance when it is not the default, as denials do. */
export function onInstance(summary: string, selector: string | undefined): string {
  return selector === undefined ? summary : `${summary} on ${selector}`;
}
