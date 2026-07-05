import { z } from 'zod';
import type { RtdbHost } from '../host.js';

export type DataOperation = 'get' | 'set' | 'update' | 'push' | 'remove';

export const DataErrorCode = z.enum([
  'READ_FAILED',
  'WRITE_FAILED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
]);

export type DataResult =
  | { success: true; data: unknown }
  | { success: false; error: { code: z.infer<typeof DataErrorCode>; message: string; recoverable: boolean } };

export type SchemaWarning = {
  field: string;
  issue: 'type_mismatch' | 'new_field';
  expected?: string;
  actual: string;
};

export type ValidatedWriteInput = {
  path: string;
  data: unknown;  // required — must be explicitly provided
  operation: 'set' | 'update' | 'push';
  auth: { uid: string; token: Record<string, unknown> } | null;
};

export const ValidatedWriteInputSchema = z.object({
  path: z.string().describe('Database path to write to'),
  data: z.any().transform((v) => v ?? null).describe('The data to write'),
  operation: z.enum(['set', 'update', 'push']).describe('Write operation type'),
  auth: z.union([
    z.object({ uid: z.string(), token: z.record(z.unknown()) }),
    z.null(),
  ]).describe('Auth context for simulation'),
});

export type ValidatedWriteResult =
  | {
      success: true;
      data: unknown;
      schemaWarnings: SchemaWarning[];
      simulationResult: { allowed: boolean; matchedRule: string } | null;
    }
  | { success: false; error: { code: string; message: string; recoverable: boolean } };
