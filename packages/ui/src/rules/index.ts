/**
 * `@pyric/ui/rules` — headless components for Firestore rules debugging.
 *
 * The Studio "Debug a denial" screen (`mocks/c-debug.html`) as a
 * props-driven, zero-styling component: `DenialInspector` renders *why*
 * one request was denied (reason, line-marked rule, expression
 * step-through, data in scope, path resolution) and exposes a re-run /
 * verify loop. Grounded entirely in the `pyric/rules` simulator trace —
 * no engine work, pure presentation.
 */
export * from './hooks/index.js';
export * from './components/index.js';

export type {
  Denial,
  DenialLens,
  DenialInspectorProps,
  LineVerdict,
  RuleEvaluation,
  PathResolutionTrace,
  PathResolutionEntry,
  ExprTraceEntry,
  FirestoreMethod,
} from './types.js';
