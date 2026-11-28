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
  assertAllowedKeys,
  assertSafeKeys,
  isJsonOutput,
  isPlainRecord,
  parseBooleanFlag,
  parseConfigBool,
  parseConfigInt,
  parseIntInRange,
  parseRtdbBindings,
  parseScenarios,
  parseStringBindings,
  parseTargetsList,
  parseTemplate,
  PolicyInputError,
  readJsonFile,
  readStringFlag,
  readStringListFlags,
  readText,
  readValidatedStringFlag,
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
  parseBooleanFlag,
  PolicyInputError,
  readBooleanFlag,
  validateOutputStem,
  validateRtdbPath,
} from './input-parsers.js';

const ALLOWED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'expressionLimit',
  'mode',
  'name',
  'outDir',
  'targets',
  'firestore',
  'storage',
  'rtdb',
  'scenarios',
  'scenariosFile',
  'fuzz',
]);

const ALLOWED_RULES_TARGET_KEYS: ReadonlySet<string> = new Set([
  'bindings',
  'bindingsFile',
  'template',
  'templateFile',
]);

const ALLOWED_RTDB_SECTION_KEYS: ReadonlySet<string> = new Set([
  'bindings',
  'bindingsFile',
  'path',
]);

const ALLOWED_FUZZ_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'seed',
  'cases',
  'includeAdversarial',
  'maxDurationMs',
]);

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
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (cfg === undefined || cfg[key] === undefined) return undefined;
  const val = cfg[key];
  if (!isPlainRecord(val)) {
    throw new PolicyInputError(`config.${key} must be a JSON object`);
  }
  assertSafeKeys(val, `config.${key}`);
  assertAllowedKeys(val, allowedKeys, `config.${key}`);
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

  if (parsed.passthrough !== undefined && parsed.passthrough.length > 0) {
    throw new PolicyInputError(
      `unexpected trailing arguments after '--': ${parsed.passthrough.join(' ')}`,
    );
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
    assertAllowedKeys(rawCfg, ALLOWED_CONFIG_KEYS, 'config');
    cfg = rawCfg;
    cfgDir = dirname(absCfg);
  }

  const source =
    file === '-'
      ? await (deps.readStdin ?? readDefaultStdin)()
      : await readText(resolve(cwd, file), readFileFn, 'policy file');

  const cfgKind = cfg?.kind !== undefined ? validateKind(cfg.kind, 'config.kind') : undefined;
  const flagKind = readValidatedStringFlag(parsed.flags.get('kind'), '--kind', validateKind);
  const kind = flagKind ?? cfgKind;

  const defaultMode: PolicyMode = command === 'emit' ? 'complete' : 'mixed';
  const cfgMode = cfg?.mode !== undefined ? validateMode(cfg.mode, 'config.mode') : undefined;
  const flagMode = readValidatedStringFlag(parsed.flags.get('mode'), '--mode', validateMode);
  const mode = flagMode ?? cfgMode ?? defaultMode;

  const cfgLimit =
    cfg?.expressionLimit !== undefined
      ? parseConfigInt(cfg.expressionLimit, 'config.expressionLimit', 1, 1000000)
      : undefined;
  const flagLimit = readValidatedStringFlag(
    parsed.flags.get('expression-limit'),
    '--expression-limit',
    (raw, label) => parseIntInRange(raw, label, 1, 1000000),
  );
  const expressionLimit = flagLimit ?? cfgLimit;

  const cfgFs = readConfigSection(cfg, 'firestore', ALLOWED_RULES_TARGET_KEYS);
  const cfgSt = readConfigSection(cfg, 'storage', ALLOWED_RULES_TARGET_KEYS);
  const cfgRtdb = readConfigSection(cfg, 'rtdb', ALLOWED_RTDB_SECTION_KEYS);

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

  const cfgRtdbPath = readConfigString(cfgRtdb, 'path', 'config.rtdb.path');
  const validatedCfgRtdbPath = cfgRtdbPath !== undefined ? validateRtdbPath(cfgRtdbPath) : undefined;
  const flagRtdbPath = readValidatedStringFlag(
    parsed.flags.get('rtdb-path'),
    '--rtdb-path',
    (raw) => validateRtdbPath(raw),
  );
  const rtdbPath = flagRtdbPath ?? validatedCfgRtdbPath;

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

  const cfgFuzz = readConfigSection(cfg, 'fuzz', ALLOWED_FUZZ_KEYS);
  const noFuzz = parseBooleanFlag(parsed.flags.get('no-fuzz'), '--no-fuzz');
  const cfgFuzzEnabled =
    cfgFuzz?.enabled !== undefined ? parseConfigBool(cfgFuzz.enabled, 'config.fuzz.enabled') : true;
  const fuzzEnabled = noFuzz ? false : cfgFuzzEnabled;

  const noAdversarial = parseBooleanFlag(parsed.flags.get('no-adversarial'), '--no-adversarial');
  const cfgAdv =
    cfgFuzz?.includeAdversarial !== undefined
      ? parseConfigBool(cfgFuzz.includeAdversarial, 'config.fuzz.includeAdversarial')
      : true;
  const includeAdversarial = noAdversarial ? false : cfgAdv;

  const cfgSeed =
    cfgFuzz?.seed !== undefined
      ? parseConfigInt(cfgFuzz.seed, 'config.fuzz.seed', 0, 4294967295)
      : undefined;
  const flagSeed = readValidatedStringFlag(parsed.flags.get('seed'), '--seed', (raw, label) =>
    parseIntInRange(raw, label, 0, 4294967295),
  );
  const seed = flagSeed ?? cfgSeed ?? 1337;

  const cfgCases =
    cfgFuzz?.cases !== undefined
      ? parseConfigInt(cfgFuzz.cases, 'config.fuzz.cases', 0, 2000)
      : undefined;
  const flagCases = readValidatedStringFlag(
    parsed.flags.get('fuzz-cases'),
    '--fuzz-cases',
    (raw, label) => parseIntInRange(raw, label, 0, 2000),
  );
  const cases = flagCases ?? cfgCases ?? 64;

  const cfgMaxDur =
    cfgFuzz?.maxDurationMs !== undefined
      ? parseConfigInt(cfgFuzz.maxDurationMs, 'config.fuzz.maxDurationMs', 100, 60000)
      : undefined;
  const flagMaxDur = readValidatedStringFlag(
    parsed.flags.get('max-duration-ms'),
    '--max-duration-ms',
    (raw, label) => parseIntInRange(raw, label, 100, 60000),
  );
  const maxDurationMs = flagMaxDur ?? cfgMaxDur ?? 10000;

  const flagOutDir = readStringFlag(parsed.flags.get('out-dir'));
  const cfgOutDir = flagOutDir === undefined ? readConfigString(cfg, 'outDir', 'config.outDir') : undefined;
  const outDir =
    flagOutDir !== undefined
      ? resolve(cwd, flagOutDir)
      : cfgOutDir !== undefined
        ? resolve(cfgDir, cfgOutDir)
        : undefined;

  const cfgName = readConfigString(cfg, 'name', 'config.name');
  const validatedCfgName = cfgName !== undefined ? validateOutputStem(cfgName) : undefined;
  const flagName = readValidatedStringFlag(parsed.flags.get('name'), '--name', (raw) =>
    validateOutputStem(raw),
  );
  const name = flagName ?? validatedCfgName;

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
  const noStandalone = parseBooleanFlag(parsed.flags.get('no-standalone'), '--no-standalone');
  const noWrite = parseBooleanFlag(parsed.flags.get('no-write'), '--no-write');
  const noEsmVerify = parseBooleanFlag(parsed.flags.get('no-esm-verify'), '--no-esm-verify');
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
    noStandalone,
    noWrite,
    verifyEsm: !noEsmVerify,
  };
}
