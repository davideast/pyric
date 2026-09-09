/**
 * What a rules engine does for one service.
 *
 * The `rules` tool has one method per action and names its service in the
 * arguments, so each method dispatches on the service to the engine below.
 * Three services implement this, one file each, and a method record holds the
 * dispatch and nothing else.
 *
 * An engine carries everything that differs by service, including the request
 * methods that service evaluates and the check that its rules source parses.
 * A service that gains Security Rules is therefore one new engine file and one
 * new entry in the record set, with no list elsewhere to keep in step.
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

/** Why a rules source does not parse for one service, in the caller's words. */
export interface RulesSourceProblem {
  /** What is wrong, as a sentence naming the position or the parser's message. */
  body: string;
  /** The edit that fixes it, opening with an imperative verb. */
  fix: string;
}

export interface RulesEngine {
  /** The request methods this service's rules evaluate. */
  readonly requestMethods: readonly string[];
  /** Why one source does not parse for this service, or null when it parses. */
  parseFailure(source: string): RulesSourceProblem | null;
  /** Check a ruleset for errors without evaluating a request. */
  lint(ctx: SurfaceContext, rules: string | undefined): Promise<OperationResult>;
  /** Evaluate one request and report allow or deny. */
  simulate(ctx: SurfaceContext, request: RulesRequest): Promise<OperationResult>;
  /** Install a ruleset into the running sandbox. */
  install(ctx: SurfaceContext, rules: string): Promise<OperationResult>;
}
