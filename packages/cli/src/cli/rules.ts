/**
 * `pyric firestore rules *` subcommands — thin wrappers over `pyric/rules`.
 *
 *   - `firestore rules validate <path>` runs the structural validator, prints
 *     findings JSON.
 *   - `firestore rules resolve <path>` (and `storage rules resolve`) lower
 *     `2+modules` imports to one ruleset.
 *
 * Linting and simulating a ruleset are `rules lint` and `rules simulate` on
 * the service surface now (`packages/cli/src/bridge/surface/methods/rules/`),
 * derived the same way every other `pyric <tool> <method>` command is, and
 * shared with `pyric mcp`. They are not implemented here.
 *
 * Both remaining commands exit 0 on success, 1 on usage / file-read error, 2
 * on library failure (parse error etc.).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  validateFirestoreRules,
  parseToAST,
  type ValidationFinding,
} from 'pyric/rules/internal';
import { resolveModules } from 'pyric/rules/internal/node';
import type { ParsedArgs } from './parse-args.js';

export interface RulesDeps {
  readFile?: typeof readFile;
  validateFirestoreRules?: typeof validateFirestoreRules;
  /** Override cwd — used in tests. */
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

export interface ResolveRulesDeps {
  readFile?: typeof readFile;
  writeFile?: typeof writeFile;
  mkdir?: typeof mkdir;
  resolveModules?: typeof resolveModules;
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

export async function runRulesValidate(parsed: ParsedArgs, deps: RulesDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const readFileFn = deps.readFile ?? readFile;
  const validateFn = deps.validateFirestoreRules ?? validateFirestoreRules;

  const path = parsed.positional[0];
  if (!path) {
    err.write('pyric firestore rules validate: missing rules-file path. Usage: pyric firestore rules validate <path>\n');
    return 1;
  }
  let source: string;
  try {
    source = await readFileFn(resolvePath(cwd, path), 'utf-8');
  } catch (e) {
    err.write(`pyric firestore rules validate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const ast = parseToAST(source);
  if (!ast) {
    err.write('pyric firestore rules validate: failed to parse rules source.\n');
    return 2;
  }
  const findings: ValidationFinding[] = validateFn(ast);
  out.write(`${JSON.stringify(findings, null, 2)}\n`);
  return 0;
}

export async function runRulesResolve(
  parsed: ParsedArgs,
  deps: ResolveRulesDeps = {},
): Promise<number> {
  return runServiceRulesResolve('firestore', parsed, deps);
}

export async function runStorageRulesResolve(
  parsed: ParsedArgs,
  deps: ResolveRulesDeps = {},
): Promise<number> {
  return runServiceRulesResolve('storage', parsed, deps);
}

async function runServiceRulesResolve(
  service: 'firestore' | 'storage',
  parsed: ParsedArgs,
  deps: ResolveRulesDeps,
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const command = `pyric ${service} rules resolve`;
  const sourcePath = parsed.positional[0];
  if (!sourcePath) {
    err.write(
      `${command}: missing rules-file path. Usage: ${command} <path> [--out <path>]\n`,
    );
    return 1;
  }

  const absoluteSourcePath = resolvePath(cwd, sourcePath);
  let source: string;
  try {
    source = await (deps.readFile ?? readFile)(absoluteSourcePath, 'utf-8');
  } catch (error) {
    err.write(
      `${command}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const expectedService =
    service === 'storage' ? 'firebase.storage' : 'cloud.firestore';
  const parsedSource = parseToAST(source);
  if (parsedSource && parsedSource.service.name !== expectedService) {
    err.write(
      `${command}: source declares service ${parsedSource.service.name}; expected ${expectedService}\n`,
    );
    return 2;
  }

  const result = (deps.resolveModules ?? resolveModules)(source, {
    basePath: dirname(absoluteSourcePath),
    sourceFile: sourcePath,
  });
  if (!result.success) {
    err.write(`${command}: ${result.error.message}\n`);
    return 2;
  }

  const outFlag = parsed.flags.get('out');
  if (typeof outFlag !== 'string') {
    out.write(result.data.resolved.endsWith('\n') ? result.data.resolved : `${result.data.resolved}\n`);
    return 0;
  }

  const outputPath = resolvePath(cwd, outFlag);
  await (deps.mkdir ?? mkdir)(dirname(outputPath), { recursive: true });
  await (deps.writeFile ?? writeFile)(
    outputPath,
    result.data.resolved.endsWith('\n') ? result.data.resolved : `${result.data.resolved}\n`,
    'utf-8',
  );
  out.write(`${command}: wrote ${outputPath}\n`);
  return 0;
}
