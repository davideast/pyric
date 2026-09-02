/**
 * `pyric database rules *` subcommands — local tooling for Realtime Database
 * rules JSON.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  compileRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
  type SimulationInput,
  type SimulateResult,
} from 'pyric/rules/internal/rtdb';
import type { ParsedArgs } from './parse-args.js';
import { readFirebaseJson, type FirebaseJson } from './firebase-json.js';
import {
  loadRtdbRulesDocument,
  type LoadRtdbRulesDocumentResult,
} from '../rtdb/load-rules-document.js';
import { collectRtdbRuleFindings, type RtdbRuleFinding } from '../rtdb/rule-findings.js';
import { stripJsonComments } from '../rtdb/rules-json.js';

export interface DatabaseRulesDeps {
  readFile?: typeof readFile;
  writeFile?: typeof writeFile;
  mkdir?: typeof mkdir;
  readFirebaseJson?: (cwd: string) => Promise<FirebaseJson>;
  simulate?: (compiled: CompiledRtdbRules, input: SimulationInput) => SimulateResult;
  loadRulesDocument?: typeof loadRtdbRulesDocument;
  cwd?: string;
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

function parseRulesJson(raw: string): CompiledRtdbRules {
  return compileRtdbRules(JSON.parse(stripJsonComments(raw)));
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

function jsonError(code: string, message: string): { errors: RtdbRuleFinding[]; warnings: RtdbRuleFinding[] } {
  return {
    errors: [{ path: '/', rule: '.read', code, message }],
    warnings: [],
  };
}

export async function runDatabaseRulesLint(
  parsed: ParsedArgs,
  deps: DatabaseRulesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const path = parsed.positional[0];
  if (!path) {
    err.write('pyric database rules lint: missing rules-file path. Usage: pyric database rules lint <path>\n');
    return 1;
  }

  const file = await readRulesFile(path, deps);
  if (!file.ok) {
    err.write(`pyric database rules lint: ${file.message}\n`);
    return 1;
  }

  try {
    const compiled = parseRulesJson(file.raw);
    out.write(`${JSON.stringify({ warnings: collectRtdbRuleFindings(compiled, 'warnings') }, null, 2)}\n`);
    return 0;
  } catch (e) {
    out.write(`${JSON.stringify(jsonError('INVALID_RULES_JSON', e instanceof Error ? e.message : String(e)), null, 2)}\n`);
    return 2;
  }
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
    out.write(`${JSON.stringify({ errors: collectRtdbRuleFindings(compiled, 'errors') }, null, 2)}\n`);
    return 0;
  } catch (e) {
    out.write(`${JSON.stringify(jsonError('INVALID_RULES_JSON', e instanceof Error ? e.message : String(e)), null, 2)}\n`);
    return 2;
  }
}

interface SimulatePayload {
  rulesJson?: unknown;
  rules?: unknown;
  rulesPath?: string;
  operation?: SimulationInput['operation'];
  path?: string;
  auth?: SimulationInput['auth'];
  mockData?: Record<string, unknown>;
  newData?: unknown;
}

async function readFirebaseRules(
  deps: DatabaseRulesDeps,
): Promise<{ ok: true; raw: string } | { ok: false; message: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const fjRead = deps.readFirebaseJson ?? readFirebaseJson;
  let firebaseJson: FirebaseJson;
  try {
    firebaseJson = await fjRead(cwd);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const rulesPath = firebaseJson.database?.rules;
  if (!rulesPath) {
    return { ok: false, message: 'firebase.json has no `database.rules` path.' };
  }
  return readRulesFile(rulesPath, deps);
}

export async function runDatabaseRulesSimulate(
  parsed: ParsedArgs,
  deps: DatabaseRulesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const readFileFn = deps.readFile ?? readFile;
  const simulateFn =
    deps.simulate ??
    simulateRtdbRules;

  let rulesJson: unknown;
  let input: SimulationInput;

  if (parsed.flags.get('stdin') === true) {
    const readStdinFn = deps.readStdin ?? defaultReadStdin;
    let payload: SimulatePayload;
    try {
      payload = JSON.parse(await readStdinFn()) as SimulatePayload;
    } catch (e) {
      err.write(`pyric database rules simulate: failed to parse stdin JSON: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    if (!payload.operation || !payload.path) {
      err.write('pyric database rules simulate: stdin payload must include `operation` and `path`.\n');
      return 1;
    }
    if (payload.rulesJson !== undefined || payload.rules !== undefined) {
      rulesJson = payload.rulesJson ?? payload.rules;
    } else if (payload.rulesPath) {
      try {
        const rawContent = await readFileFn(resolvePath(deps.cwd ?? process.cwd(), payload.rulesPath), 'utf-8');
        rulesJson = JSON.parse(stripJsonComments(rawContent));
      } catch (e) {
        err.write(`pyric database rules simulate: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
    } else {
      const file = await readFirebaseRules(deps);
      if (!file.ok) {
        err.write(`pyric database rules simulate: ${file.message}\n`);
        return 1;
      }
      try {
        rulesJson = JSON.parse(stripJsonComments(file.raw));
      } catch (e) {
        err.write(`pyric database rules simulate: ${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
      }
    }
    input = {
      operation: payload.operation,
      path: payload.path,
      auth: payload.auth ?? null,
      mockData: payload.mockData ?? {},
      ...(payload.newData !== undefined ? { newData: payload.newData } : {}),
    };
  } else {
    const file = await readFirebaseRules(deps);
    if (!file.ok) {
      err.write(`pyric database rules simulate: ${file.message}\n`);
      return 1;
    }
    try {
      rulesJson = JSON.parse(stripJsonComments(file.raw));
    } catch (e) {
      err.write(`pyric database rules simulate: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    input = {
      operation: 'read',
      path: '/sample/x',
      auth: null,
      mockData: {},
    };
  }

  try {
    const compiled = compileRtdbRules(rulesJson);
    const result = simulateFn(compiled, input);
    out.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.success ? 0 : 2;
  } catch (e) {
    err.write(`pyric database rules simulate: ${e instanceof Error ? e.message : String(e)}\n`);
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
