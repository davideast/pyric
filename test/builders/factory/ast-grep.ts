/**
 * ast-grep scans as the factory runs them: the harness's own binary
 * (`tools.ts`), inside a sandbox during a run, and its JSON stream read into
 * findings. A line of that stream that isn't a match fails the scan.
 */
import { z } from 'zod';
import type { Runner } from './exec.ts';

export interface Finding {
  ruleId: string;
  /** Relative to the directory the scan ran in. */
  file: string;
  /** First and last line, numbered from 1. */
  line: number;
  endLine: number;
  message: string;
  text: string;
}

const matchSchema = z.object({
  ruleId: z.string(),
  file: z.string(),
  text: z.string(),
  message: z.string().optional(),
  range: z.object({ start: z.object({ line: z.number() }), end: z.object({ line: z.number() }) }),
});

export class ScanFailed extends Error {}

function parseLine(line: string): Finding {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ScanFailed(`ast-grep printed a line that isn't JSON: ${line.slice(0, 200)}`);
  }
  const parsed = matchSchema.safeParse(value);
  if (!parsed.success) throw new ScanFailed(`ast-grep printed a line that isn't a match: ${line.slice(0, 200)}`);
  const match = parsed.data;
  return { ruleId: match.ruleId, file: match.file, line: match.range.start.line + 1, endLine: match.range.end.line + 1, message: match.message ?? '', text: match.text };
}

/** One finding per line of `ast-grep scan --json=stream` stdout. */
export function parseFindings(stream: string): Finding[] {
  return stream.split('\n').filter((line) => line.trim() !== '').map(parseLine);
}

export interface ScanInput {
  runner: Runner;
  binary: string;
  config: string;
  cwd: string;
  files: readonly string[];
}

const SCAN_TIMEOUT_MS = 120_000;
const SCAN_SCRIPT = 'binary="$1"; config="$2"; shift 2; exec "$binary" scan -c "$config" --json=stream "$@" 2>/dev/null';

/** Scans `files` with the rules `config` names. No files, no scan. */
export async function scan(input: ScanInput): Promise<Finding[]> {
  if (input.files.length === 0) return [];
  // Matches go to stdout; the runner joins stderr in, so warnings are dropped before they reach the parse.
  const args = ['-c', SCAN_SCRIPT, 'sh', input.binary, input.config, ...input.files];
  const result = await input.runner({ command: '/bin/sh', args, cwd: input.cwd, timeoutMs: SCAN_TIMEOUT_MS });
  const failed = result.code !== 0 || result.timedOut;
  if (failed) throw new ScanFailed(`ast-grep scan failed (exit ${result.code}):\n${result.output}`);
  return parseFindings(result.output);
}
