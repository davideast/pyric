import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  ExtractFirestoreIndexesHandler,
  type ExtractIndexesOptions,
} from 'pyric/rules/internal/extract';
import type { ParsedArgs } from './parse-args.js';
import { readFirebaseJson, type FirebaseJson } from './firebase-json.js';

type ExtractResult = ReturnType<ExtractFirestoreIndexesHandler['execute']>;

export interface FirestoreIndexesDeps {
  extract?: (options: ExtractIndexesOptions) => ExtractResult;
  readFirebaseJson?: (cwd: string) => Promise<FirebaseJson>;
  writeFile?: typeof writeFile;
  mkdir?: typeof mkdir;
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

export async function runFirestoreIndexesGenerate(
  parsed: ParsedArgs,
  deps: FirestoreIndexesDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  if (parsed.positional.length === 0) {
    err.write(
      'pyric firestore indexes generate: missing source path. Usage: pyric firestore indexes generate <path...> [--out <path>]\n',
    );
    return 1;
  }

  const extract =
    deps.extract ??
    ((options: ExtractIndexesOptions) => new ExtractFirestoreIndexesHandler().execute(options));
  const result = extract({ paths: parsed.positional.map((path) => resolvePath(cwd, path)) });
  if (!result.success) {
    err.write(`pyric firestore indexes generate: ${result.error.message}\n`);
    return 2;
  }

  const outFlag = parsed.flags.get('out');
  let configuredPath: string | undefined;
  if (typeof outFlag !== 'string') {
    try {
      configuredPath = (await (deps.readFirebaseJson ?? readFirebaseJson)(cwd)).firestore?.indexes;
    } catch {
      configuredPath = undefined;
    }
  }
  const outputPath = resolvePath(
    cwd,
    typeof outFlag === 'string' ? outFlag : configuredPath ?? 'firestore.indexes.json',
  );
  await (deps.mkdir ?? mkdir)(dirname(outputPath), { recursive: true });
  await (deps.writeFile ?? writeFile)(
    outputPath,
    `${JSON.stringify(result.data.config, null, 2)}\n`,
    'utf-8',
  );

  out.write(`pyric firestore indexes generate: wrote ${outputPath}\n`);
  for (const warning of result.data.warnings) {
    err.write(`pyric firestore indexes generate: warning: ${warning.file}: ${warning.message}\n`);
  }
  return 0;
}
