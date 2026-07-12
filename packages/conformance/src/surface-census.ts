#!/usr/bin/env bun
/**
 * Surface census — tier 1 (runtime exports).
 *
 * For each mirror pair (firebase/<x> → pyric/<x>) this imports both modules at
 * runtime and diffs their export name sets. Every upstream export must be one
 * of:
 *   1. MAPPED   — re-exported by the mirror, or
 *   2. DENIED   — listed in packages/conformance/src/surface-denylist.ts with a reason, or
 *   3. UNMAPPED — a genuine gap. Any UNMAPPED symbol fails the gate (exit 1).
 *
 * The deny-list itself is also checked for two decay classes, both FATAL —
 * an out-of-date deny-list is worse than no deny-list, since it hides real
 * drift behind a stale reason:
 *   - STALE     — the deny-listed symbol is no longer exported upstream at
 *                 all (the entry denies nothing real anymore).
 *   - REDUNDANT — the deny-listed symbol IS mirrored (the denial was never
 *                 dropped after the gap was closed; see 'beforeAuthStateChanged'
 *                 for the shape of this mistake).
 * Any STALE or REDUNDANT entry fails the gate (exit 1) in both summary and
 * --json modes, alongside (not instead of) the existing UNMAPPED failure.
 *
 * Extra mirror-side exports (pyric-only APIs — sandbox helpers, admin tools,
 * rules schemas, …) are reported informationally and NEVER fail the run.
 *
 * Usage:
 *   bun run packages/conformance/src/surface-census.ts            # gate: summary + gaps, exit 1 on UNMAPPED
 *   bun run packages/conformance/src/surface-census.ts --report   # full inventory, still exits 1 on UNMAPPED
 *   bun run packages/conformance/src/surface-census.ts --json      # machine-readable, exit 1 on UNMAPPED
 *
 * House style: descriptor-driven (the pairs below are the one list), typed, and
 * no regex in the trust path — every classification is exact Set/Map lookup.
 */
import { denylistFor, type CensusSurface } from './surface-denylist.ts';
import { loadCensusPairs } from '../surfaces/load.ts';
import type { CensusMirrorPair as MirrorPair } from '../surfaces/types.ts';

/**
 * The tier-1 mirror pairs. Derived from the surface descriptors (deduped by
 * census surface — `rtdb` and `rtdb-modular` share the `database` census) merged
 * with the census-only surfaces `app` and `messaging-sw` (no COMPAT matrix; see
 * surfaces/census-only.ts). Adding a surface is a descriptor file, not an entry
 * here.
 */
const mirrorPairs: MirrorPair[] = loadCensusPairs();

interface DeniedSymbol {
  symbol: string;
  reason: string;
}

interface SurfaceCensus {
  surface: CensusSurface;
  upstream: string;
  mirrors: string[];
  upstreamCount: number;
  mirrorCount: number;
  mapped: string[];
  denied: DeniedSymbol[];
  unmapped: string[];
  /** Mirror-only exports (pyric-native surface). Informational only. */
  extra: string[];
  /** Deny-list entries whose symbol is no longer exported upstream. */
  staleDenials: string[];
  /** Deny-list entries whose symbol IS mirrored (redundant deny). */
  redundantDenials: string[];
}

async function exportNames(specifier: string): Promise<string[]> {
  const mod = await import(specifier);
  return Object.keys(mod);
}

async function censusForPair(pair: MirrorPair): Promise<SurfaceCensus> {
  const upstream = new Set(await exportNames(pair.upstream));
  const mirror = new Set<string>();
  for (const spec of pair.mirrors) {
    for (const name of await exportNames(spec)) mirror.add(name);
  }
  const denials = denylistFor(pair.surface);

  const mapped: string[] = [];
  const denied: DeniedSymbol[] = [];
  const unmapped: string[] = [];

  for (const symbol of [...upstream].sort()) {
    if (mirror.has(symbol)) {
      mapped.push(symbol);
    } else if (denials.has(symbol)) {
      denied.push({ symbol, reason: denials.get(symbol)! });
    } else {
      unmapped.push(symbol);
    }
  }

  const extra = [...mirror].filter((s) => !upstream.has(s)).sort();
  const staleDenials = [...denials.keys()].filter((s) => !upstream.has(s)).sort();
  const redundantDenials = [...denials.keys()].filter((s) => mirror.has(s)).sort();

  return {
    surface: pair.surface,
    upstream: pair.upstream,
    mirrors: pair.mirrors,
    upstreamCount: upstream.size,
    mirrorCount: mirror.size,
    mapped,
    denied,
    unmapped,
    extra,
    staleDenials,
    redundantDenials,
  };
}

