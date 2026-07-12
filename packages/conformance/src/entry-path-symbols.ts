#!/usr/bin/env bun
/**
 * The entry-path critical set — statically extracted, never executed.
 *
 * Parses every `entry-path/<name>.ts` corpus program's SOURCE TEXT (simple
 * regex-based import parsing — deliberately NOT a real TS/AST analysis, so
 * this has no dependency on the parallel language-analyzer branch) to find
 * which `pyric/*` package symbols the entry path actually imports, and emits
 * `entry-path/critical-symbols.json`: the computed critical set, per package.
 *
 * This is the corpus's OWN claim about what it needs — `entry-path-validate.ts`
 * cross-checks every critical symbol against the live surface census (is it
 * really exported by the mirror?) and fails fatally if a critical symbol is a
 * genuine gap with no expected-failure citation covering it.
 *
 * Only `pyric/*` import specifiers are tracked — `firebase/*`, `node:*`, and
 * bare-package imports (`fake-indexeddb/auto`, if a program ever needed one)
 * are outside the compat census's scope; a program importing something that
 * ins't a pyric mirror package has nothing for this gate to check against.
 * Type-only imports (`import type { X } from …` and the `type` modifier on an
 * individual named specifier) are excluded — the census is about RUNTIME
 * exports the mirror must actually provide, not compile-time-only types.
 *
 * Usage:
 *   bun run packages/conformance/src/entry-path-symbols.ts            # check (fails if stale)
 *   bun run packages/conformance/src/entry-path-symbols.ts --write    # regenerate + write
 *   bun run packages/conformance/src/entry-path-symbols.ts --check    # explicit check (same as default)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listEntryPathProgramFiles } from '../entry-path/load.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const CRITICAL_SYMBOLS_PATH = join(HERE, '..', 'entry-path', 'critical-symbols.json');

/** Only import specifiers under this prefix participate in the critical set. */
const TRACKED_PREFIX = 'pyric/';

/**
 * Parse one program's source text for its `pyric/*` named-import symbols.
 * Returns `specifier -> symbol names actually bound` (aliases resolved back
 * to their ORIGINAL exported name — `import { getAuth as A }` still needs
 * `pyric/auth` to export `getAuth`, not `A`). Whole-statement `import type`
 * is skipped entirely; a `type` modifier on one specifier inside a mixed
 * import (`import { type Foo, bar }`) drops only that specifier.
 */
export function parseImportedSymbols(source: string): Map<string, Set<string>> {
  const bySpecifier = new Map<string, Set<string>>();
  // Matches `import [type] { <names> } from '<specifier>';` — the brace body
  // is matched non-greedily across newlines ([\s\S]*?) so a multi-line named
  // import list still parses as one statement.
  const importRe = /import\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importRe)) {
    const [, wholeType, braceBody, specifier] = match;
    if (wholeType) continue; // `import type { ... }` — no runtime symbols.
    if (!specifier.startsWith(TRACKED_PREFIX)) continue;
    const names = braceBody
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
      .filter((token) => !token.startsWith('type ')) // per-specifier `type X` inside a mixed import
      .map((token) => token.split(/\s+as\s+/)[0].trim()); // `X as Y` -> the real exported name X
    if (names.length === 0) continue;
    const set = bySpecifier.get(specifier) ?? new Set<string>();
    for (const name of names) set.add(name);
    bySpecifier.set(specifier, set);
  }
  return bySpecifier;
}

export interface CriticalSymbolsPackage {
  symbols: string[];
  programs: string[];
}

export interface CriticalSymbolsReport {
  generatedAt: string;
  packages: Record<string, CriticalSymbolsPackage>;
}

/** Computes the critical set fresh from the corpus on disk — no caching. */
export function computeCriticalSymbols(): CriticalSymbolsReport {
  const packages: Record<string, { symbols: Set<string>; programs: Set<string> }> = {};
  for (const file of listEntryPathProgramFiles()) {
    const source = readFileSync(file.path, 'utf8');
    for (const [specifier, symbols] of parseImportedSymbols(source)) {
      const entry = packages[specifier] ?? { symbols: new Set(), programs: new Set() };
      for (const symbol of symbols) entry.symbols.add(symbol);
      entry.programs.add(file.name);
      packages[specifier] = entry;
    }
  }
  const sortedPackages: Record<string, CriticalSymbolsPackage> = {};
  for (const specifier of Object.keys(packages).sort()) {
    sortedPackages[specifier] = {
      symbols: [...packages[specifier].symbols].sort(),
      programs: [...packages[specifier].programs].sort(),
    };
  }
  return { generatedAt: new Date().toISOString(), packages: sortedPackages };
}

/** Reads the committed `critical-symbols.json`, or throws if it is missing. */
export function readCommittedCriticalSymbols(): CriticalSymbolsReport {
  if (!existsSync(CRITICAL_SYMBOLS_PATH)) {
    throw new Error(`${CRITICAL_SYMBOLS_PATH.replace(REPO_ROOT + '/', '')} is missing — run \`bun run packages/conformance/src/entry-path-symbols.ts --write\`.`);
  }
  return JSON.parse(readFileSync(CRITICAL_SYMBOLS_PATH, 'utf8')) as CriticalSymbolsReport;
}

/** Same-content comparison, ignoring `generatedAt` (a timestamp, not data). */
function samePackages(a: CriticalSymbolsReport, b: CriticalSymbolsReport): boolean {
  return JSON.stringify(a.packages) === JSON.stringify(b.packages);
}

/** Fatal-check entry point for `validate-registry.ts` — returns problems, never exits. */
export function checkCriticalSymbolsUpToDate(): string[] {
  const fresh = computeCriticalSymbols();
  if (!existsSync(CRITICAL_SYMBOLS_PATH)) {
    return [`entry-path/critical-symbols.json is missing — run \`bun run packages/conformance/src/entry-path-symbols.ts --write\`.`];
  }
  const committed = JSON.parse(readFileSync(CRITICAL_SYMBOLS_PATH, 'utf8')) as CriticalSymbolsReport;
  if (!samePackages(fresh, committed)) {
    return [`entry-path/critical-symbols.json is stale (does not match the entry-path corpus on disk) — run \`bun run packages/conformance/src/entry-path-symbols.ts --write\`.`];
  }
  return [];
}

if (import.meta.main) {
  const write = process.argv.includes('--write');
  const report = computeCriticalSymbols();

  if (write) {
    writeFileSync(CRITICAL_SYMBOLS_PATH, JSON.stringify(report, null, 2) + '\n');
    const totalSymbols = Object.values(report.packages).reduce((n, p) => n + p.symbols.length, 0);
    console.log(`entry-path/critical-symbols.json written: ${Object.keys(report.packages).length} package(s), ${totalSymbols} critical symbol(s).`);
    process.exit(0);
  }

  const problems = checkCriticalSymbolsUpToDate();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log('entry-path/critical-symbols.json is up to date.');
  process.exit(0);
}
