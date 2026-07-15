import { z } from 'zod';
import type { CompatibilitySurfaceRegistry, Surface } from '../registry/types.ts';

export const SURFACE_CONTRACT_SCHEMA = 'pyric.conformance.surface.v1' as const;
export type CensusSurface = string;
export type DispositionTier = 'out-of-scope' | 'deferred';

export const dispositionGroupSchema = z.object({
  tier: z.enum(['out-of-scope', 'deferred']),
  reason: z.string().trim().min(1),
  symbols: z.array(z.string().trim().min(1)).min(1),
}).strict();

const contractBase = {
  schema: z.literal(SURFACE_CONTRACT_SCHEMA),
  order: z.number().finite(),
};

const descriptorBase = {
  ...contractBase,
  registry: z.string().trim().min(1),
  observationPrefixes: z.array(z.string().trim().min(1)).min(1),
  coverage: z.boolean(),
  scopeNote: z.string().trim().min(1),
  conformanceSuite: z.string().trim().min(1).optional(),
  captureRigs: z.array(z.string().trim().min(1)),
  climb: z.boolean().optional(),
};

export const mirrorSurfaceContractSchema = z.object({
  ...descriptorBase,
  kind: z.literal('mirror'),
  censusSurface: z.string().trim().min(1),
  upstream: z.string().trim().min(1),
  mirrors: z.array(z.string().trim().min(1)).min(1),
  dispositions: z.array(dispositionGroupSchema).default([]),
}).strict();

export const nativeSurfaceContractSchema = z.object({
  ...descriptorBase,
  kind: z.literal('native'),
  symbolSource: z.string().trim().min(1),
}).strict();

export const integrationSurfaceContractSchema = z.object({
  ...descriptorBase,
  kind: z.literal('integration'),
  contractSource: z.string().trim().min(1),
}).strict();

export const censusOnlySurfaceContractSchema = z.object({
  ...contractBase,
  kind: z.literal('census-only'),
  censusSurface: z.string().trim().min(1),
  upstream: z.string().trim().min(1),
  mirrors: z.array(z.string().trim().min(1)).min(1),
  dispositions: z.array(dispositionGroupSchema).default([]),
}).strict();

export const surfaceContractSchema = z.discriminatedUnion('kind', [
  mirrorSurfaceContractSchema,
  nativeSurfaceContractSchema,
  integrationSurfaceContractSchema,
  censusOnlySurfaceContractSchema,
]);

export type DispositionGroup = z.infer<typeof dispositionGroupSchema>;
export type MirrorSurfaceContract = z.infer<typeof mirrorSurfaceContractSchema>;
export type NativeSurfaceContract = z.infer<typeof nativeSurfaceContractSchema>;
export type IntegrationSurfaceContract = z.infer<typeof integrationSurfaceContractSchema>;
export type CensusOnlySurfaceContract = z.infer<typeof censusOnlySurfaceContractSchema>;
export type SurfaceContract = z.infer<typeof surfaceContractSchema>;
export type SurfaceDescriptorRecord =
  | MirrorSurfaceContract
  | NativeSurfaceContract
  | IntegrationSurfaceContract;

interface SurfaceDescriptorResolved {
  surface: Surface;
  registryKey: string;
  registry: CompatibilitySurfaceRegistry;
  compatPath: string;
}

export type MirrorSurfaceDescriptor =
  Omit<MirrorSurfaceContract, 'registry'> & SurfaceDescriptorResolved;
export type NativeSurfaceDescriptor =
  Omit<NativeSurfaceContract, 'registry'> & SurfaceDescriptorResolved;
export type IntegrationSurfaceDescriptor =
  Omit<IntegrationSurfaceContract, 'registry'> & SurfaceDescriptorResolved;
export type SurfaceDescriptor =
  | MirrorSurfaceDescriptor
  | NativeSurfaceDescriptor
  | IntegrationSurfaceDescriptor;

export interface CensusMirrorPair {
  surface: CensusSurface;
  upstream: string;
  mirrors: string[];
}

export interface SurfaceDisposition {
  surface: CensusSurface;
  symbol: string;
  reason: string;
  tier: DispositionTier;
}
