/** The rules engine each service brings, keyed by the name the `rules` tool takes. */
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

export type { RulesEngine, RulesRequest } from './types.js';
