import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  deriveRulesTestCases,
  fixtureVerifiableServices,
  parseVerifyFixture,
  verifyFixture,
  VerifyInputError,
  type PyricVerifyFixture,
  type VerifyEngine,
  type VerifiableService,
  type VerifyDivergence,
  type VerifyFixtureOptions,
  type VerifyResult,
  type VerifyRulesInput,
  type VerifyServiceResult,
} from '../verify/index.js';
import { readFirebaseJson, readFirebaseRcSync, type FirebaseJson } from './firebase-json.js';
import { resolveFirebaseProject } from './firebase-project.js';
import { readPyricConfig } from './pyric-config.js';
import { markedProject, StagingSafetyError, stagingMarker } from '../verify/staging/engine.js';
import { RtdbRestClient } from '../verify/staging/rest.js';
import { assertNotAppInstance, stagingTargetFrom, stagingToken, type StagingTarget } from '../verify/staging/target.js';
import type { FlagValue, ParsedArgs } from './parse-args.js';
import { resolveScope } from '../credentials/node/scope.js';
import { CAPTURE_RELATIVE_PATH } from '../serve/capture-store.js';
import {
  isRtdbInstanceRulesKey,
  resolveRtdbCandidateRules,
  rtdbInstanceOfRulesKey,
  type RtdbRulesOverrides,
} from './verify-rtdb-rules.js';

export type Fixture = PyricVerifyFixture;

export interface FixtureResult {
  name: string;
  description?: string;
  ok: boolean;
  result: VerifyResult;
}

export interface VerifyCliDeps {
  resolveScope?: typeof resolveScope;
  /** The staging instance's REST client; tests pass one backed by a local sandbox. */
  stagingClient?: (target: StagingTarget, token: () => Promise<string>) => RtdbRestClient;
}

export function loadFixture(path: string): Fixture {
  return parseVerifyFixture(JSON.parse(readFileSync(path, 'utf8')));
}

export async function runFixture(
  name: string,
  fixture: Fixture,
  rules: VerifyRulesInput,
  options: Omit<VerifyFixtureOptions, 'rules'> = {},
): Promise<FixtureResult> {
  const result = await verifyFixture(fixture, { rules, ...options });
  return {
    name,
    ...(fixture.description !== undefined ? { description: fixture.description } : {}),
    ok: result.ok,
    result,
  };
}

export async function checkDirectory(
  dir: string,
  rules: VerifyRulesInput,
  options: Omit<VerifyFixtureOptions, 'rules'> = {},
): Promise<{ results: FixtureResult[]; allOk: boolean }> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const results = await Promise.all(
    files.map((f) => runFixture(basename(f, '.json'), loadFixture(join(dir, f)), rules, options)),
  );
  return { results, allOk: results.every((r) => r.ok) };
}

export function formatResults(results: FixtureResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const marker = result.ok ? '✓' : '✗';
    const desc = result.description ? ` - ${result.description}` : '';
    const serviceSummary = Object.values(result.result.services)
      .filter((service): service is VerifyServiceResult => service !== undefined)
      .map((service) => {
        const failures = failingDivergences(service.divergences).length;
        const info = service.divergences.length - failures;
        return service.ok
          ? `${service.service}: ok (${info} informational)`
          : `${service.service}: ${failures} failure(s)`;
      })
      .join(', ');
    lines.push(`${marker} ${result.name}${desc} - ${serviceSummary}`);
    for (const service of Object.values(result.result.services)) {
      if (!service) continue;
      const engines = Object.values(service.engines ?? {}).filter((engine) => engine !== undefined);
      // With more than one engine, each line names the engine that reported it.
      const groups = engines.length > 1
        ? engines.map((engine) => ({ label: ` ${engine.engine}`, divergences: engine.divergences }))
        : [{ label: '', divergences: service.divergences }];
      for (const group of groups) {
        for (const divergence of failingDivergences(group.divergences)) {
          const instance = divergence.instance === undefined ? '' : ` ${divergence.instance}`;
          lines.push(`    [${service.service}${instance}${group.label}] ${formatDivergence(divergence)}`);
        }
      }
    }
  }
  return lines.join('\n');
}

