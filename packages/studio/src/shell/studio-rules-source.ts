/**
 * The deployed rules text Studio's inspectors read.
 *
 * Firestore, Realtime Database, and Storage each have a deployed source, and
 * the surface that displays or re-runs against one needs the exact string the
 * runtime compiled. In review that is read off the seeded sandbox; in served
 * mode it rides the page init payload at `/__pyric/init.json`, so no worker
 * round-trip is needed to show a denial's rules.
 */

import { useEffect, useMemo, useState } from 'react';
import { getInternalEnv } from 'pyric/sandbox/internal';
import type { LocalSandbox } from 'pyric/sandbox';
import { getActiveRules as getActiveDatabaseRules } from 'pyric/sandbox/database';
import { useDevSeed } from '../dev/DevSeedProvider.js';

/** The marker the rules compiler appends when it lowers a modular source. */
const SOURCE_MAP_MARKER = '// @pyric-source-map:';

/** Whether one rules source carries the compiler's source-map marker. */
function hasPyricSourceMapMarker(source: string): boolean {
  return source.includes(SOURCE_MAP_MARKER);
}

/** One rules source with the compiler's source-map trailer removed. */
export function stripPyricSourceMap(source: string): string {
  const isMarkedSource = hasPyricSourceMapMarker(source);
  if (!isMarkedSource) {
    return source;
  }
  const markerIndex = source.indexOf(SOURCE_MAP_MARKER);
  return source.slice(0, markerIndex).trimEnd();
}

/**
 * The deployed ruleset for the targeted service. Studio's rule inspectors
 * (`TrafficSurface` → `DenialDetail`, `RulesSurface`) display this text and
 * re-run against it on a throwaway fork. For dev-server connections it reads
 * the live rules text served at `/__pyric/init.json` (the exact string the
 * runtime compiler compiled); for standalone offline sessions (`?seed=`) it
 * reads them without a worker round-trip. Empty until resolved (the inspector
 * still shows the denial's path/method/auth; the trace fills in once present).
 * Supports Firestore, Realtime Database (`databaseRules`), and Storage.
 */
export function useStudioRulesSource(service: string = 'firestore'): string {
  const seed = useDevSeed();
  const seedReady = seed.status === 'ready';
  const [servedRules, setServedRules] = useState<Record<string, string>>({});

  useEffect(() => {
    if (seedReady) return;
    let alive = true;
    fetch('/__pyric/init.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { rules?: string | null; databaseRules?: unknown | null; storageRules?: string | null } | null) => {
        const isInvalidPayload = !alive || !payload || typeof payload !== 'object';
        if (isInvalidPayload) return;
        const resolved: Record<string, string> = {};
        const hasFirestore = typeof payload.rules === 'string';
        if (hasFirestore) {
          resolved.firestore = payload.rules as string;
        }
        const hasDatabase = payload.databaseRules !== undefined && payload.databaseRules !== null;
        if (hasDatabase) {
          const isStringRule = typeof payload.databaseRules === 'string';
          if (isStringRule) {
            resolved.rtdb = payload.databaseRules as string;
          } else {
            resolved.rtdb = JSON.stringify(payload.databaseRules, null, 2);
          }
        }
        const hasStorage = typeof payload.storageRules === 'string';
        if (hasStorage) {
          resolved.storage = payload.storageRules as string;
        }
        setServedRules(resolved);
      })
      .catch(() => {
        /* best-effort: no text, the inspector still renders the denial. */
      });
    return () => {
      alive = false;
    };
  }, [seedReady]);

  return useMemo<string>(() => {
    const isOfflineSeed = seed.status === 'ready';
    const normalizedService = service === 'database' ? 'rtdb' : service;
    if (!isOfflineSeed) {
      const source = servedRules[normalizedService];
      const hasServedSource = source !== undefined;
      if (hasServedSource) {
        return source;
      }
      return '';
    }
    try {
      const isRtdb = normalizedService === 'rtdb';
      if (isRtdb) {
        const active = getActiveDatabaseRules(seed.handles.sandbox as unknown as LocalSandbox);
        const hasActiveRtdbRules = active !== undefined && active !== null;
        if (hasActiveRtdbRules) {
          return JSON.stringify(active, null, 2);
        }
        return '';
      }
      const rawRules = getInternalEnv(seed.handles.sandbox).getRules();
      return rawRules;
    } catch {
      return '';
    }
  }, [seed, servedRules, service]);
}
