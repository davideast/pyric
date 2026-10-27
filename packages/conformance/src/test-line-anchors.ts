#!/usr/bin/env bun
/**
 * The test lines the conformance projection links to. Each registry row's
 * evidence links its cited test files (`conformanceTests`) at the line
 * `findTestLineNumber` picks, so the generated projection changes whenever
 * one of those lines moves, even when only a test file changed.
 *
 * `citedTestAnchors` lists every (row, cited file, line) the projection
 * uses. scripts/ci/build-input-key.sh hashes that list into the dist cache
 * key, so a tests-only change that moves a cited line rebuilds the
 * projection, and one that moves none still reuses the cached dist (#1265).
 *
 *   bun packages/conformance/src/test-line-anchors.ts   prints the list
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompatibilityRow } from '../registry/types.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const testContentCache = new Map<string, string[]>();

/** A cited test file's lines, or undefined when it does not exist. */
export type ReadTestLines = (testPath: string) => string[] | undefined;

/**
 * Retrieve and cache test file lines from disk to avoid redundant file I/O
 * during link validation and line discovery.
 */
const readRepoTestLines: ReadTestLines = (testPath) => {
  const cachedLines = testContentCache.get(testPath);
  if (cachedLines) return cachedLines;

  const absolutePath = join(REPO_ROOT, testPath);
  const fileExists = existsSync(absolutePath);
  if (!fileExists) return undefined;

  try {
    const rawContent = readFileSync(absolutePath, 'utf8');
    const fileLines = rawContent.split('\n');
    testContentCache.set(testPath, fileLines);
    return fileLines;
  } catch {
    return undefined;
  }
};

const IGNORED_API_WORDS = new Set(['and', 'with', 'the', 'for', 'from', 'returns', 'fails', 'when', 'true', 'false', 'that']);

/**
 * Extract meaningful code symbol names from authored markdown API descriptions.
 * Avoids complex or brittle regular expressions by splitting on non-alphanumeric boundaries
 * and excluding common grammatical English words and short punctuation tokens.
 */
function extractSymbolTokens(text: string): string[] {
  const identifierCandidates = text.split(/[^a-zA-Z0-9_-]+/);
  return identifierCandidates.filter((candidate) => {
    const isSufficientLength = candidate.trim().length > 3;
    const isDomainWord = !IGNORED_API_WORDS.has(candidate.toLowerCase());
    return isSufficientLength && isDomainWord;
  });
}

/**
 * Discover the precise line number in a test suite corresponding to a compatibility row.
 * Prioritizes exact metadata citations (observation IDs, row references) before falling back
 * to code symbol usage in test descriptions and assertions.
 */
export function findTestLineNumber(row: CompatibilityRow, testPath: string, readLines: ReadTestLines = readRepoTestLines): number | null {
  const fileLines = readLines(testPath);
  if (!fileLines) return null;

  // Phase 1: Search for exact metadata matches (observation IDs, row identifiers, constructs)
  for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
    const lineContent = fileLines[lineIndex]!;
    const matchesObservation = row.oracleObservations.some((observationId) => lineContent.includes(observationId));
    const matchesRowId = lineContent.includes(row.id);
    const matchesRowAlias = row.aliases.some((rowAlias) => lineContent.includes(rowAlias));
    const matchesConstruct = Boolean(row.constructs?.some((constructId) => lineContent.includes(constructId)));

    const isExactMetadataMatch = matchesObservation || matchesRowId || matchesRowAlias || matchesConstruct;
    if (isExactMetadataMatch) {
      const oneIndexedLineNumber = lineIndex + 1;
      return oneIndexedLineNumber;
    }
  }

  // Phase 2: Search for explicit feature key symbol usages in code or test descriptions
  const featureKeys = row.featureKeys.filter((featureKey) => featureKey.trim().length > 2);
  if (featureKeys.length > 0) {
    for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
      const lineContent = fileLines[lineIndex]!;
      const matchesFeatureKey = featureKeys.some((featureKey) => lineContent.includes(featureKey));
      if (matchesFeatureKey) {
        const oneIndexedLineNumber = lineIndex + 1;
        return oneIndexedLineNumber;
      }
    }
  }

  // Phase 3: Search for primary API domain identifiers across the test file
  const symbolTokens = extractSymbolTokens(row.api);
  if (symbolTokens.length > 0) {
    for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
      const lineContent = fileLines[lineIndex]!;
      const matchesSymbol = symbolTokens.some((symbolToken) => lineContent.includes(symbolToken));
      if (matchesSymbol) {
        const oneIndexedLineNumber = lineIndex + 1;
        return oneIndexedLineNumber;
      }
    }
  }

  const defaultTopLineNumber = 1;
  return defaultTopLineNumber;
}

/** One `row id<TAB>cited file<TAB>line` per cited file of every row, sorted; `missing` for a file that is not there. */
export function citedTestAnchors(rows: readonly CompatibilityRow[], readLines: ReadTestLines = readRepoTestLines): string[] {
  const anchors = rows.flatMap((row) => row.conformanceTests.map((testPath) => {
    const line = findTestLineNumber(row, testPath, readLines);
    return `${row.id}\t${testPath}\t${line ?? 'missing'}`;
  }));
  return [...new Set(anchors)].sort();
}

if (import.meta.main) {
  const { allCompatibilityRows } = await import('../registry/index.ts');
  process.stdout.write(`${citedTestAnchors(allCompatibilityRows).join('\n')}\n`);
}