export async function runVerify(parsed: ParsedArgs, deps: VerifyCliDeps = {}): Promise<number> {
  const cwd = process.cwd();
  const json = parsed.flags.get('json') === true;

  if (parsed.positional[0] === 'cases') {
    return runVerifyCases(parsed, cwd);
  }
  if (parsed.positional[0] === 'staging') {
    return runVerifyStaging(parsed, cwd, deps);
  }

  const target = parsed.positional[0];
  const inputPath = resolve(cwd, target ?? CAPTURE_RELATIVE_PATH);
  if (!existsSync(inputPath)) {
    if (target) {
      process.stderr.write(`pyric verify: no such fixture or directory: ${inputPath}\n`);
    } else {
      process.stderr.write(
        `pyric verify: no captured session at ${CAPTURE_RELATIVE_PATH}.\n` +
          '  Run `pyric sandbox`, exercise your app, then `pyric verify`, or pass a fixture path.\n',
      );
    }
    return 2;
  }

  let loaded: Array<{ name: string; fixture: Fixture }>;
  try {
    loaded = statSync(inputPath).isDirectory()
      ? loadFixturesFromDirectory(inputPath)
      : [{ name: basename(inputPath, '.json'), fixture: loadFixture(inputPath) }];
  } catch (e) {
    process.stderr.write(`pyric verify: failed to load fixture: ${messageOf(e)}\n`);
    return 2;
  }
  if (loaded.length === 0) {
    process.stderr.write(`pyric verify: no .json fixtures in ${inputPath}\n`);
    return 2;
  }

  let services: VerifiableService[];
  try {
    services = selectedServices(parsed.flags.get('service'), loaded.map((item) => item.fixture));
  } catch (e) {
    process.stderr.write(`pyric verify: ${messageOf(e)}\n`);
    return 2;
  }

  let engines: VerifyEngine[];
  try {
    engines = parseEngines(parsed.flags.get('engine'));
  } catch (e) {
    process.stderr.write(`pyric verify: ${messageOf(e)}\n`);
    return 2;
  }

  // The staging target is checked before anything else reads the project: an
  // instance the app uses is refused before a request is made.
  let staging: VerifyFixtureOptions['staging'];
  if (engines.includes('staging')) {
    try {
      staging = await openStagingInstance(cwd, stringFlag(parsed.flags.get('project')), deps);
    } catch (e) {
      process.stderr.write(`pyric verify: ${messageOf(e)}\n`);
      return 2;
    }
  }

  let rulesResolution: { rules: VerifyRulesInput; paths: Record<string, string> };
  try {
    rulesResolution = await resolveCandidateRules({
      cwd,
      services,
      fixtures: loaded.map((item) => item.fixture),
      rulesFlag: parsed.flags.get('rules'),
      project: stringFlag(parsed.flags.get('project')),
    });
  } catch (e) {
    process.stderr.write(`pyric verify: ${messageOf(e)}\n`);
    return 2;
  }

  let rulesTestApi: VerifyFixtureOptions['rulesTestApi'];
  if (engines.includes('rulesTestApi')) {
    try {
      const resolved = await (deps.resolveScope ?? resolveScope)({
        projectId: stringFlag(parsed.flags.get('project')),
      });
      rulesTestApi = { scope: resolved.scope };
    } catch (e) {
      process.stderr.write(`pyric verify: ${messageOf(e)}\n`);
      return 2;
    }
  }

  let results: FixtureResult[];
  try {
    results = await Promise.all(
      loaded.map((item) =>
        runFixture(item.name, item.fixture, rulesResolution.rules, {
          services,
          engines,
          ...(rulesTestApi ? { rulesTestApi } : {}),
          ...(staging ? { staging } : {}),
        })),
    );
  } catch (e) {
    const prefix = e instanceof VerifyInputError ? 'invalid input' : e instanceof StagingSafetyError ? 'staging instance' : 'failed to replay';
    process.stderr.write(`pyric verify: ${prefix}: ${messageOf(e)}\n`);
    return 2;
  }
  const allOk = results.every((result) => result.ok);

  if (json) {
    process.stdout.write(
      JSON.stringify({
        ok: allOk,
        engines,
        rulesPaths: rulesResolution.paths,
        results: results.map((result) => ({
          name: result.name,
          description: result.description,
          ok: result.ok,
          services: result.result.services,
        })),
      }) + '\n',
    );
  } else {
    process.stdout.write(formatResults(results) + '\n');
    if (!allOk) {
      const failed = results.filter((result) => !result.ok).length;
      const rules = Object.entries(rulesResolution.paths)
        .map(([key, path]) => `${key}=${basename(path)}`)
        .join(', ');
      process.stderr.write(
        `\n✗ ${failed} session(s) regressed under ${rules}.\n`,
      );
    } else {
      process.stdout.write('\n✓ all selected services replay cleanly.\n');
    }
  }
  return allOk ? 0 : 1;
}

