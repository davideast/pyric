import { z } from 'zod';
import type { RtdbHost } from '../host.js';
import type { RtdbIR } from '../types.js';

export const WriteRulesErrorCode = z.enum([
  'WRITE_FAILED',
  'PERMISSION_DENIED',
  'INVALID_RULES_JSON',
]);

export type WriteRulesResult =
  | { success: true }
  | { success: false; error: { code: z.infer<typeof WriteRulesErrorCode>; message: string; recoverable: boolean } };

export interface WriteRulesSpec {
  execute(host: RtdbHost, ir: RtdbIR): Promise<WriteRulesResult>;
}
