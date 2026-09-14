import { z } from 'zod';

/** A service command addresses the host instance selected by project discovery. */
export const HOSTED_METHOD_PATH = '/__pyric/hosted/method';
export const HOSTED_METHOD_BODY_LIMIT = 12 * 1024 * 1024;
export const hostedMethodRequest = z.object({
  instanceId: z.string(),
  projectDir: z.string(),
  key: z.string(),
  args: z.record(z.unknown()),
}).strict();

export const hostedMethodResult = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.unknown().optional(),
});