function runVerifyCases(parsed: ParsedArgs, cwd: string): number {
  const target = parsed.positional[1];
  const inputPath = resolve(cwd, target ?? CAPTURE_RELATIVE_PATH);
  if (!existsSync(inputPath)) {
    process.stderr.write(`pyric verify cases: no such fixture: ${inputPath}\n`);
    return 2;
  }

  const services = flagStrings(parsed.flags.get('service')).map(toVerifiableService);
  if (services.some((service) => service !== 'firestore')) {
    process.stderr.write('pyric verify cases: only --service firestore is supported for Rules Test API case derivation.\n');
    return 2;
  }

  let fixture: Fixture;
  try {
    fixture = loadFixture(inputPath);
  } catch (e) {
    process.stderr.write(`pyric verify cases: failed to load fixture: ${messageOf(e)}\n`);
    return 2;
  }

  const result = deriveRulesTestCases(fixture, {
    service: 'firestore',
  });
  const output = JSON.stringify(result, null, 2) + '\n';
  const out = stringFlag(parsed.flags.get('out'));
  if (out) {
    writeFileSync(resolve(cwd, out), output);
  } else {
    process.stdout.write(output);
  }
  return result.ok ? 0 : 1;
}

/** The staging instance from `pyric.json`, refused when the app uses it, with credentials for its project. */
async function openStagingInstance(
  cwd: string,
  appProjectOption: string | undefined,
  deps: VerifyCliDeps,
): Promise<{ client: RtdbRestClient; projectId: string; target: StagingTarget; source: string }> {
  const target = stagingTargetFrom(await readPyricConfig(cwd));
  const firebaseJson = await readFirebaseJsonOrNull(cwd);
  const appProject = resolveFirebaseProject({ projectDir: cwd, ...(appProjectOption ? { option: appProjectOption } : {}) });
  assertNotAppInstance(target, {
    firebaseJson,
    ...(appProject.projectId ? { appProjectId: appProject.projectId } : {}),
    targetInstances: databaseTargetInstances(cwd, appProject.projectId),
  });
  const credentials = await stagingToken(target.projectId, deps.resolveScope ? { resolve: deps.resolveScope } : {});
  const client = deps.stagingClient?.(target, credentials.token) ?? new RtdbRestClient(target.databaseUrl, credentials.token);
  return { client, projectId: target.projectId, target, source: credentials.source };
}

/** Every instance a `.firebaserc` database target maps for the app's project. */
function databaseTargetInstances(cwd: string, projectId: string | undefined): string[] {
  if (!projectId) return [];
  try {
    const rc = readFirebaseRcSync(cwd) as { targets?: Record<string, { database?: Record<string, string[]> }> } | null;
    return Object.values(rc?.targets?.[projectId]?.database ?? {}).flat();
  } catch {
    return [];
  }
}

