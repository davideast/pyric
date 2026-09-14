import { z } from 'zod';

/** A service command addresses the host instance selected by project discovery. */
export const HOSTED_METHOD_PATH = '/__pyric/hosted/method';
export const HOSTED_METHOD_BODY_LIMIT = 12 * 1024 * 1024;
/** Active command owners include closed connections whose accepted work is draining. */
export const MAX_HOSTED_METHOD_OWNERS = 64;
export const hostedMethodRequest = z.object({
  instanceId: z.string(),
  projectDir: z.string(),
  key: z.string(),
  args: z.record(z.unknown()),
}).strict();

export type HostedMethodRequest = z.infer<typeof hostedMethodRequest>;

export const hostedMethodResult = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.unknown().optional(),
});
