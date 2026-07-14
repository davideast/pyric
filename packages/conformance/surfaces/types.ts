/**
 * Typed surface descriptor data.
 *
 * `packages/conformance/surfaces/` is the index: one authored
 * `SurfaceDescriptorRecord` per file, named `<surface-key>.ts`. The filename IS
 * the surface key — records carry no `surface` field; `load.ts` derives it from
 * the filename and injects it, resolving the `registry` key string to the
 * registry object at the same time. This mirrors the one-record-per-file
 * convention `rigs/` and `observations/` already use.
 *
 * A descriptor consolidates everything a script needs to know about one
 * compatibility surface: which upstream module and mirror module(s) the export
 * census diffs, which registry doc hosts its rows, which observation filename
 * prefixes it owns, whether it is published in compat:coverage, its scope
 * statement, its conformance suite, and which capture rigs produce its
 * observations. Adding a surface is one file here plus (if it needs its own
 * doc) a registry file.
 */
import type { CensusSurface } from '../src/surface-denylist.ts';
import type { CompatibilitySurfaceRegistry, Surface } from '../registry/types.ts';

/**
 * Fields every surface descriptor carries regardless of `kind`. `surface` is
 * deliberately absent — the loader derives it from the filename so the key
 * lives in exactly one place (the filename itself).
 */
interface SurfaceDescriptorRecordBase {
  /**
   * Ordinal for stable output ordering (the compat:coverage table, compat:report
   * surface list, and registry iteration). The loader sorts by it; filename sort
   * alone would reorder the published table.
   */
  order: number;
  /**
   * The hosting registry's `surface` field, as a key string the loader resolves
   * to the registry object (and its compatPath). Two descriptors may name the
   * same registry: `rtdb-modular` shares the `rtdb` registry, `messaging-admin`
   * the `messaging` registry, and `firestore-rules` / `storage-rules` share the
   * `rules` registry.
   */
  registry: string;
  /**
   * Exact observation filename prefixes this surface owns
   * (`observations/<prefix>*.json`). Longest prefix wins. A surface may own more
   * than one (auth owns `auth-` and `admin-app-`). The rules surfaces own the
   * `rules-firestore-` / `rules-storage-` prefixes moved off firestore/storage.
   */
  observationPrefixes: string[];
  /**
   * Whether this surface is published in compat:coverage (the SERVICES set).
   * `messaging-admin` is false — the admin send plane mirrors firebase-admin,
   * which has no runtime export census in this report. Native surfaces publish
   * behavior conformance normally; their SURFACE column reads `native` (no
   * upstream denominator), see coverage.ts.
   */
  coverage: boolean;
  /** One-line coverage scope statement (what is genuinely out of scope vs deferred). */
  scopeNote: string;
  /** Repo-relative conformance suite path, if any. */
  conformanceSuite?: string;
  /** Rig ids (`rigs/<id>.ts`) whose captures land under this surface's prefixes. */
  captureRigs: string[];
  /**
   * A surface climbing under Conformance Driven Development (CDD): rows are
   * authored born-`unverified` before implementation. The climb lane and
   * compat:report select surfaces by this marker. See `docs/conformance/cdd.md`.
   */
  climb?: boolean;
}

/**
 * A MIRROR surface: there is an upstream `firebase/*` module and a `pyric/*`
 * mirror, and surface-census.ts diffs their export name sets. This is every
 * descriptor that participates in the breadth census.
 */
export interface MirrorSurfaceDescriptorRecord extends SurfaceDescriptorRecordBase {
  kind: 'mirror';
  /**
   * The underlying export-census surface (surface-census.ts). `rtdb-modular`
   * maps to `database`.
   */
  censusSurface: CensusSurface;
  /** Upstream `firebase/*` module the export census diffs against the mirror. */
  upstream: string;
  /**
   * Mirror `pyric/*` module specifier(s). A symbol counts as mapped if ANY
   * mirror module exports it (database's modular surface plus the barrel are
   * both consulted).
   */
  mirrors: string[];
}

