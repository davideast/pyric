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
