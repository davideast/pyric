import type { CompatibilitySurfaceRegistry, DeveloperSurface, Surface } from '../registry/types.ts';

export const SURFACE_CONTRACT_SCHEMA = 'pyric.conformance.surface.v2' as const;
export type CensusSurface = string;
export type DispositionState =
  | { availability: 'out-of-scope'; reasonCode: 'upstream-deprecated' }
  | { availability: 'deferred'; reasonCode: 'implementation-deferred' };
export type DispositionAvailability = DispositionState['availability'];

interface DispositionGroupBase {
  id: string;
  summary: string;
  evidenceRefs: string[];
  symbols: string[];
}
export type DispositionGroup = DispositionGroupBase & DispositionState;

interface ContractBase {
  schema: typeof SURFACE_CONTRACT_SCHEMA;
  developerSurface: DeveloperSurface;
}

interface EvidenceRoutedContract {
  /** Published imports whose API-reference pages should link to this
   * compatibility surface. Mirror contracts derive routing from `mirrors`, so
   * only non-mirror descriptors may author associations that cannot be inferred. */
  evidenceImports?: string[];
}

interface DescriptorBase extends ContractBase {
  registry: string;
  observationPrefixes: string[];
  coverage: boolean;
  scopeNote?: string;
  conformanceSuite?: string;
  captureRigs: string[];
  climb?: boolean;
}

export interface MirrorSurfaceContract extends DescriptorBase {
  kind: 'mirror';
  censusSurface: CensusSurface;
  upstream: string;
  mirrors: string[];
  privateRuntimeExports: string[];
  dispositions: DispositionGroup[];
}

export interface NativeSurfaceContract extends DescriptorBase, EvidenceRoutedContract {
  kind: 'native';
  scopeNote: string;
  symbolSource: string;
}

export interface IntegrationSurfaceContract extends DescriptorBase, EvidenceRoutedContract {
  kind: 'integration';
  scopeNote: string;
  contractSource: string;
}

export interface RegistryOnlySurfaceContract extends DescriptorBase, EvidenceRoutedContract {
  kind: 'registry-only';
  scopeNote: string;
}

export interface CensusOnlySurfaceContract extends ContractBase {
  kind: 'census-only';
  censusSurface: CensusSurface;
  upstream: string;
  mirrors: string[];
  privateRuntimeExports: string[];
  dispositions: DispositionGroup[];
}

export type SurfaceContract =
  | MirrorSurfaceContract
  | NativeSurfaceContract
  | IntegrationSurfaceContract
  | RegistryOnlySurfaceContract
  | CensusOnlySurfaceContract;
export type SurfaceDescriptorRecord =
  | MirrorSurfaceContract
  | NativeSurfaceContract
  | IntegrationSurfaceContract
  | RegistryOnlySurfaceContract;

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
export type RegistryOnlySurfaceDescriptor =
  Omit<RegistryOnlySurfaceContract, 'registry'> & SurfaceDescriptorResolved;
export type SurfaceDescriptor =
  | MirrorSurfaceDescriptor
  | NativeSurfaceDescriptor
  | IntegrationSurfaceDescriptor
  | RegistryOnlySurfaceDescriptor;

export interface CensusMirrorPair {
  surface: CensusSurface;
  upstream: string;
  mirrors: string[];
  privateRuntimeExports: string[];
}

interface SurfaceDispositionBase {
  surface: CensusSurface;
  symbol: string;
  dispositionId: string;
  summary: string;
  evidenceRefs: string[];
}
export type SurfaceDisposition = SurfaceDispositionBase & DispositionState;
