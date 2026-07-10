import { z } from 'zod';

export const SimulationInputSchema = z.object({
  operation: z.enum(['read', 'write', 'validate']),
  path: z.string().min(1).startsWith('/'),
  auth: z.union([
    z.object({ uid: z.string(), token: z.record(z.unknown()) }),
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
});
export type SimulationInput = z.infer<typeof SimulationInputSchema>;

export const SimulateErrorCode = z.enum([
  'IR_NOT_GENERATED',
  'INVALID_INPUT',
  'NO_MATCHING_RULE',
  'EVALUATION_ERROR',
]);

export const SimulationResultSchema = z.object({
  allowed: z.boolean(),
  matchedPath: z.string(),
  matchedRule: z.string(),
  reason: z.string(),
  pathVariableBindings: z.record(z.string()),
});
export type SimulationResult = z.infer<typeof SimulationResultSchema>;

export type SimulateResult =
  | { success: true; data: SimulationResult }
  | { success: false; error: { code: z.infer<typeof SimulateErrorCode>; message: string; recoverable: boolean } };