function printReport(censuses: SurfaceCensus[]): void {
  for (const c of censuses) {
    console.log(`\n## ${c.upstream} → ${c.mirrors.join(' + ')}`);
    console.log(`upstream ${c.upstreamCount} · mirror ${c.mirrorCount} · mapped ${c.mapped.length} · denied ${c.denied.length} · unmapped ${c.unmapped.length} · extra ${c.extra.length}`);
    console.log(`\n  MAPPED (${c.mapped.length}): ${c.mapped.join(', ') || '—'}`);
    console.log(`\n  DENIED (${c.denied.length}):`);
    for (const d of c.denied) console.log(`    - ${d.symbol}: ${d.reason}`);
    if (c.denied.length === 0) console.log('    —');
    console.log(`\n  UNMAPPED (${c.unmapped.length}): ${c.unmapped.join(', ') || '—'}`);
    console.log(`\n  EXTRA / pyric-only (${c.extra.length}): ${c.extra.join(', ') || '—'}`);
    if (c.staleDenials.length > 0) console.log(`\n  ! STALE deny-list entries (no longer upstream): ${c.staleDenials.join(', ')}`);
    if (c.redundantDenials.length > 0) console.log(`\n  ! REDUNDANT deny-list entries (symbol IS mirrored): ${c.redundantDenials.join(', ')}`);
  }
}

function printSummary(censuses: SurfaceCensus[]): void {
  console.log('# Surface census — tier 1 (runtime exports)\n');
  console.log('surface     upstream  mapped  denied  unmapped  extra');
  for (const c of censuses) {
    const row = [
      c.surface.padEnd(11),
      String(c.upstreamCount).padStart(8),
      String(c.mapped.length).padStart(7),
      String(c.denied.length).padStart(7),
      String(c.unmapped.length).padStart(9),
      String(c.extra.length).padStart(6),
    ].join('');
    console.log(row);
  }

  const withGaps = censuses.filter((c) => c.unmapped.length > 0);
  if (withGaps.length > 0) {
    console.log('\n## UNMAPPED gaps\n');
    for (const c of withGaps) {
      console.log(`- ${c.surface} (${c.unmapped.length}): ${c.unmapped.join(', ')}`);
    }
  }

  const staleOrRedundant = censuses.filter((c) => c.staleDenials.length > 0 || c.redundantDenials.length > 0);
  if (staleOrRedundant.length > 0) {
    console.log('\n## Deny-list decay (FATAL)\n');
    for (const c of staleOrRedundant) {
      if (c.staleDenials.length > 0) console.log(`- ${c.surface}: stale (not upstream) — ${c.staleDenials.join(', ')}`);
      if (c.redundantDenials.length > 0) console.log(`- ${c.surface}: redundant (mirrored) — ${c.redundantDenials.join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  const wantReport = process.argv.includes('--report');
  const wantJson = process.argv.includes('--json');

  const censuses: SurfaceCensus[] = [];
  for (const pair of mirrorPairs) censuses.push(await censusForPair(pair));

  const totalUnmapped = censuses.reduce((n, c) => n + c.unmapped.length, 0);
  const totalStaleOrRedundant = censuses.reduce((n, c) => n + c.staleDenials.length + c.redundantDenials.length, 0);

  if (wantJson) {
    console.log(JSON.stringify({ surfaces: censuses, totalUnmapped, totalStaleOrRedundant }, null, 2));
    process.exit(totalUnmapped > 0 || totalStaleOrRedundant > 0 ? 1 : 0);
  }

  if (wantReport) {
    printReport(censuses);
    console.log('');
  }
  printSummary(censuses);

  if (totalStaleOrRedundant > 0) {
    console.log(`\n✗ ${totalStaleOrRedundant} stale or redundant deny-list entr${totalStaleOrRedundant === 1 ? 'y' : 'ies'}. A stale entry denies a symbol no longer exported upstream; a redundant entry denies a symbol that IS mirrored. Remove them from packages/conformance/src/surface-denylist.ts.`);
  }
  if (totalUnmapped > 0) {
    console.log(`\n✗ ${totalUnmapped} unmapped upstream symbol(s). Mirror them, or add a deny-list entry with a reason in packages/conformance/src/surface-denylist.ts.`);
  }
  if (totalUnmapped > 0 || totalStaleOrRedundant > 0) {
    process.exit(1);
  }
  console.log('\n✓ Every upstream export is mapped or deny-listed, and the deny-list is clean.');
  process.exit(0);
}

await main();
