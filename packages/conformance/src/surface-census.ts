#!/usr/bin/env bun
/**
 * Firebase public-surface census.
 *
 * Runtime and type exports are measured separately. The public denominator is
 * mechanical: every non-underscore Firebase export counts. A public export is
 * either mirrored, dispositioned with a reviewed reason, or unmapped. Both
 * dispositioned and unmapped public exports stay in the coverage denominator.
 *
 * Leading-underscore Firebase exports are private implementation plumbing.
 * They remain visible in the raw diagnostic but never enter public coverage
 * and never require a product-scope disposition.
 */
import { dispositionTiersFor, dispositionsFor, loadCensusPairs } from '../surfaces/load.ts';
import type { CensusSurface, DispositionTier } from '../surfaces/types.ts';
import { isPublicExportName, publicRuntimeExportNamesFromSource, publicTypeExportNames } from './public-exports.ts';
import type { CensusMirrorPair as MirrorPair } from '../surfaces/types.ts';
import { workspaceSourceEntry } from './workspace-entry.ts';

export interface DispositionedSymbol {
  symbol: string;
  reason: string;
  tier: DispositionTier;
}

export interface PublicRuntimeCensus {
  upstreamCount: number;
  mirrorCount: number;
  mapped: string[];
  dispositioned: DispositionedSymbol[];
  unmapped: string[];
  /** Upstream runtime exports excluded by the public-name rule. */
  privateUpstream: string[];
  /** Mirror-only runtime exports. Informational, never coverage credit. */
  extra: string[];
  /** Dispositions whose symbol is no longer a public upstream runtime export. */
  staleDispositions: string[];
  /** Dispositions whose symbol is now mirrored and must be removed. */
  redundantDispositions: string[];
}

export interface PublicTypeCensus {
  upstreamCount: number;
  mirrorCount: number;
  mapped: string[];
  unmapped: string[];
  /** Mirror-only exported types. Informational, never coverage credit. */
  extra: string[];
}

export interface RawRuntimeDiagnostic {
  upstreamCount: number;
  mirrorCount: number;
  mappedCount: number;
}

export interface SurfaceCensus {
  surface: CensusSurface;
  upstream: string;
  mirrors: string[];
  runtime: PublicRuntimeCensus;
  types: PublicTypeCensus;
  rawRuntime: RawRuntimeDiagnostic;
}

async function runtimeExportNames(specifier: string): Promise<string[]> {
  const source = workspaceSourceEntry(specifier);
  if (source) return publicRuntimeExportNamesFromSource(source);
  const mod = await import(specifier) as Record<string, unknown>;
  return Object.keys(mod).sort();
}

export async function censusForPair(pair: MirrorPair): Promise<SurfaceCensus> {
  const rawUpstream = new Set(await runtimeExportNames(pair.upstream));
  const rawMirror = new Set<string>();
  for (const specifier of pair.mirrors) {
    for (const name of await runtimeExportNames(specifier)) rawMirror.add(name);
  }

  const publicUpstream = [...rawUpstream].filter(isPublicExportName).sort();
  const publicMirror = [...rawMirror].filter(isPublicExportName).sort();
  const publicUpstreamSet = new Set(publicUpstream);
  const publicMirrorSet = new Set(publicMirror);
  const dispositions = dispositionsFor(pair.surface);
  const tiers = dispositionTiersFor(pair.surface);

  const mapped: string[] = [];
  const dispositioned: DispositionedSymbol[] = [];
  const unmapped: string[] = [];
  for (const symbol of publicUpstream) {
    if (publicMirrorSet.has(symbol)) {
      mapped.push(symbol);
    } else if (dispositions.has(symbol)) {
      dispositioned.push({
        symbol,
        reason: dispositions.get(symbol)!,
        tier: tiers.get(symbol)!,
      });
    } else {
      unmapped.push(symbol);
    }
  }

  const upstreamTypes = publicTypeExportNames([pair.upstream]);
  const mirrorTypes = publicTypeExportNames(pair.mirrors);
  const upstreamTypeSet = new Set(upstreamTypes);
  const mirrorTypeSet = new Set(mirrorTypes);

  return {
    surface: pair.surface,
    upstream: pair.upstream,
    mirrors: pair.mirrors,
    runtime: {
      upstreamCount: publicUpstream.length,
      mirrorCount: publicMirror.length,
      mapped,
      dispositioned,
      unmapped,
      privateUpstream: [...rawUpstream].filter((name) => !isPublicExportName(name)).sort(),
      extra: publicMirror.filter((name) => !publicUpstreamSet.has(name)),
      staleDispositions: [...dispositions.keys()].filter((name) => !publicUpstreamSet.has(name)).sort(),
      redundantDispositions: [...dispositions.keys()].filter((name) => publicMirrorSet.has(name)).sort(),
    },
    types: {
      upstreamCount: upstreamTypes.length,
      mirrorCount: mirrorTypes.length,
      mapped: upstreamTypes.filter((name) => mirrorTypeSet.has(name)),
      unmapped: upstreamTypes.filter((name) => !mirrorTypeSet.has(name)),
      extra: mirrorTypes.filter((name) => !upstreamTypeSet.has(name)),
    },
    rawRuntime: {
      upstreamCount: rawUpstream.size,
      mirrorCount: rawMirror.size,
      mappedCount: [...rawUpstream].filter((name) => rawMirror.has(name)).length,
    },
  };
}

export async function buildSurfaceCensus(): Promise<SurfaceCensus[]> {
  const result: SurfaceCensus[] = [];
  for (const pair of loadCensusPairs()) result.push(await censusForPair(pair));
  return result;
}