/** `pyric verify staging init`: enroll the configured instance, once. */
async function runVerifyStaging(parsed: ParsedArgs, cwd: string, deps: VerifyCliDeps): Promise<number> {
  if (parsed.positional[1] !== 'init') {
    process.stderr.write('pyric verify staging: the only subcommand is `init`, which enrolls the instance pyric.json names.\n');
    return 2;
  }
  let opened: Awaited<ReturnType<typeof openStagingInstance>>;
  try {
    opened = await openStagingInstance(cwd, stringFlag(parsed.flags.get('project')), deps);
  } catch (e) {
    process.stderr.write(`pyric verify staging init: ${messageOf(e)}\n`);
    return 2;
  }
  const { client, target } = opened;
  try {
    const rules = await client.getRulesText();
    const marked = markedProject(rules);
    if (marked === target.projectId) {
      process.stdout.write(`✓ ${target.databaseUrl} is already enrolled for project ${target.projectId}.\n`);
      return 0;
    }
    if (marked !== undefined) {
      process.stderr.write(`pyric verify staging init: ${target.databaseUrl} is enrolled for project ${marked}, not ${target.projectId}.\n`);
      return 2;
    }
    const root = await client.get('/', { shallow: true });
    if (root.status !== 200 || root.body !== null) {
      process.stderr.write(
        `pyric verify staging init: refusing to enroll ${target.databaseUrl}: it holds data (or could not be read, HTTP ${root.status}). ` +
          'The staging engine replaces an instance\'s rules and data, so enroll an empty instance created for it.\n',
      );
      return 2;
    }
    const enrolled = `${stagingMarker(target.projectId)}\n${rules.trimStart()}`;
    const dry = await client.putRules(enrolled, { dryRun: true });
    if (dry.status !== 200) throw new Error(`production refused the marked rules: HTTP ${dry.status} ${dry.text.slice(0, 200)}`);
    const put = await client.putRules(enrolled);
    if (put.status !== 200) throw new Error(`deploying the marked rules failed: HTTP ${put.status} ${put.text.slice(0, 200)}`);
    if (markedProject(await client.getRulesText()) !== target.projectId) throw new Error('the marker did not read back.');
  } catch (e) {
    process.stderr.write(`pyric verify staging init: ${messageOf(e)}\n`);
    return 1;
  }
  process.stdout.write(
    `✓ enrolled ${target.databaseUrl} (project ${target.projectId}, credentials: ${opened.source}).\n` +
      '  Run `pyric verify --engine staging` to replay a captured session against it; add `--engine sandbox` to compare engines.\n',
  );
  return 0;
}

function loadFixturesFromDirectory(dir: string): Array<{ name: string; fixture: Fixture }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: basename(f, '.json'), fixture: loadFixture(join(dir, f)) }));
}

function selectedServices(flag: FlagValue | undefined, fixtures: Fixture[]): VerifiableService[] {
  const explicit = flagStrings(flag);
  if (explicit.length > 0) {
    return explicit.map(toVerifiableService);
  }

  const union = new Set<VerifiableService>();
  for (const fixture of fixtures) {
    for (const service of fixtureVerifiableServices(fixture)) {
      union.add(service);
    }
  }
    if ( union.size === 0 ) {
      throw new Error('fixture does not contain firestore, rtdb, or storage rules services.');
    }
  return [...union].sort();
}

function parseEngines(flag: FlagValue | undefined): VerifyEngine[] {
  const raw = flagStrings(flag);
  if (raw.length === 0) return ['sandbox'];
  const out: VerifyEngine[] = [];
  for (const item of raw) {
    if (item === 'both') {
      pushUnique(out, 'sandbox');
      pushUnique(out, 'rulesTestApi');
    } else if (item === 'sandbox') {
      pushUnique(out, 'sandbox');
    } else if (item === 'rules-test-api' || item === 'rulesTestApi') {
      pushUnique(out, 'rulesTestApi');
    } else if (item === 'staging') {
      pushUnique(out, 'staging');
    } else {
      throw new Error(`unsupported verify engine '${item}'. Supported engines: sandbox, rules-test-api, staging, both.`);
    }
  }
  return out;
}

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) items.push(item);
}

interface CandidateRulesInput {
  cwd: string;
  services: VerifiableService[];
  fixtures: Fixture[];
  rulesFlag: FlagValue | undefined;
  project: string | undefined;
}

async function resolveCandidateRules(
  input: CandidateRulesInput,
): Promise<{ rules: VerifyRulesInput; paths: Record<string, string> }> {
  const { cwd, services } = input;
  const overrides = parseRulesOverrides(input.rulesFlag);
  let firebaseJson: Promise<FirebaseJson | null> | undefined;
  const readConfig = (): Promise<FirebaseJson | null> => (firebaseJson ??= readFirebaseJsonOrNull(cwd));

  const rules: VerifyRulesInput = {};
  const paths: Record<string, string> = {};
  if (services.includes('firestore')) {
    const rel = overrides.firestore ?? (await readConfig())?.firestore?.rules;
    if (!rel) {
      throw new Error('missing candidate firestore rules. Pass --rules firestore=<path> or configure firebase.json.');
    }
    const path = resolve(cwd, rel);
    if (!existsSync(path)) {
      throw new Error(`rules file not found for firestore: ${path}`);
    }
    paths.firestore = path;
    rules.firestore = readFileSync(path, 'utf8');
  }
  if (services.includes('rtdb')) {
    const rtdb = await resolveRtdbCandidateRules({
      cwd,
      fixtures: input.fixtures,
      overrides: overrides.rtdb,
      readFirebaseJson: readConfig,
      ...(input.project ? { project: input.project } : {}),
    });
    Object.assign(rules, rtdb.rules);
    Object.assign(paths, rtdb.paths);
  }
  if (services.includes('storage')) {
    const configured = configuredStorageRules(await readConfig());
    const defaultStoragePath = resolve(cwd, 'storage.rules');
    const rel =
      overrides.storage ??
      configured ??
      (existsSync(defaultStoragePath) ? 'storage.rules' : undefined);
    if (!rel) {
      throw new Error('missing candidate storage rules. Pass --rules storage=<path> or configure firebase.json.');
    }
    const path = resolve(cwd, rel);
    if (!existsSync(path)) {
      throw new Error(`rules file not found for storage: ${path}`);
    }
    paths.storage = path;
    rules.storage = readFileSync(path, 'utf8');
  }
  return { rules, paths };
}

