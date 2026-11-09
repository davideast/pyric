import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  ExtractFirestoreIndexesHandler,
  type ExtractIndexesOptions,
} from 'pyric/rules/internal/extract';
import { findMissingValueFlag, type ParsedArgs } from './parse-args.js';
import {
  readFirebaseJson,
  readFirebaseRc,
  type FirebaseJson,
  type FirebaseRc,
} from './firebase-json.js';
import { resolveFirebaseProject } from './firebase-project.js';
import { defaultFirestoreDatabase, firestoreRulesConfig } from 'pyric/sandbox/internal';

type ExtractResult = ReturnType<ExtractFirestoreIndexesHandler['execute']>;

export interface FirestoreIndexesDeps {
  extract?: (options: ExtractIndexesOptions) => ExtractResult;
  readFirebaseJson?: (cwd: string) => Promise<FirebaseJson>;
  readFirebaseRc?: (cwd: string) => Promise<FirebaseRc | null>;
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
  const missingFlag = findMissingValueFlag(parsed.flags, ['out']);
  if (missingFlag !== undefined) {
    err.write(`pyric firestore indexes generate: missing value for --${missingFlag}\n`);
    return 2;
  }
  if (parsed.positional.length === 0) {
    err.write(
      'pyric firestore indexes generate: missing source path. Usage: pyric firestore indexes generate <path...> [--out <path>]\n',
    );
    return 1;
  }

  const extract =
    deps.extract ??
    ((options: ExtractIndexesOptions) => new ExtractFirestoreIndexesHandler().execute(options));
  const result = extract({
    paths: parsed.positional.map((path) => resolvePath(cwd, path)),
    projectDir: cwd,
  });
  if (!result.success) {
    err.write(`pyric firestore indexes generate: ${result.error.message}\n`);
    return 2;
  }

  const outFlag = parsed.flags.get('out');
  let configuredPath: string | undefined;
  if (typeof outFlag !== 'string') {
    try {
      const fbJson = await (deps.readFirebaseJson ?? readFirebaseJson)(cwd);
      const rc = await (deps.readFirebaseRc ?? readFirebaseRc)(cwd).catch(() => null);
      const projectId = resolveFirebaseProject({ projectDir: cwd, rc }).projectId;
      const targetDatabases = (targetName: string): unknown => {
        if (!projectId || !rc?.targets) return undefined;
        const projTargets = Object.hasOwn(rc.targets, projectId)
          ? rc.targets[projectId]
          : undefined;
        const fsTargets = projTargets?.firestore;
        if (!fsTargets || !Object.hasOwn(fsTargets, targetName)) return undefined;
        return fsTargets[targetName];
      };
      configuredPath = defaultFirestoreDatabase(
        firestoreRulesConfig(fbJson.firestore, { targetDatabases }),
      )?.indexesFile;
    } catch {
      configuredPath = undefined;
    }
  }
  let relativeOut = configuredPath ?? 'firestore.indexes.json';
  if (typeof outFlag === 'string') {
    relativeOut = outFlag;
  }
  const outputPath = resolvePath(cwd, relativeOut);
  await (deps.mkdir ?? mkdir)(dirname(outputPath), { recursive: true });
  await (deps.writeFile ?? writeFile)(
    outputPath,
    `${JSON.stringify(result.data.config, null, 2)}\n`,
    'utf-8',
  );

  out.write(`pyric firestore indexes generate: wrote ${outputPath}\n`);
  for (const warning of result.data.warnings) {
    let where = warning.file;
    if (warning.line !== undefined) {
      where = `${warning.file}:${warning.line}`;
    }
    err.write(`pyric firestore indexes generate: warning: ${where}: ${warning.message}\n`);
  }
  return 0;
}
