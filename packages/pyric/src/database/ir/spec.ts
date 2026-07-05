import { z } from 'zod';

export const GenerateIRInputSchema = z.object({
  databaseUrl: z.string().url(),
});
export type GenerateIRInput = z.infer<typeof GenerateIRInputSchema>;

export const RtdbIRErrorCode = z.enum([
  'RULES_FETCH_FAILED',
  'RULES_PARSE_FAILED',
  'INVALID_RULES_JSON',
  'SHALLOW_FETCH_FAILED',
]);

export type GenerateIRResult =
  | { success: true; data: import('../types.js').RtdbIR }
  | { success: false; error: { code: z.infer<typeof RtdbIRErrorCode>; message: string; recoverable: boolean } };

export interface GenerateIRSpec {
  execute(host: import('../host.js').RtdbHost): Promise<GenerateIRResult>;
}
