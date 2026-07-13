import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import {
  evaluateStorageRules,
  parseStorageRules,
  type StorageRequest,
  type StorageResource,
} from 'pyric/storage';
import { readFirebaseJson, type FirebaseJson } from './firebase-json.js';
import type { ParsedArgs } from './parse-args.js';

export interface StorageRulesDeps {
  readFile?: typeof readFile;
  parseStorageRules?: typeof parseStorageRules;
  evaluateStorageRules?: typeof evaluateStorageRules;
  readFirebaseJson?: (cwd: string) => Promise<FirebaseJson>;
  readStdin?: () => Promise<string>;
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

interface StorageSimulationPayload {
  source?: string;
  request?: StorageRequest;
  resource?: StorageResource | null;
  now?: string;
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

async function projectRulesSource(deps: StorageRulesDeps): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const firebaseJson = await (deps.readFirebaseJson ?? readFirebaseJson)(cwd);
  const storageConfig = Array.isArray(firebaseJson.storage)
    ? firebaseJson.storage.find((entry) => entry.rules)
    : firebaseJson.storage;
  const rulesPath = storageConfig?.rules;
  if (!rulesPath) throw new Error('firebase.json has no `storage.rules` path.');
  return await (deps.readFile ?? readFile)(resolvePath(cwd, rulesPath), 'utf-8');
}

export async function runStorageRulesLint(
  parsed: ParsedArgs,
  deps: StorageRulesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const path = parsed.positional[0];
  if (!path) {
    err.write(
      'pyric storage rules lint: missing rules-file path. Usage: pyric storage rules lint <path>\n',
    );
    return 1;
  }

  let source: string;
  try {
    source = await (deps.readFile ?? readFile)(resolvePath(cwd, path), 'utf-8');
  } catch (error) {
    err.write(
      `pyric storage rules lint: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  try {
    (deps.parseStorageRules ?? parseStorageRules)(source);
    out.write(`${JSON.stringify({ warnings: [], metrics: { sourceSize: source.length } }, null, 2)}\n`);
    return 0;
  } catch (error) {
    out.write(
      `${JSON.stringify(
        {
          warnings: [],
          parseError: { message: error instanceof Error ? error.message : String(error) },
          metrics: { sourceSize: source.length },
        },
        null,
        2,
      )}\n`,
    );
    return 2;
  }
}

export async function runStorageRulesSimulate(
  parsed: ParsedArgs,
  deps: StorageRulesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  let source: string;
  let request: StorageRequest;
  let resource: StorageResource | null;
  let now = new Date();

  if (parsed.flags.get('stdin') === true) {
    let payload: StorageSimulationPayload;
    try {
      payload = JSON.parse(await (deps.readStdin ?? defaultReadStdin)()) as StorageSimulationPayload;
    } catch (error) {
      err.write(
        `pyric storage rules simulate: failed to parse stdin JSON: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    if (!payload.request) {
      err.write('pyric storage rules simulate: stdin payload must include `request`.\n');
      return 1;
    }
    try {
      source = payload.source ?? (await projectRulesSource(deps));
    } catch (error) {
      err.write(
        `pyric storage rules simulate: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    request = payload.request;
    resource = payload.resource ?? null;
    if (payload.now !== undefined) {
      now = new Date(payload.now);
      if (Number.isNaN(now.getTime())) {
        err.write('pyric storage rules simulate: `now` must be an ISO-8601 timestamp.\n');
        return 1;
      }
    }
  } else {
    try {
      source = await projectRulesSource(deps);
    } catch (error) {
      err.write(
        `pyric storage rules simulate: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    request = {
      auth: null,
      method: 'get',
      path: 'b/pyric-default/o/sample/x',
    };
    resource = null;
  }

  try {
    const rules = (deps.parseStorageRules ?? parseStorageRules)(source);
    const result = (deps.evaluateStorageRules ?? evaluateStorageRules)(
      rules,
      { request, resource },
      now,
    );
    out.write(`${JSON.stringify({ success: true, data: result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    err.write(
      `pyric storage rules simulate: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}