function configuredStorageRules(config: FirebaseJson | null): string | undefined {
  const block = config?.storage;
  const entries = block ? (Array.isArray(block) ? block : [block]) : [];
  return entries.find((e) => e && typeof e === 'object' && e.rules)?.rules;
}

function parseRulesOverrides(flag: FlagValue | undefined): {
  firestore?: string;
  rtdb: RtdbRulesOverrides;
  storage?: string;
} {
  const out: { firestore?: string; rtdb: RtdbRulesOverrides; storage?: string } = {
    rtdb: { instances: [] },
  };
  for (const raw of flagStrings(flag)) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new Error(`--rules must use service-qualified values like --rules rtdb=database.rules.json or --rules rtdb:<instance>=<path>.`);
    }
    const key = raw.slice(0, eq);
    const path = raw.slice(eq + 1);
    if (isRtdbInstanceRulesKey(key)) {
      out.rtdb.instances.push({ instance: rtdbInstanceOfRulesKey(key), path });
      continue;
    }
    const service = toVerifiableService(key);
    if (service === 'rtdb') out.rtdb.default = path;
    else if (service === 'storage') out.storage = path;
    else out.firestore = path;
  }
  return out;
}

async function readFirebaseJsonOrNull(cwd: string): Promise<FirebaseJson | null> {
  try {
    return await readFirebaseJson(cwd);
  } catch {
    return null;
  }
}

function toVerifiableService(raw: string): VerifiableService {
  if (raw === 'firestore' || raw === 'rtdb' || raw === 'storage') return raw;
  if (raw === 'database') return 'rtdb';
  throw new Error(`unsupported verify service '${raw}'. Supported services: firestore, rtdb, storage.`);
}

function flagStrings(value: FlagValue | undefined): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function stringFlag(value: FlagValue | undefined): string | undefined {
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? value : undefined;
}

function failingDivergences(divergences: VerifyDivergence[]): VerifyDivergence[] {
  return divergences.filter((divergence) => divergence.kind !== 'expected-drift');
}

function formatDivergence(divergence: VerifyDivergence): string {
  if (divergence.kind === 'now-denied') {
    const method = divergence.method ? `${divergence.method} ` : '';
    return `now-denied: ${method}${divergence.path ?? ''}${divergence.reason ? ` (${divergence.reason})` : ''}`;
  }
  if (divergence.kind === 'now-allowed') {
    const method = divergence.method ? `${divergence.method} ` : '';
    return `now-allowed: ${method}${divergence.path ?? ''}${divergence.reason ? ` (${divergence.reason})` : ''}`;
  }
  if (divergence.kind === 'state-drift') {
    const where = `${divergence.path ?? ''}${divergence.field ? `.${divergence.field}` : ''}`;
    return `state-drift: ${where}: ${JSON.stringify(divergence.before)} -> ${JSON.stringify(divergence.after)}`;
  }
  if (divergence.kind === 'unsupported') {
    return `unsupported: ${divergence.method ?? 'operation'} ${divergence.path ?? ''}: ${divergence.reason}`;
  }
  if (divergence.kind === 'engine-drift') {
    const method = divergence.method ? `${divergence.method} ` : '';
    const other = divergence.staging !== undefined ? `staging=${divergence.staging}` : `rulesTestApi=${divergence.rulesTestApi}`;
    return `engine-drift: ${method}${divergence.path ?? ''}: sandbox=${divergence.sandbox}, ${other}`;
  }
  return `${divergence.drift}: ${divergence.path ?? ''}`;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
