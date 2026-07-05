import type { z } from 'zod';

/** Type alias for RTDB rule expression strings. */
export type Expr = string;

/** A path segment: string for literal, { $: name } for path variable. */
export type Segment = string | { $: string };

/** Definition of rules for a single database path. */
export interface PathDef {
  read?: Expr;
  write?: Expr;
  validate?: Expr;
  schema?: z.ZodObject<any>;
  fieldConstraints?: Record<string, Expr[]>;
  indexOn?: string[];
  children?: Record<string, PathDef>;
}

/** Context passed to the callback overload of ruleset(). */
export interface RulesetContext {
  path: (path: string, def: PathDef) => void;
}
