/**
 * `pyric database:rules:*` subcommands — local tooling for Realtime Database
 * rules JSON.
 */

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import {
  RtdbMapper,
  SimulateHandler,
  type RtdbIR,
  type RtdbNode,
  type SimulationInput,
} from 'pyric/rules/rtdb';
import type { ParsedArgs } from './parse-args.js';
import { readFirebaseJson, type FirebaseJson } from './firebase-json.js';

const LOCAL_DATABASE_URL = 'https://local-rtdb.firebaseio.com';

export interface DatabaseRulesDeps {
  readFile?: typeof readFile;
  readFirebaseJson?: (cwd: string) => Promise<FirebaseJson>;
  simulate?: (ir: RtdbIR, input: SimulationInput) => ReturnType<SimulateHandler['execute']>;
  cwd?: string;
  readStdin?: () => Promise<string>;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

interface RuleFinding {
  path: string;
  rule: '.read' | '.write' | '.validate';
  code: string;
  message: string;
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

function parseRulesJson(raw: string, databaseUrl = LOCAL_DATABASE_URL): RtdbIR {
  return RtdbMapper.mapToIR(JSON.parse(raw), null, databaseUrl);
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

export async function runDatabaseRulesLint(
  parsed: ParsedArgs,
  deps: DatabaseRulesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const path = parsed.positional[0];
  if (!path) {
    err.write('pyric database:rules:lint: missing rules-file path. Usage: pyric database:rules:lint <path>\n');
    return 1;
  }

  const file = await readRulesFile(path, deps);
  if (!file.ok) {
    err.write(`pyric database:rules:lint: ${file.message}\n`);
    return 1;
  }

  try {
    const ir = parseRulesJson(file.raw);
    const root = ir.rules as RtdbNode;
    out.write(`${JSON.stringify({ warnings: collectFindings(root, 'warnings') }, null, 2)}\n`);
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
    err.write('pyric database:rules:validate: missing rules-file path. Usage: pyric database:rules:validate <path>\n');
    return 1;
  }

  const file = await readRulesFile(path, deps);
  if (!file.ok) {
    err.write(`pyric database:rules:validate: ${file.message}\n`);
    return 1;
  }

  try {
    const ir = parseRulesJson(file.raw);
    const root = ir.rules as RtdbNode;
    out.write(`${JSON.stringify({ errors: collectFindings(root, 'errors') }, null, 2)}\n`);
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
  databaseUrl?: string;
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
    ((ir: RtdbIR, input: SimulationInput) => new SimulateHandler().execute(ir, input));

  let rulesJson: unknown;
  let databaseUrl = LOCAL_DATABASE_URL;
  let input: SimulationInput;

  if (parsed.flags.get('stdin') === true) {
    const readStdinFn = deps.readStdin ?? defaultReadStdin;
    let payload: SimulatePayload;
    try {
      payload = JSON.parse(await readStdinFn()) as SimulatePayload;
    } catch (e) {
      err.write(`pyric database:rules:simulate: failed to parse stdin JSON: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    if (!payload.operation || !payload.path) {
      err.write('pyric database:rules:simulate: stdin payload must include `operation` and `path`.\n');
      return 1;
    }
    databaseUrl = payload.databaseUrl ?? databaseUrl;
    if (payload.rulesJson !== undefined || payload.rules !== undefined) {
      rulesJson = payload.rulesJson ?? payload.rules;
    } else if (payload.rulesPath) {
      try {
        rulesJson = JSON.parse(await readFileFn(resolvePath(deps.cwd ?? process.cwd(), payload.rulesPath), 'utf-8'));
      } catch (e) {
        err.write(`pyric database:rules:simulate: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
    } else {
      const file = await readFirebaseRules(deps);
      if (!file.ok) {
        err.write(`pyric database:rules:simulate: ${file.message}\n`);
        return 1;
      }
      try {
        rulesJson = JSON.parse(file.raw);
      } catch (e) {
        err.write(`pyric database:rules:simulate: ${e instanceof Error ? e.message : String(e)}\n`);
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
      err.write(`pyric database:rules:simulate: ${file.message}\n`);
      return 1;
    }
    try {
      rulesJson = JSON.parse(file.raw);
    } catch (e) {
      err.write(`pyric database:rules:simulate: ${e instanceof Error ? e.message : String(e)}\n`);
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
    const ir = RtdbMapper.mapToIR(rulesJson, null, databaseUrl);
    const result = simulateFn(ir, input);
    out.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.success ? 0 : 2;
  } catch (e) {
    err.write(`pyric database:rules:simulate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}
