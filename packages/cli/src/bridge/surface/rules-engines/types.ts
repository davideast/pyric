/**
 * What a rules engine does for one service.
 *
 * The `rules` tool has one method per action and names its service in the
 * arguments, so each method dispatches on the service to the engine below.
 * Three services implement this, one file each, and a method record holds the
 * dispatch and nothing else.
 */
import type { OperationResult, SurfaceContext } from '../types.js';

/** One request to evaluate, as the `rules` tool spells it. */
export interface RulesRequest {
  operation: string;
  path: string;
  uid?: string;
  data?: Record<string, unknown>;
  rules?: string;
}

export interface RulesEngine {
  /** Check a ruleset for errors without evaluating a request. */
  lint(ctx: SurfaceContext, rules: string | undefined): Promise<OperationResult>;
  /** Evaluate one request and report allow or deny. */
  simulate(ctx: SurfaceContext, request: RulesRequest): Promise<OperationResult>;
  /** Install a ruleset into the running sandbox. */
  install(ctx: SurfaceContext, rules: string): Promise<OperationResult>;
}
