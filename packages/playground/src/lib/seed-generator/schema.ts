/**
 * Zod schema for AI-generated seed proposals (Seed tab v1).
 */
import { z } from 'zod';

export const SeedAuthUserSchema = z.object({
  uid: z.string().min(1),
  email: z.string().optional(),
  password: z.string().optional(),
  displayName: z.string().optional(),
  customClaims: z.record(z.unknown()).optional(),
});

export const SeedProposalV1Schema = z.object({
  version: z.literal(1),
  summary: z.string().optional(),
  firestore: z.record(z.union([z.record(z.unknown()), z.array(z.unknown())])),
  auth: z.array(SeedAuthUserSchema).optional(),
});

export type SeedProposalV1 = z.infer<typeof SeedProposalV1Schema>;
export type SeedAuthUserProposal = z.infer<typeof SeedAuthUserSchema>;
