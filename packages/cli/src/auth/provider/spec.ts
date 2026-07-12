import { z } from 'zod';

export const ProviderIdSchema = z.enum(['anonymous', 'email', 'phone', 'google']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ConfigureProviderInputSchema = z.object({
  provider: ProviderIdSchema.describe('The auth provider to configure: anonymous, email, phone, or google'),
  enabled: z.boolean().describe('Whether to enable (true) or disable (false) the provider'),
});
export type ConfigureProviderInput = z.infer<typeof ConfigureProviderInputSchema>;

export type ConfigureAuthResult =
  | { success: true; provider: string; enabled: boolean; warning?: string }
  | { success: false; error: { code: string; message: string; recoverable: boolean } };

export const ConfigureAuthErrorCode = z.enum([
  'PROVIDER_CONFIG_FAILED',
  'PERMISSION_DENIED',
  'GOOGLE_NOT_PROVISIONED',
]);
