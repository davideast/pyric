/**
 * `pyric database rules *` subcommands — local tooling for Realtime Database
 * rules JSON.
 *
 * Linting and simulating a ruleset are `rules lint` and `rules simulate` on
 * the service surface now (`packages/cli/src/bridge/surface/methods/rules/`),
 * shared with `pyric mcp`. They are not implemented here.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { compileRtdbRules, type CompiledRtdbRules, type RtdbNode } from 'pyric/rules/internal/rtdb';
import type { ParsedArgs } from './parse-args.js';
import { readFirebaseJson, type FirebaseJson } from './firebase-json.js';
import {
  loadRtdbRulesDocument,
  type LoadRtdbRulesDocumentResult,
} from '../rtdb/load-rules-document.js';
import { stripJsonComments } from '../rtdb/rules-json.js';

export interface DatabaseRulesDeps {
  readFile?: typeof readFile;
  writeFile?: typeof writeFile;
  mkdir?: typeof mkdir;
  readFirebaseJson?: (cwd: string) => Promise<FirebaseJson>;
  loadRulesDocument?: typeof loadRtdbRulesDocument;
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

interface RuleFinding {
  path: string;
  rule: '.read' | '.write' | '.validate';
  code: string;
  message: string;
}

function parseRulesJson(raw: string): CompiledRtdbRules {
  return compileRtdbRules(JSON.parse(stripJsonComments(raw)));
}

function collectFindings(node: RtdbNode, kind: 'errors' | 'warnings'): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const rules = [
    ['.read', node.read],
    ['.write', node.write],
    ['.validate', node.validate],
  ] as const;
  for (const [rule, expr] of rules) {
    for (const finding of expr?.parsed[kind] ?? []) {
      findings.push({
        path: node.path,
        rule,
        code: finding.code,
        message: finding.message,
      });
    }
  }
  for (const child of node.children) {
    findings.push(...collectFindings(child, kind));
  }
  return findings;
}

async function readRulesFile(
  path: string,
  deps: DatabaseRulesDeps,
): Promise<{ ok: true; raw: string } | { ok: false; message: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const readFileFn = deps.readFile ?? readFile;
  try {
    return { ok: true, raw: await readFileFn(resolvePath(cwd, path), 'utf-8') };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function jsonError(code: string, message: string): { errors: RuleFinding[]; warnings: RuleFinding[] } {
  return {
    errors: [{ path: '/', rule: '.read', code, message }],
    warnings: [],
  };
}

export async function runDatabaseRulesValidate(
  parsed: ParsedArgs,
  deps: DatabaseRulesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const path = parsed.positional[0];
  if (!path) {
    err.write('pyric database rules validate: missing rules-file path. Usage: pyric database rules validate <path>\n');
    return 1;
  }

  const file = await readRulesFile(path, deps);
  if (!file.ok) {
    err.write(`pyric database rules validate: ${file.message}\n`);
    return 1;
  }

  try {
    const compiled = parseRulesJson(file.raw);
    out.write(`${JSON.stringify({ errors: collectFindings(compiled, 'errors') }, null, 2)}\n`);
    return 0;
  } catch (e) {
    out.write(`${JSON.stringify(jsonError('INVALID_RULES_JSON', e instanceof Error ? e.message : String(e)), null, 2)}\n`);
    return 2;
  }
}

/**
 * `pyric database rules generate [--config <path>] [--out <path>]`
 *
 * Loads a user's RTDB constraints module (a file that calls
 * `defineRtdbRules(...)` from `pyric/rules`), compiles it via
 * `RtdbRulesDocument#toJSON()` — the same primitive RTDB deploy uses —
 * and writes the static `database.rules.json` shape to disk so it can
 * be inspected, diffed, and committed before deploying.
 *
 * `--config` defaults to `database.rules.ts`. `--out` defaults to
 * `firebase.json`'s `database.rules` path, falling back to
 * `database.rules.json` when firebase.json has no such entry.
 */
export async function runDatabaseRulesGenerate(
  parsed: ParsedArgs,
  deps: DatabaseRulesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const writeFileFn = deps.writeFile ?? writeFile;
  const mkdirFn = deps.mkdir ?? mkdir;
  const loadRulesDocument = deps.loadRulesDocument ?? loadRtdbRulesDocument;

  const configFlag = parsed.flags.get('config');
  const configPath = typeof configFlag === 'string' ? configFlag : 'database.rules.ts';

  const loaded: LoadRtdbRulesDocumentResult = await loadRulesDocument(configPath, { cwd });
  if (!loaded.ok) {
    err.write(`pyric database rules generate: ${loaded.message}\n`);
    return 1;
  }

  const outFlag = parsed.flags.get('out');
  let outPath: string;
  if (typeof outFlag === 'string') {
    outPath = outFlag;
  } else {
    const fjRead = deps.readFirebaseJson ?? readFirebaseJson;
    let firebaseJson: FirebaseJson | null = null;
    try {
      firebaseJson = await fjRead(cwd);
    } catch {
      firebaseJson = null;
    }
    outPath = firebaseJson?.database?.rules ?? 'database.rules.json';
  }

  const resolvedOut = resolvePath(cwd, outPath);
  const rulesJson = loaded.document.toJSON();
  await mkdirFn(dirname(resolvedOut), { recursive: true });
  await writeFileFn(resolvedOut, `${JSON.stringify(rulesJson, null, 2)}\n`, 'utf-8');

  out.write(`pyric database rules generate: wrote ${resolvedOut}\n`);
  return 0;
}
