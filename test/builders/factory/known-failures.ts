/**
 * Failures the start commit already had. Studio's own gates can fail before
 * any role touches it (an app rule it breaks, a test that needs what the
 * sandbox lacks); a gate like that would fail every hour and say nothing
 * about the roles' work. So the baseline runs the static gates at the start
 * commit and records each failure by a signature without line numbers, and
 * an hour's failing gate passes when every failure it shows is one of them.
 * A failure with no signature (a timeout, a crash) never passes.
 */
import type { GateName, GateResult } from './gates.ts';

export type KnownFailures = Partial<Record<GateName, string[]>>;

const TEST_FAILURE = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
const TS_ERROR = /^(\S.*?)\(\d+,\d+\): error (TS\d+): (.*)$/;
const AST_GREP_ERROR = /^error\[([^\]]+)\]/;
const AST_GREP_LOCATION = /┌─ (\S+?):\d+:\d+/;

function testFailures(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const name = TEST_FAILURE.exec(line.trim())?.[1];
    return name === undefined ? [] : [name];
  });
}

function typeErrors(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const match = TS_ERROR.exec(line);
    return match === null ? [] : [`${match[1]} ${match[2]}: ${match[3]}`];
  });
}

/** `rule file` for each error-level finding: the location follows its header within a few lines. */
function scanErrors(lines: readonly string[]): string[] {
  const found: string[] = [];
  lines.forEach((line, index) => {
    const header = AST_GREP_ERROR.exec(line);
    if (header === null) return;
    const location = lines.slice(index + 1, index + 4).map((next) => AST_GREP_LOCATION.exec(next)).find((match) => match !== null);
    found.push(`${header[1]} ${location?.[1] ?? '?'}`);
  });
  return found;
}

/** The failures in a gate's output, by signature; empty when none can be named. */
export function failureSignatures(gate: GateName, output: string): string[] {
  const lines = output.split('\n');
  if (gate === 'tests') return testFailures(lines);
  if (gate === 'typecheck') return typeErrors(lines);
  if (gate === 'studio-checks') return scanErrors(lines);
  return [];
}

/** The start commit's failures, by gate, from its static gates' results. */
export function knownFailuresOf(results: readonly GateResult[]): KnownFailures {
  const known: KnownFailures = {};
  for (const result of results) {
    // bun prints each failing test twice: where it ran, and in the closing summary.
    if (!result.passed) known[result.gate] = [...new Set(failureSignatures(result.gate, result.output ?? ''))];
  }
  return known;
}

/** Passes a failing gate whose every failure the start commit already had. */
export function excuseKnown(result: GateResult, known: KnownFailures): GateResult {
  if (result.passed) return result;
  const current = failureSignatures(result.gate, result.output ?? '');
  const before = new Set(known[result.gate] ?? []);
  const isKnown = current.length > 0 && current.every((signature) => before.has(signature));
  if (!isKnown) return result;
  const summary = `passed apart from ${current.length} failures the start commit already had`;
  return { ...result, passed: true, summary };
}
