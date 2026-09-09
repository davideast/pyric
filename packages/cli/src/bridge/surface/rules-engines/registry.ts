/**
 * The rules engine each service brings, keyed by the name the `rules` tool
 * takes. The directory holds one engine per file and this record set names
 * them, so a service that gains rules is one new file and one new entry.
 */
import { DATABASE_RULES } from './database.js';
import { FIRESTORE_RULES } from './firestore.js';
import { STORAGE_RULES } from './storage.js';
import type { RulesEngine } from './types.js';

const ENGINES: Readonly<Record<string, RulesEngine>> = {
  firestore: FIRESTORE_RULES,
  database: DATABASE_RULES,
  storage: STORAGE_RULES,
};

/**
 * The engine for one service. The validator has already refused a service that
 * is not one of the three, so a miss here is a programming error rather than a
 * caller's mistake.
 */
export function rulesEngineFor(service: string): RulesEngine {
  const engine = ENGINES[service];
  if (engine === undefined) throw new Error(`no rules engine for service '${service}'`);
  return engine;
}

/**
 * The services that carry Security Rules, in record order. This is the one
 * declaration: the `rules` tool's `service` enum, its per-service request
 * methods, and its source check are all read from the engine the name resolves
 * to rather than from a second list.
 */
export const RULES_SERVICES: readonly string[] = Object.keys(ENGINES);