/**
 * A NATIVE surface: there is NO upstream module to mirror, so the census
 * (breadth) axis has no denominator. The claimable universe is instead the
 * surface's OWN public API, declared as `symbolSource`. Native descriptors
 * carry none of the census fields (`censusSurface` / `upstream` / `mirrors`).
 * `symbolSource` is declared data for now — the Phase 3 symbol-claims gate
 * that enumerates its exports and requires each to be claimed by a registry
 * row is not built yet.
 */
export interface NativeSurfaceDescriptorRecord extends SurfaceDescriptorRecordBase {
  kind: 'native';
  /**
   * The module specifier whose PUBLIC export set is this surface's claimable
   * symbol universe (the census analog for a surface with no upstream), e.g.
   * `pyric/rules`. Shared registries union their descriptors' symbolSources.
   */
  symbolSource: string;
}

/**
 * An INTEGRATION surface: Pyric does not mirror an upstream package and does
 * not introduce its own public package. Instead it runs unchanged upstream
 * application code against the sandbox through a runtime integration seam.
 * Its breadth is the explicitly signed contract inventory, not an export
 * census and not a Pyric-native symbol set.
 */
export interface IntegrationSurfaceDescriptorRecord extends SurfaceDescriptorRecordBase {
  kind: 'integration';
  /** Upstream entry point whose unchanged source defines the integration. */
  contractSource: string;
}

/**
 * The record authored in each `surfaces/<key>.ts` file — a discriminated union
 * on `kind`. `surface-census.ts` and `coverage.ts` branch on `kind` (never on
 * the surface name string) to decide which axis applies.
 */
export type SurfaceDescriptorRecord =
  | MirrorSurfaceDescriptorRecord
  | NativeSurfaceDescriptorRecord
  | IntegrationSurfaceDescriptorRecord;

interface SurfaceDescriptorResolved {
  /** Derived from the filename. */
  surface: Surface;
  /** The registry key string as authored (kept for validation/reporting). */
  registryKey: string;
  /** The resolved registry object hosting this surface's rows. */
  registry: CompatibilitySurfaceRegistry;
  /** Convenience mirror of the resolved registry's compatPath. */
  compatPath: string;
}

/** The loaded MIRROR descriptor: the authored record plus resolved fields. */
export interface MirrorSurfaceDescriptor
  extends Omit<MirrorSurfaceDescriptorRecord, 'registry'>,
    SurfaceDescriptorResolved {}

/** The loaded NATIVE descriptor: the authored record plus resolved fields. */
export interface NativeSurfaceDescriptor
  extends Omit<NativeSurfaceDescriptorRecord, 'registry'>,
    SurfaceDescriptorResolved {}

/** The loaded INTEGRATION descriptor. */
export interface IntegrationSurfaceDescriptor
  extends Omit<IntegrationSurfaceDescriptorRecord, 'registry'>,
    SurfaceDescriptorResolved {}

/** The loaded shape: a discriminated union on `kind`, mirroring the authored record. */
export type SurfaceDescriptor =
  | MirrorSurfaceDescriptor
  | NativeSurfaceDescriptor
  | IntegrationSurfaceDescriptor;

/**
 * An export-census surface with NO COMPAT matrix — it exists only for the
 * surface-census export gate, not for coverage or behavior tracking. `app` (no
 * COMPAT doc) and `messaging-sw` (the service-worker receive plane) are the two.
 * Kept separate from the surface descriptors because they have none of a
 * descriptor's other metadata (no registry, no rows, no coverage membership).
 */
export interface CensusOnlyPair {
  order: number;
  censusSurface: CensusSurface;
  upstream: string;
  mirrors: string[];
}

/** A census mirror pair as surface-census.ts consumes it. */
export interface CensusMirrorPair {
  surface: CensusSurface;
  upstream: string;
  mirrors: string[];
}