function printReport(censuses: SurfaceCensus[]): void {
  for (const census of censuses) {
    const runtime = census.runtime;
    const types = census.types;
    console.log(`\n## ${census.upstream} → ${census.mirrors.join(' + ')}`);
    console.log(`public runtime ${runtime.upstreamCount} · mapped ${runtime.mapped.length} · dispositioned ${runtime.dispositioned.length} · unmapped ${runtime.unmapped.length}`);
    console.log(`public types ${types.upstreamCount} · mapped ${types.mapped.length} · unmapped ${types.unmapped.length}`);
    console.log(`raw runtime ${census.rawRuntime.upstreamCount} upstream · ${census.rawRuntime.mappedCount} name matches`);
    console.log(`\n  PUBLIC RUNTIME MAPPED (${runtime.mapped.length}): ${runtime.mapped.join(', ') || '—'}`);
    console.log(`\n  PUBLIC RUNTIME DISPOSITIONS (${runtime.dispositioned.length}):`);
    for (const entry of runtime.dispositioned) console.log(`    - ${entry.symbol} [${entry.tier}]: ${entry.reason}`);
    if (runtime.dispositioned.length === 0) console.log('    —');
    console.log(`\n  PUBLIC RUNTIME UNMAPPED (${runtime.unmapped.length}): ${runtime.unmapped.join(', ') || '—'}`);
    console.log(`\n  PRIVATE UPSTREAM RUNTIME (${runtime.privateUpstream.length}): ${runtime.privateUpstream.join(', ') || '—'}`);
    console.log(`\n  PUBLIC TYPES MAPPED (${types.mapped.length}): ${types.mapped.join(', ') || '—'}`);
    console.log(`\n  PUBLIC TYPES UNMAPPED (${types.unmapped.length}): ${types.unmapped.join(', ') || '—'}`);
    console.log(`\n  EXTRA / PYRIC-ONLY RUNTIME (${runtime.extra.length}): ${runtime.extra.join(', ') || '—'}`);
    console.log(`\n  EXTRA / PYRIC-ONLY TYPES (${types.extra.length}): ${types.extra.join(', ') || '—'}`);
    if (runtime.staleDispositions.length > 0) console.log(`\n  ! STALE dispositions: ${runtime.staleDispositions.join(', ')}`);
    if (runtime.redundantDispositions.length > 0) console.log(`\n  ! REDUNDANT dispositions: ${runtime.redundantDispositions.join(', ')}`);
  }
}

function printSummary(censuses: SurfaceCensus[]): void {
  console.log('# Firebase public-surface census\n');
  console.log('surface       runtime public/mapped/gaps   types public/mapped/gaps   private runtime');
  for (const census of censuses) {
    const runtimeGaps = census.runtime.upstreamCount - census.runtime.mapped.length;
    const typeGaps = census.types.upstreamCount - census.types.mapped.length;
    console.log([
      census.surface.padEnd(13),
      `${census.runtime.upstreamCount}/${census.runtime.mapped.length}/${runtimeGaps}`.padStart(26),
      `${census.types.upstreamCount}/${census.types.mapped.length}/${typeGaps}`.padStart(25),
      String(census.runtime.privateUpstream.length).padStart(18),
    ].join(''));
  }

  const runtimeGaps = censuses.filter((census) => census.runtime.unmapped.length > 0);
  if (runtimeGaps.length > 0) {
    console.log('\n## Unmapped public runtime exports\n');
    for (const census of runtimeGaps) console.log(`- ${census.surface}: ${census.runtime.unmapped.join(', ')}`);
  }
  const typeGaps = censuses.filter((census) => census.types.unmapped.length > 0);
  if (typeGaps.length > 0) {
    console.log('\n## Unmapped public type exports\n');
    for (const census of typeGaps) console.log(`- ${census.surface}: ${census.types.unmapped.join(', ')}`);
  }
}

async function main(): Promise<void> {
  const wantReport = process.argv.includes('--report');
  const wantJson = process.argv.includes('--json');
  const censuses = await buildSurfaceCensus();
  const totalRuntimeUnmapped = censuses.reduce((count, census) => count + census.runtime.unmapped.length, 0);
  const totalTypeUnmapped = censuses.reduce((count, census) => count + census.types.unmapped.length, 0);
  const totalStaleOrRedundant = censuses.reduce(
    (count, census) => count + census.runtime.staleDispositions.length + census.runtime.redundantDispositions.length,
    0,
  );

  if (wantJson) {
    console.log(JSON.stringify({ surfaces: censuses, totalRuntimeUnmapped, totalTypeUnmapped, totalStaleOrRedundant }, null, 2));
    process.exit(totalRuntimeUnmapped > 0 || totalTypeUnmapped > 0 || totalStaleOrRedundant > 0 ? 1 : 0);
  }

  if (wantReport) printReport(censuses);
  printSummary(censuses);

  if (totalStaleOrRedundant > 0) console.log(`\n✗ ${totalStaleOrRedundant} stale or redundant public-surface disposition(s).`);
  if (totalRuntimeUnmapped > 0) console.log(`\n✗ ${totalRuntimeUnmapped} unmapped public runtime export(s).`);
  if (totalTypeUnmapped > 0) console.log(`\n✗ ${totalTypeUnmapped} unmapped public type export(s).`);
  if (totalRuntimeUnmapped > 0 || totalTypeUnmapped > 0 || totalStaleOrRedundant > 0) process.exit(1);

  console.log('\n✓ Every public Firebase runtime and type export is mirrored or explicitly tracked.');
}

if (import.meta.main) await main();
