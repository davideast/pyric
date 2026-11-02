/**
 * ast-grep as the factory runs it: the binary Studio installs (no install
 * script runs, so the platform package's binary, not the npm wrapper), and
 * its JSON stream read into findings.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Runner } from './exec.ts';

const PLATFORM_PACKAGES = ['cli-linux-x64-gnu', 'cli-linux-x64-musl', 'cli-linux-arm64-gnu'];

export class AstGrepMissing extends Error {}

/** The ast-grep binary under `studio/node_modules`; `PYRIC_FACTORY_AST_GREP` overrides it. */
export function astGrepBinary(studio: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PYRIC_FACTORY_AST_GREP;
  if (override !== undefined) return override;
  const found = PLATFORM_PACKAGES.map((name) => join(studio, 'node_modules', '@ast-grep', name, 'ast-grep')).find((path) => existsSync(path));
  if (found === undefined) throw new AstGrepMissing(`no ast-grep binary under ${join(studio, 'node_modules', '@ast-grep')}; is Studio installed?`);
  return found;
}

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

/** One finding per line of `ast-grep scan --json=stream` output; lines that aren't a match are skipped. */
export function parseFindings(stream: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of stream.split('\n')) {
    if (!line.startsWith('{')) continue;
    const parsed = matchSchema.safeParse(JSON.parse(line));
    if (!parsed.success) continue;
    const match = parsed.data;
    findings.push({
      ruleId: match.ruleId,
      file: match.file,
      line: match.range.start.line + 1,
      endLine: match.range.end.line + 1,
      message: match.message ?? '',
      text: match.text,
    });
  }
  return findings;
}

export interface ScanInput {
  runner: Runner;
  binary: string;
  config: string;
  cwd: string;
  files: readonly string[];
}

const SCAN_TIMEOUT_MS = 120_000;

/** Scans `files` with the rules `config` names. No files, no scan. */
export async function scan(input: ScanInput): Promise<Finding[]> {
  if (input.files.length === 0) return [];
  const args = ['scan', '-c', input.config, '--json=stream', ...input.files];
  const result = await input.runner({ command: input.binary, args, cwd: input.cwd, timeoutMs: SCAN_TIMEOUT_MS });
  const failed = result.code !== 0 || result.timedOut;
  if (failed) throw new Error(`ast-grep scan failed (exit ${result.code}):\n${result.output}`);
  return parseFindings(result.output);
}
