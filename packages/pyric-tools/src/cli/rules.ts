/**
 * `pyric rules:*` subcommands — thin wrappers over `pyric/rules`.
 *
 *   - `rules:lint <path>` runs the AST linter, prints findings JSON.
 *   - `rules:validate <path>` runs the structural validator, prints
 *     findings JSON.
 *   - `rules:simulate` runs the local simulator. With no flags it
 *     reads `firebase.json` for the rules path and runs a single
 *     allow-anonymous sanity test. With `--stdin` it reads a JSON
 *     request `{ source?, testCases }` from stdin instead — the way
 *     CI pipes in a fully scripted simulation.
 *
 * All three exit 0 on success, 1 on usage / file-read error, 2 on
 * library failure (parse error etc.).
 */

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import {
  lintFirestoreRules,
  validateFirestoreRules,
  parseToAST,
  SimulateFirestoreRulesHandler,
  type TestCase,
  type LintResult,
  type ValidationFinding,
  type TestFirestoreRulesResult,
} from 'pyric/rules';
import type { ParsedArgs } from './parse-args.js';
import { readFirebaseJson, type FirebaseJson } from './firebase-json.js';

export interface RulesDeps {
  readFile?: typeof readFile;
  readFirebaseJson?: (cwd: string) => Promise<FirebaseJson>;
  lintFirestoreRules?: typeof lintFirestoreRules;
  validateFirestoreRules?: typeof validateFirestoreRules;
  simulate?: (source: string, cases: TestCase[]) => TestFirestoreRulesResult;
  /** Override cwd — used in tests. */
  cwd?: string;
  /** Override stdin reader — used in tests. */
  readStdin?: () => Promise<string>;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export async function runRulesLint(parsed: ParsedArgs, deps: RulesDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const readFileFn = deps.readFile ?? readFile;
  const lintFn = deps.lintFirestoreRules ?? lintFirestoreRules;

  const path = parsed.positional[0];
  if (!path) {
    err.write('pyric rules:lint: missing rules-file path. Usage: pyric rules:lint <path>\n');
    return 1;
  }
  let source: string;
  try {
    source = await readFileFn(resolvePath(cwd, path), 'utf-8');
  } catch (e) {
    err.write(`pyric rules:lint: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const result: LintResult = lintFn(source);
  out.write(`${JSON.stringify(result, null, 2)}\n`);
  // Non-zero only when the linter signals a hard parse error. Warnings
  // are informational — exit 0 keeps `pyric rules:lint` chainable in
  // build pipelines without `|| true`.
  return result.parseError ? 2 : 0;
}

export async function runRulesValidate(parsed: ParsedArgs, deps: RulesDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const readFileFn = deps.readFile ?? readFile;
  const validateFn = deps.validateFirestoreRules ?? validateFirestoreRules;

  const path = parsed.positional[0];
  if (!path) {
    err.write('pyric rules:validate: missing rules-file path. Usage: pyric rules:validate <path>\n');
    return 1;
  }
  let source: string;
  try {
    source = await readFileFn(resolvePath(cwd, path), 'utf-8');
  } catch (e) {
    err.write(`pyric rules:validate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const ast = parseToAST(source);
  if (!ast) {
    err.write('pyric rules:validate: failed to parse rules source.\n');
    return 2;
  }
  const findings: ValidationFinding[] = validateFn(ast);
  out.write(`${JSON.stringify(findings, null, 2)}\n`);
  return 0;
}

export async function runRulesSimulate(
  parsed: ParsedArgs,
  deps: RulesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const readFileFn = deps.readFile ?? readFile;
  const fjRead = deps.readFirebaseJson ?? readFirebaseJson;
  const simulateFn =
    deps.simulate ??
    ((source: string, cases: TestCase[]) =>
      new SimulateFirestoreRulesHandler().simulate(source, cases));

  let source: string;
  let testCases: TestCase[];

  if (parsed.flags.get('stdin') === true) {
    const readStdinFn = deps.readStdin ?? defaultReadStdin;
    const raw = await readStdinFn();
    let payload: { source?: string; testCases?: TestCase[] };
    try {
      payload = JSON.parse(raw) as { source?: string; testCases?: TestCase[] };
    } catch (e) {
      err.write(
        `pyric rules:simulate: failed to parse stdin JSON: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 1;
    }
    if (!payload.testCases || !Array.isArray(payload.testCases)) {
      err.write('pyric rules:simulate: stdin payload must include `testCases: TestCase[]`.\n');
      return 1;
    }
    testCases = payload.testCases;
    if (payload.source) {
      source = payload.source;
    } else {
      const firebaseJson = await fjRead(cwd);
      const rulesPath = firebaseJson.firestore?.rules;
      if (!rulesPath) {
        err.write(
          'pyric rules:simulate: stdin payload omitted `source` and firebase.json has no firestore.rules path.\n',
        );
        return 1;
      }
      source = await readFileFn(resolvePath(cwd, rulesPath), 'utf-8');
    }
  } else {
    let firebaseJson: FirebaseJson;
    try {
      firebaseJson = await fjRead(cwd);
    } catch (e) {
      err.write(`${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const rulesPath = firebaseJson.firestore?.rules;
    if (!rulesPath) {
      err.write('pyric rules:simulate: firebase.json has no `firestore.rules` path.\n');
      return 1;
    }
    try {
      source = await readFileFn(resolvePath(cwd, rulesPath), 'utf-8');
    } catch (e) {
      err.write(`pyric rules:simulate: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    // Default sample test — anonymous read on /sample/x. Useful as a
    // smoke-test that proves the rules file at least parses + an
    // anonymous reader is correctly denied/allowed.
    testCases = [
      {
        description: 'sample anonymous read',
        expectation: 'DENY',
        method: 'get',
        path: 'sample/x',
        auth: null,
      },
    ];
  }

  const result = simulateFn(source, testCases);
  out.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.success ? 0 : 2;
}
