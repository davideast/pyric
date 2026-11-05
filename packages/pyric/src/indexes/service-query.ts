import { analyzeIndexQuery, type IndexQuery } from './query-analysis.js';
import type { IndexesConfig, IndexesConfigEntry } from './types.js';

/** RTDB index evidence includes ordering only, never bounds or their values. */
export interface DatabaseIndexQuery {
  service: 'rtdb';
  path: string;
  orderBy: { kind: 'child'; path: string } | { kind: 'key' | 'value' | 'priority' } | null;
}
export interface DatabaseIndexDefinition { path: string; indexOn: string[] }
export interface DatabaseIndexConfig { rules: Record<string, unknown> }
export type ServiceIndexQuery = IndexQuery | DatabaseIndexQuery;
export type ServiceIndexConfig = IndexesConfig | DatabaseIndexConfig;
export type ServiceIndexDefinition = IndexesConfigEntry | DatabaseIndexDefinition;
export type ServiceIndexFinding =
  | { status: 'covered'; basis: 'automatic' | 'configured' }
  | { status: 'missing'; index: ServiceIndexDefinition; editBlocked?: string }
  | { status: 'unavailable'; reason: string; index?: ServiceIndexDefinition };

export function isDatabaseIndexQuery(query: ServiceIndexQuery): query is DatabaseIndexQuery {
  return 'service' in query && query.service === 'rtdb';
}
export function indexService(query: ServiceIndexQuery): 'firestore' | 'rtdb' {
  return isDatabaseIndexQuery(query) ? 'rtdb' : 'firestore';
}
export function captureDatabaseIndexQuery(path: string, spec: { orderBy: DatabaseIndexQuery['orderBy'] }): DatabaseIndexQuery {
  return { service: 'rtdb', path: '/' + path.split('/').filter(Boolean).join('/'), orderBy: spec.orderBy ? { ...spec.orderBy } : null };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Find the existing rule locations at the query path. Multiple wildcard/literal
 * matches are kept: diagnostics can prove coverage without guessing where to edit. */
export function databaseIndexLocations(config: DatabaseIndexConfig, path: string) {
  let matches = [{ path: [] as string[], node: config.rules }];
  for (const segment of path.split('/').filter(Boolean)) {
    matches = matches.flatMap(match => Object.entries(match.node)
      .filter(([key, value]) => (key === segment || key.startsWith('$')) && object(value))
      .map(([key, value]) => ({ path: [...match.path, key], node: value as Record<string, unknown> })));
  }
  return matches;
}
export function analyzeServiceIndex(query: ServiceIndexQuery, config: ServiceIndexConfig | null): ServiceIndexFinding {
  if (!isDatabaseIndexQuery(query)) return analyzeIndexQuery(query, config && 'indexes' in config ? config : null);
  const ordering = query.orderBy;
  if (!ordering || ordering.kind === 'key' || ordering.kind === 'priority') return { status: 'covered', basis: 'automatic' };
  const key = ordering.kind === 'child' ? ordering.path.split('/').filter(Boolean).join('/') : '.value';
  if (!config || !('rules' in config)) return { status: 'unavailable', reason: 'No local database rules are connected.' };
  const locations = databaseIndexLocations(config, query.path);
  for (const { node } of locations) {
    const indexes = node['.indexOn'];
    let keys: unknown[] = [];
    if (typeof indexes === 'string') keys = [indexes];
    else if (Array.isArray(indexes)) keys = indexes;
    if (keys.some(value => typeof value === 'string' && value.split('/').filter(Boolean).join('/') === key)) return { status: 'covered', basis: 'configured' };
  }
  if (locations.length !== 1) {
    const editBlocked = locations.length ? 'Several rule paths match. Choose where to add .indexOn in your rules file.' : 'No rule exists at this query path. Choose where to add .indexOn in your rules file.';
    return { status: 'missing', index: { path: query.path, indexOn: [key] }, editBlocked };
  }
  const location = locations[0]!;
  const existing = location.node['.indexOn'];
  if (existing !== undefined && typeof existing !== 'string' && (!Array.isArray(existing) || !existing.every(value => typeof value === 'string'))) return { status: 'unavailable', reason: 'The existing .indexOn value must be a field name or a list of field names.' };
  let indexOn: string[] = [];
  if (typeof existing === 'string') indexOn = [existing];
  else if (Array.isArray(existing)) indexOn = existing;
  return { status: 'missing', index: { path: '/' + location.path.join('/'), indexOn: [...indexOn, key] } };
}
