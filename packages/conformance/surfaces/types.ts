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
 * The record authored in each `surfaces/<key>.ts` file. `surface` is deliberately
 * absent — the loader derives it from the filename so the key lives in exactly
 * one place (the filename itself).
 */
export interface SurfaceDescriptorRecord {
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
   * the `messaging` registry.
   */
  registry: string;
  /**
   * The underlying export-census surface (surface-census.ts). `rtdb` and
   * `rtdb-modular` both map to `database` — surface-census does not distinguish
   * the classic vs modular database export sets, so both report the same
   * measurement.
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
  /**
   * Exact observation filename prefixes this surface owns
   * (`observations/<prefix>*.json`). Longest prefix wins. A surface may own more
   * than one (auth owns `auth-` and `admin-app-`; firestore `firestore-` and
   * `rules-firestore-`; storage `storage-` and `rules-storage-`).
   */
  observationPrefixes: string[];
  /**
   * Whether this surface is published in compat:coverage (the SERVICES set).
   * `messaging-admin` is false — the admin send plane mirrors firebase-admin,
   * which has no runtime export census in this report.
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

/** The loaded shape: the authored record plus the surface key and resolved registry. */
export interface SurfaceDescriptor extends Omit<SurfaceDescriptorRecord, 'registry'> {
  /** Derived from the filename. */
  surface: Surface;
  /** The registry key string as authored (kept for validation/reporting). */
  registryKey: string;
  /** The resolved registry object hosting this surface's rows. */
  registry: CompatibilitySurfaceRegistry;
  /** Convenience mirror of the resolved registry's compatPath. */
  compatPath: string;
}

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
