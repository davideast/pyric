import { z } from 'zod';

export const ManageDomainsInputSchema = z.object({
  action: z.enum(['add', 'remove', 'list']).describe('Action to perform: add a domain, remove a domain, or list all authorized domains'),
  domain: z.string().optional().describe('The domain to add or remove (required for add/remove, ignored for list)'),
});
export type ManageDomainsInput = z.infer<typeof ManageDomainsInputSchema>;

export type ManageDomainsResult =
  | { success: true; authorizedDomains: string[]; warning?: string }
  | { success: false; error: { code: string; message: string; recoverable: boolean } };
