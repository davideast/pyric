import { z } from 'zod';

export const SimulationQuerySchema = z.object({
  orderByChild: z.string().nullable().optional(),
  orderByKey: z.boolean().nullable().optional(),
  orderByValue: z.boolean().nullable().optional(),
  equalTo: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  limitToFirst: z.number().nullable().optional(),
  limitToLast: z.number().nullable().optional(),
  startAt: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  endAt: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});
export type SimulationQuery = z.infer<typeof SimulationQuerySchema>;

/**
 * The reason a query cannot be a single Realtime Database query, or null when
 * it can. The SDK allows one `orderBy*` and one limit per query, and a limit is
 * a positive integer. A caller that builds a query from loose input checks it
 * here so a shape the SDK would refuse is not evaluated as if it were a read.
 */
export function simulationQueryProblem(query: unknown): string | null {
  const parsed = SimulationQuerySchema.strict().safeParse(query);
  if (!parsed.success) {
    return `query is not a Realtime Database query: ${parsed.error.issues.map((i) => i.message).join('; ')}`;
  }
  const q = parsed.data;
  const orderings = [
    q.orderByChild != null && q.orderByChild !== '',
    q.orderByKey === true,
    q.orderByValue === true,
  ].filter(Boolean).length;
  if (q.orderByChild === '') return 'query.orderByChild must name a child path.';
  if (orderings > 1) return 'query names more than one of orderByChild, orderByKey and orderByValue.';
  if (q.limitToFirst != null && q.limitToLast != null) {
    return 'query names both limitToFirst and limitToLast.';
  }
  for (const [name, n] of [['limitToFirst', q.limitToFirst], ['limitToLast', q.limitToLast]] as const) {
    if (n != null && (!Number.isInteger(n) || n <= 0)) {
      return `query.${name} must be a positive integer.`;
    }
  }
  return null;
}

export const SimulationInputSchema = z.object({
  operation: z.enum(['read', 'write', 'validate']),
  path: z.string().min(1).startsWith('/'),
  auth: z.union([
    z.object({
      uid: z.string(),
      tenant: z.string().optional(),
      token: z.record(z.unknown()).optional(),
    }),
    z.null(),
  ]),
  mockData: z.record(z.unknown()),
  newData: z.unknown().optional(),
  /**
   * The full set of paths written together in one atomic multi-path
   * `update()` (the `{ "/a/b": 1, "/c/d": 2 }` shape). When present, the
   * simulator projects EVERY listed path onto a single post-write tree and
   * evaluates `path`'s rules against that shared projection — so a rule on
   * one written path sees `newData` reflecting its sibling paths in the
   * same update. Omit for single-path writes (the simulator then projects
   * only `path`/`newData`). Each path is absolute (root-relative).
   */
  updates: z
    .array(z.object({ path: z.string().min(1).startsWith('/'), value: z.unknown() }))
    .optional(),
  query: SimulationQuerySchema.optional(),
  /**
   * The instant the rules engine reports as `now`, in epoch milliseconds.
   * Callers hosting a sandbox pass their sandbox clock so a `now`-gated rule
   * moves with it. Omitted, the engine reads the wall clock.
   */
  now: z.number().optional(),
});
export type SimulationInput = z.infer<typeof SimulationInputSchema>;

export const SimulateErrorCode = z.enum([
  'INVALID_INPUT',
  'NO_MATCHING_RULE',
  'EVALUATION_ERROR',
]);

export const SimulationResultSchema = z.object({
  allowed: z.boolean(),
  /** True when this outcome is a simulator gap — an unparseable/unevaluable
   *  rule expression the engine abstained on rather than genuinely denied.
   *  `allowed` is always `false` alongside this (abstain, never grant). */
  unsupported: z.boolean().optional(),
  matchedPath: z.string(),
  matchedRule: z.string(),
  reason: z.string(),
  pathVariableBindings: z.record(z.string()),
});
export type SimulationResult = z.infer<typeof SimulationResultSchema>;

export type SimulateResult =
  | { success: true; data: SimulationResult }
  | { success: false; error: { code: z.infer<typeof SimulateErrorCode>; message: string; recoverable: boolean } };
