/**
 * `pyric database indexes generate <path...> [--rules <file>] [--out <file>] [--check] [--instance <name>] [--json]`
 *
 * Extracts Realtime Database `.indexOn` requirements from application source
 * via `extractSdkUsage` + `rtdbIndexPass` and merges them into
 * `database.rules.json` (or verifies existing rules with `--check`).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  checkRtdbIndexes,
  mergeRtdbIndexes,
  type RtdbIndexPassResult,
  type RtdbIndexWarning,
} from 'pyric/rules/internal/usage';
import type { FirebaseJson, FirebaseRc } from './firebase-json.js';
import { findMissingValueFlag, type FlagValue, type ParsedArgs } from './parse-args.js';
import { errorMessage } from '../rtdb/error-message.js';
import {
  extractRtdbIndexesFromPaths,
  resolveRtdbRulesTarget,
  type ExtractRtdbIndexesFromPathsOptions,
} from '../rtdb/extract-indexes.js';

export interface DatabaseIndexesDeps {
  extract?: (options: ExtractRtdbIndexesFromPathsOptions) => RtdbIndexPassResult;
  readFirebaseJson?: (cwd: string) => Promise<FirebaseJson>;
  readFirebaseRc?: (cwd: string) => Promise<FirebaseRc | null>;
  readFile?: typeof readFile;
  writeFile?: typeof writeFile;
  mkdir?: typeof mkdir;
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

function readCheckFlagAndPositionals(
  parsed: ParsedArgs,
): { check: boolean; positional: string[] } {
  const rawCheck: FlagValue | undefined = parsed.flags.get('check');
  if (rawCheck === undefined || rawCheck === false || rawCheck === 'false') {
    return { check: false, positional: parsed.positional };
  }
  if (rawCheck === true || rawCheck === 'true') {
    return { check: true, positional: parsed.positional };
  }
  if (typeof rawCheck === 'string') {
    return { check: true, positional: [rawCheck, ...parsed.positional] };
  }
  return { check: true, positional: parsed.positional };
}

function writeWarnings(err: { write(s: string): void }, warnings: readonly RtdbIndexWarning[]): void {
  for (const warning of warnings) {
    let where = warning.file;
    if (warning.line !== undefined) where = `${warning.file}:${warning.line}`;
    err.write(`pyric database indexes generate: warning: ${where}: ${warning.message}\n`);
  }
}

export async function runDatabaseIndexesGenerate(
  parsed: ParsedArgs,
  deps: DatabaseIndexesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const jsonOutput = parsed.flags.get('json') === true;

  const missingFlag = findMissingValueFlag(parsed.flags, [
    'out',
    'rules',
    'instance',
  ]);
  if (missingFlag !== undefined) {
    err.write(`pyric database indexes generate: missing value for --${missingFlag}\n`);
    return 2;
  }

  const { check, positional } = readCheckFlagAndPositionals(parsed);
  if (positional.length === 0) {
    err.write(
      'pyric database indexes generate: missing source path. Usage: pyric database indexes generate <path...> [--rules <path>] [--out <path>] [--check] [--instance <name>] [--json]\n',
    );
    return 1;
  }

  const rawRulesFlag = parsed.flags.get('rules');
  let rulesFlag: string | undefined;
  if (typeof rawRulesFlag === 'string') {
    rulesFlag = rawRulesFlag;
  }
  const rawInstance = parsed.flags.get('instance');
  let instanceFlag: string | undefined;
  if (typeof rawInstance === 'string') {
    instanceFlag = rawInstance;
  }

  let target;
  try {
    target = await resolveRtdbRulesTarget({
      cwd,
      rulesFlag,
      instance: instanceFlag,
      readFirebaseJsonFn: deps.readFirebaseJson,
      readFirebaseRcFn: deps.readFirebaseRc,
    });
  } catch (e) {
    err.write(`pyric database indexes generate: ${errorMessage(e)}\n`);
    return 1;
  }

  const extractFn = deps.extract ?? extractRtdbIndexesFromPaths;
  let passResult: RtdbIndexPassResult;
  try {
    passResult = extractFn({
      projectDir: cwd,
      paths: positional,
      instance: target.instance,
      includeDefaultInstance: target.includeDefaultInstance,
    });
  } catch (e) {
    err.write(`pyric database indexes generate: ${errorMessage(e)}\n`);
    return 2;
  }

  const readFileFn = deps.readFile ?? readFile;
  let existingRaw: string | undefined;
  if (existsSync(target.rulesPath)) {
    try {
      existingRaw = await readFileFn(target.rulesPath, 'utf-8');
    } catch (e) {
      err.write(
        `pyric database indexes generate: failed to read '${target.rulesPath}': ${errorMessage(e)}\n`,
      );
      return 1;
    }
  } else if (rulesFlag !== undefined) {
    err.write(`pyric database indexes generate: rules file not found: '${target.rulesPath}'\n`);
    return 1;
  }

  if (check) {
    let diagnostics;
    try {
      diagnostics = checkRtdbIndexes(existingRaw, passResult.requirements);
    } catch (e) {
      err.write(`pyric database indexes generate: ${errorMessage(e)}\n`);
      return 2;
    }

    if (jsonOutput) {
      out.write(
        `${JSON.stringify(
          {
            ok: diagnostics.length === 0,
            rulesPath: target.rulesPath,
            requirements: passResult.requirements,
            warnings: passResult.warnings,
            diagnostics,
          },
          null,
          2,
        )}\n`,
      );
      if (diagnostics.length === 0) return 0;
      return 2;
    }

    writeWarnings(err, passResult.warnings);
    if (diagnostics.length === 0) {
      out.write(
        `pyric database indexes generate: ${target.rulesPath} satisfies all ${passResult.requirements.length} RTDB index requirement(s)\n`,
      );
      return 0;
    }
    for (const d of diagnostics) {
      const ruleLoc = d.ruleSite?.source ?? '/';
      err.write(`pyric database indexes generate: [${d.code}] ${ruleLoc}: ${d.message}\n`);
    }
    return 2;
  }

  const rawOutFlag = parsed.flags.get('out');
  let outputPath = target.rulesPath;
  if (typeof rawOutFlag === 'string') {
    outputPath = resolvePath(cwd, rawOutFlag);
  }

  let merged;
  try {
    merged = mergeRtdbIndexes(existingRaw, passResult.requirements);
  } catch (e) {
    err.write(`pyric database indexes generate: ${errorMessage(e)}\n`);
    return 2;
  }

  const skipInPlaceNoop =
    outputPath === target.rulesPath && existingRaw !== undefined && !merged.changed;
  if (!skipInPlaceNoop) {
    await (deps.mkdir ?? mkdir)(dirname(outputPath), { recursive: true });
    await (deps.writeFile ?? writeFile)(outputPath, merged.json, 'utf-8');
  }

  if (jsonOutput) {
    out.write(
      `${JSON.stringify(
        {
          ok: true,
          outputPath,
          changed: merged.changed,
          addedCount: merged.addedCount,
          requirements: passResult.requirements,
          warnings: passResult.warnings,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  out.write(`pyric database indexes generate: wrote ${outputPath}\n`);
  writeWarnings(err, passResult.warnings);
  return 0;
}
