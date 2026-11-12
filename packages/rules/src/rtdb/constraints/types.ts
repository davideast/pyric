import type { z } from 'zod';

/** Type alias for RTDB rule expression strings. */
export type Expr = string;

/** A path segment: string for literal, { $: name } for path variable. */
export type Segment = string | { $: string };

/** Definition of rules for a single database path. */
export interface PathDef {
  /** An expression, or a boolean as database.rules.json spells it: false denies, true allows. */
  read?: Expr | boolean;
  write?: Expr | boolean;
  validate?: Expr | boolean;
  schema?: z.ZodObject<any>;
  fieldConstraints?: Record<string, Expr[]>;
  /**
   * Fields to emit under `.indexOn` for the container node. May be declared
   * directly on a container path (e.g. `"/jobs"`) or on a `$wildcard` child
   * path (e.g. `"/jobs/$jobId"`), which lifts `.indexOn` onto its parent.
   */
  indexOn?: string[];
  children?: Record<string, PathDef>;
}

/** Context passed to the callback overload of ruleset(). */
export interface RulesetContext {
  path: (path: string, def: PathDef) => void;
}
