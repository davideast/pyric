import type { RulesEngine } from '../rules-language/load.ts';
import { analyzeFirestore } from './firestore-rules-analyzer.ts';
import { analyzeRtdb } from './rtdb-rules-analyzer.ts';
import { analyzeStorage } from './storage-rules-analyzer.ts';

export interface UnresolvedRef {
  what: string;
  reason: string;
}

export interface AnalyzeResult {
  ids: Set<string>;
  unresolved: UnresolvedRef[];
}

export { analyzeFirestore } from './firestore-rules-analyzer.ts';
export { analyzeRtdb } from './rtdb-rules-analyzer.ts';
export { analyzeStorage } from './storage-rules-analyzer.ts';

/** Analyze one rules source without deriving or persisting coverage. */
export function analyze(engine: RulesEngine, source: string): AnalyzeResult {
  switch (engine) {
    case 'firestore':
      return analyzeFirestore(source);
    case 'storage':
      return analyzeStorage(source);
    case 'rtdb':
      return analyzeRtdb(source);
  }
}
