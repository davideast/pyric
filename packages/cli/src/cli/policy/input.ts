/**
 * Top-level CLI flag and `--config` loader for `pyric policy <check|prove|emit>`.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  findMissingValueFlag,
  findUnknownFlag,
  formatCliFlagName,
  type ParsedArgs,
} from '../parse-args.js';
import {
  assertSafeKeys,
  isJsonOutput,
  isPlainRecord,
  parseConfigBool,
  parseConfigInt,
  parseIntInRange,
  parseRtdbBindings,
  parseScenarios,
  parseStringBindings,
  parseTargetsList,
  parseTemplate,
  PolicyInputError,
  readBooleanFlag,
  readJsonFile,
  readStringFlag,
  readStringListFlags,
  readText,
  validateKind,
  validateMode,
  validateOutputStem,
  validateRtdbPath,
} from './input-parsers.js';
import type {
  FirestoreBindings,
  FirestoreTemplate,
  PolicyCliDeps,
  PolicyCommandName,
  PolicyMode,
  PolicyProgramKind,
  PolicyTarget,
  ProvePolicyFuzzOptions,
  ProvePolicyScenario,
  RtdbBindings,
  StorageBindings,
  StorageTemplate,
} from './types.js';

export {
  defaultOutputStem,
  isJsonOutput,
  isPlainRecord,
  PolicyInputError,
  readBooleanFlag,
  validateOutputStem,
  validateRtdbPath,
} from './input-parsers.js';

const COMMON_VALUE_FLAGS = [
  'kind',
  'expression-limit',
  'config',
  'firestore-bindings',
  'storage-bindings',
  'rtdb-bindings',
  'mode',
] as const;

const CHECK_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  ...COMMON_VALUE_FLAGS,
  'json',
  'help',
  'h',
]);

const PROVE_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  ...COMMON_VALUE_FLAGS,
  'scenarios',
  'seed',
  'fuzz-cases',
  'max-duration-ms',
  'no-fuzz',
  'no-adversarial',
  'no-esm-verify',
  'json',
  'help',
  'h',
]);

const EMIT_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  ...COMMON_VALUE_FLAGS,
  'out-dir',
  'name',
  'targets',
  'target',
  'firestore-template',
  'storage-template',
  'rtdb-path',
  'manifest',
  'no-standalone',
  'no-write',
  'no-esm-verify',
  'json',
  'help',
  'h',
]);

export interface LoadedPolicyInputs {
  readonly file: string;
  readonly source: string;
  readonly kind?: PolicyProgramKind;
  readonly expressionLimit?: number;
  readonly mode: PolicyMode;
  readonly json: boolean;
  readonly firestoreBindings?: FirestoreBindings;
  readonly storageBindings?: StorageBindings;
  readonly rtdbBindings?: RtdbBindings;
  readonly firestoreTemplate?: FirestoreTemplate;
  readonly storageTemplate?: StorageTemplate;
  readonly rtdbPath?: string;
  readonly scenarios: ProvePolicyScenario[];
  readonly fuzz: Required<ProvePolicyFuzzOptions>;
  readonly outDir?: string;
  readonly name?: string;
  readonly targets?: PolicyTarget[];
  readonly manifestPath?: string;
  readonly noStandalone: boolean;
  readonly noWrite: boolean;
  readonly verifyEsm: boolean;
}

async function readDefaultStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readConfigSection(
  cfg: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (cfg === undefined || cfg[key] === undefined) return undefined;
  const val = cfg[key];
  if (!isPlainRecord(val)) {
    throw new PolicyInputError(`config.${key} must be a JSON object`);
  }
  assertSafeKeys(val, `config.${key}`);
  return val;
}

function readConfigString(
  obj: Record<string, unknown> | undefined,
  key: string,
  label: string,
): string | undefined {
  if (obj === undefined || obj[key] === undefined) return undefined;
  const val = obj[key];
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new PolicyInputError(`${label} must be a non-empty string`);
  }
  return val;
}

async function resolveOptionalBindings<T>(
  flagPath: string | undefined,
  cfgSection: Record<string, unknown> | undefined,
  cwd: string,
  cfgDir: string,
  readFileFn: typeof readFile,
  label: string,
  parser: (raw: unknown, name: string) => T,
): Promise<T | undefined> {
  if (flagPath !== undefined) {
    return parser(await readJsonFile(resolve(cwd, flagPath), readFileFn, label), label);
  }
  if (cfgSection?.bindings !== undefined) {
    return parser(cfgSection.bindings, `config.${label}`);
  }
  const bindingsFile = readConfigString(cfgSection, 'bindingsFile', `config.${label}File`);
  if (bindingsFile !== undefined) {
    const abs = resolve(cfgDir, bindingsFile);
    return parser(await readJsonFile(abs, readFileFn, `config.${label}File`), `config.${label}File`);
  }
  return undefined;
}

async function resolveOptionalTemplate<T extends FirestoreTemplate | StorageTemplate>(
  flagPath: string | undefined,
  cfgSection: Record<string, unknown> | undefined,
  cwd: string,
  cfgDir: string,
  kind: 'firestore' | 'storage',
  readFileFn: typeof readFile,
): Promise<T | undefined> {
  const label = `${kind} template`;
  if (flagPath !== undefined) {
    const abs = resolve(cwd, flagPath);
    return (await parseTemplate(
      await readJsonFile(abs, readFileFn, label),
      dirname(abs),
      kind,
      readFileFn,
      label,
    )) as T;
  }
  if (cfgSection?.template !== undefined) {
    return (await parseTemplate(
      cfgSection.template,
      cfgDir,
      kind,
      readFileFn,
      `config.${kind}.template`,
    )) as T;
  }
  const templateFile = readConfigString(cfgSection, 'templateFile', `config.${kind}.templateFile`);
  if (templateFile !== undefined) {
    const abs = resolve(cfgDir, templateFile);
    return (await parseTemplate(
      await readJsonFile(abs, readFileFn, `config.${kind}.templateFile`),
      dirname(abs),
      kind,
      readFileFn,
      `config.${kind}.templateFile`,
    )) as T;
  }
  return undefined;
}

export async function loadPolicyInputs(
  command: PolicyCommandName,
  parsed: ParsedArgs,
  deps: PolicyCliDeps,
): Promise<LoadedPolicyInputs> {
  const allowed =
    command === 'check'
      ? CHECK_ALLOWED_FLAGS
      : command === 'prove'
        ? PROVE_ALLOWED_FLAGS
        : EMIT_ALLOWED_FLAGS;
  const unknown = findUnknownFlag(parsed.flags, allowed);
  if (unknown !== undefined) {
    throw new PolicyInputError(`unknown option '${formatCliFlagName(unknown)}'`);
  }

  const valueFlags: string[] = [...COMMON_VALUE_FLAGS];
  if (command === 'prove') {
    valueFlags.push('scenarios', 'seed', 'fuzz-cases', 'max-duration-ms');
  } else if (command === 'emit') {
    valueFlags.push(
      'out-dir',
      'name',
      'targets',
      'target',
      'firestore-template',
      'storage-template',
      'rtdb-path',
      'manifest',
    );
  }
  const missing = findMissingValueFlag(parsed.flags, valueFlags);
  if (missing !== undefined) {
    throw new PolicyInputError(`missing value for --${missing}`);
  }

  const args = parsed.positional.slice(1);
  if (args.length === 0) {
    throw new PolicyInputError("missing policy file path (pass '-' to read stdin)");
  }
  if (args.length > 1) {
    throw new PolicyInputError(`unexpected extra argument '${args[1]}'`);
  }

  const file = args[0]!;
  const cwd = deps.cwd ?? process.cwd();
  const readFileFn = deps.readFile ?? readFile;
  const json = isJsonOutput(parsed.flags);

  let cfg: Record<string, unknown> | undefined;
  let cfgDir = cwd;
  const configFlag = readStringFlag(parsed.flags.get('config'));
  if (configFlag !== undefined) {
    const absCfg = resolve(cwd, configFlag);
    const rawCfg = await readJsonFile(absCfg, readFileFn, 'config file');
    if (!isPlainRecord(rawCfg)) {
      throw new PolicyInputError(`config file '${absCfg}' must contain a JSON object`);
    }
    assertSafeKeys(rawCfg, 'config');
    cfg = rawCfg;
    cfgDir = dirname(absCfg);
  }

  const source =
    file === '-'
      ? await (deps.readStdin ?? readDefaultStdin)()
      : await readText(resolve(cwd, file), readFileFn, 'policy file');

  const rawKind = readStringFlag(parsed.flags.get('kind')) ?? cfg?.kind;
  const kind = rawKind !== undefined ? validateKind(rawKind, '--kind') : undefined;

  const defaultMode: PolicyMode = command === 'emit' ? 'complete' : 'mixed';
  const mode = validateMode(
    readStringFlag(parsed.flags.get('mode')) ?? cfg?.mode ?? defaultMode,
    '--mode',
  );

  const flagLimit = readStringFlag(parsed.flags.get('expression-limit'));
  const expressionLimit =
    flagLimit !== undefined
      ? parseIntInRange(flagLimit, '--expression-limit', 1, 1000000)
      : cfg?.expressionLimit !== undefined
        ? parseConfigInt(cfg.expressionLimit, 'config.expressionLimit', 1, 1000000)
        : undefined;

  const cfgFs = readConfigSection(cfg, 'firestore');
  const cfgSt = readConfigSection(cfg, 'storage');
  const cfgRtdb = readConfigSection(cfg, 'rtdb');

  const firestoreBindings = await resolveOptionalBindings(
    readStringFlag(parsed.flags.get('firestore-bindings')),
    cfgFs,
    cwd,
    cfgDir,
    readFileFn,
    'firestore bindings',
    parseStringBindings,
  );
  const storageBindings = await resolveOptionalBindings(
    readStringFlag(parsed.flags.get('storage-bindings')),
    cfgSt,
    cwd,
    cfgDir,
    readFileFn,
    'storage bindings',
    parseStringBindings,
  );
  const rtdbBindings = await resolveOptionalBindings(
    readStringFlag(parsed.flags.get('rtdb-bindings')),
    cfgRtdb,
    cwd,
    cfgDir,
    readFileFn,
    'rtdb bindings',
    parseRtdbBindings,
  );
  const firestoreTemplate = await resolveOptionalTemplate<FirestoreTemplate>(
    readStringFlag(parsed.flags.get('firestore-template')),
    cfgFs,
    cwd,
    cfgDir,
    'firestore',
    readFileFn,
  );
  const storageTemplate = await resolveOptionalTemplate<StorageTemplate>(
    readStringFlag(parsed.flags.get('storage-template')),
    cfgSt,
    cwd,
    cfgDir,
    'storage',
    readFileFn,
  );

  const rawRtdbPath =
    readStringFlag(parsed.flags.get('rtdb-path')) ??
    readConfigString(cfgRtdb, 'path', 'config.rtdb.path');
  const rtdbPath = rawRtdbPath !== undefined ? validateRtdbPath(rawRtdbPath) : undefined;

  let scenarios: ProvePolicyScenario[] = [];
  const scenariosFlag = readStringFlag(parsed.flags.get('scenarios'));
  const cfgScenariosFile =
    scenariosFlag === undefined && cfg?.scenarios === undefined
      ? readConfigString(cfg, 'scenariosFile', 'config.scenariosFile')
      : undefined;
  if (scenariosFlag !== undefined) {
    scenarios = parseScenarios(
      await readJsonFile(resolve(cwd, scenariosFlag), readFileFn, 'scenarios'),
      'scenarios',
    );
  } else if (cfg?.scenarios !== undefined) {
    scenarios = parseScenarios(cfg.scenarios, 'config.scenarios');
  } else if (cfgScenariosFile !== undefined) {
    scenarios = parseScenarios(
      await readJsonFile(resolve(cfgDir, cfgScenariosFile), readFileFn, 'config.scenariosFile'),
      'config.scenariosFile',
    );
  }

  const cfgFuzz = readConfigSection(cfg, 'fuzz');
  const fuzzEnabled = readBooleanFlag(parsed.flags.get('no-fuzz'))
    ? false
    : cfgFuzz?.enabled !== undefined
      ? parseConfigBool(cfgFuzz.enabled, 'config.fuzz.enabled')
      : true;
  const includeAdversarial = readBooleanFlag(parsed.flags.get('no-adversarial'))
    ? false
    : cfgFuzz?.includeAdversarial !== undefined
      ? parseConfigBool(cfgFuzz.includeAdversarial, 'config.fuzz.includeAdversarial')
      : true;

  const seedFlag = readStringFlag(parsed.flags.get('seed'));
  const seed =
    seedFlag !== undefined
      ? parseIntInRange(seedFlag, '--seed', 0, 4294967295)
      : cfgFuzz?.seed !== undefined
        ? parseConfigInt(cfgFuzz.seed, 'config.fuzz.seed', 0, 4294967295)
        : 1337;

  const casesFlag = readStringFlag(parsed.flags.get('fuzz-cases'));
  const cases =
    casesFlag !== undefined
      ? parseIntInRange(casesFlag, '--fuzz-cases', 0, 2000)
      : cfgFuzz?.cases !== undefined
        ? parseConfigInt(cfgFuzz.cases, 'config.fuzz.cases', 0, 2000)
        : 64;

  const maxDurFlag = readStringFlag(parsed.flags.get('max-duration-ms'));
  const maxDurationMs =
    maxDurFlag !== undefined
      ? parseIntInRange(maxDurFlag, '--max-duration-ms', 100, 60000)
      : cfgFuzz?.maxDurationMs !== undefined
        ? parseConfigInt(cfgFuzz.maxDurationMs, 'config.fuzz.maxDurationMs', 100, 60000)
        : 10000;

  const flagOutDir = readStringFlag(parsed.flags.get('out-dir'));
  const cfgOutDir = flagOutDir === undefined ? readConfigString(cfg, 'outDir', 'config.outDir') : undefined;
  const outDir =
    flagOutDir !== undefined
      ? resolve(cwd, flagOutDir)
      : cfgOutDir !== undefined
        ? resolve(cfgDir, cfgOutDir)
        : undefined;

  const rawName =
    readStringFlag(parsed.flags.get('name')) ?? readConfigString(cfg, 'name', 'config.name');
  const name = rawName !== undefined ? validateOutputStem(rawName) : undefined;

  const flagTargets = readStringListFlags(parsed.flags, ['targets', 'target']);
  let targets: PolicyTarget[] | undefined;
  if (flagTargets !== undefined) {
    targets = parseTargetsList(flagTargets, '--targets');
  } else if (cfg?.targets !== undefined) {
    if (!Array.isArray(cfg.targets) || cfg.targets.some((t) => typeof t !== 'string')) {
      throw new PolicyInputError('config.targets must be an array of target names');
    }
    targets = parseTargetsList(cfg.targets as string[], 'config.targets');
  }

  const rawManifest = readStringFlag(parsed.flags.get('manifest'));
  return {
    file,
    source,
    kind,
    expressionLimit,
    mode,
    json,
    firestoreBindings,
    storageBindings,
    rtdbBindings,
    firestoreTemplate,
    storageTemplate,
    rtdbPath,
    scenarios,
    fuzz: { enabled: fuzzEnabled, seed, cases, includeAdversarial, maxDurationMs },
    outDir,
    name,
    targets,
    manifestPath: rawManifest !== undefined ? resolve(cwd, rawManifest) : undefined,
    noStandalone: readBooleanFlag(parsed.flags.get('no-standalone')),
    noWrite: readBooleanFlag(parsed.flags.get('no-write')),
    verifyEsm: !readBooleanFlag(parsed.flags.get('no-esm-verify')),
  };
}
