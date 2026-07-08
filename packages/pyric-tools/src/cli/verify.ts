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
import { readFirebaseJson, type FirebaseJson } from './firebase-json.js';
import type { FlagValue, ParsedArgs } from './parse-args.js';
import { resolveScope } from './scope.js';
import { parseRtdbRulesJson } from '../rtdb/rules-json.js';

export type Fixture = PyricVerifyFixture;

export interface FixtureResult {
  name: string;
  description?: string;
  ok: boolean;
  result: VerifyResult;
}

export interface VerifyCliDeps {
  resolveScope?: typeof resolveScope;
}

export const SERVE_CAPTURE_PATH = '.pyric/last-session.json';

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
      for (const divergence of failingDivergences(service.divergences)) {
        lines.push(`    [${service.service}] ${formatDivergence(divergence)}`);
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

  const target = parsed.positional[0];
  const inputPath = resolve(cwd, target ?? SERVE_CAPTURE_PATH);
  if (!existsSync(inputPath)) {
    if (target) {
      process.stderr.write(`pyric verify: no such fixture or directory: ${inputPath}\n`);
    } else {
      process.stderr.write(
        `pyric verify: no captured session at ${SERVE_CAPTURE_PATH}.\n` +
          '  Run `pyric serve`, exercise your app, then `pyric verify`, or pass a fixture path.\n',
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

  let rulesResolution: { rules: VerifyRulesInput; paths: Partial<Record<VerifiableService, string>> };
  try {
    rulesResolution = await resolveCandidateRules(cwd, services, parsed.flags.get('rules'));
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
        })),
    );
  } catch (e) {
    const prefix = e instanceof VerifyInputError ? 'invalid input' : 'failed to replay';
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
        .map(([service, path]) => `${service}=${basename(path)}`)
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
  const inputPath = resolve(cwd, target ?? SERVE_CAPTURE_PATH);
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
  if (union.size === 0) {
    throw new Error('fixture does not contain firestore or rtdb rules services.');
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
    } else {
      throw new Error(`unsupported verify engine '${item}'. Supported engines: sandbox, rules-test-api, both.`);
    }
  }
  return out;
}

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) items.push(item);
}

async function resolveCandidateRules(
  cwd: string,
  services: VerifiableService[],
  rulesFlag: FlagValue | undefined,
): Promise<{ rules: VerifyRulesInput; paths: Partial<Record<VerifiableService, string>> }> {
  const overrides = parseRulesOverrides(rulesFlag);
  const needsDefaults = services.some((service) => !overrides.has(service));
  const firebaseJson = needsDefaults ? await readFirebaseJsonOrNull(cwd) : null;

  const rules: VerifyRulesInput = {};
  const paths: Partial<Record<VerifiableService, string>> = {};
  for (const service of services) {
    const rel = overrides.get(service) ?? defaultRulesPath(firebaseJson, service);
    if (!rel) {
      throw new Error(
        `missing candidate ${service} rules. Pass --rules ${service}=<path> or configure firebase.json.`,
      );
    }
    const path = resolve(cwd, rel);
    if (!existsSync(path)) {
      throw new Error(`rules file not found for ${service}: ${path}`);
    }
    paths[service] = path;
    if (service === 'firestore') {
      rules.firestore = readFileSync(path, 'utf8');
    } else if (service === 'rtdb') {
      rules.rtdb = parseRtdbRulesFile(path);
    }
  }
  return { rules, paths };
}

function parseRulesOverrides(flag: FlagValue | undefined): Map<VerifiableService, string> {
  const out = new Map<VerifiableService, string>();
  for (const raw of flagStrings(flag)) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new Error(`--rules must use service-qualified values like --rules rtdb=database.rules.json.`);
    }
    const service = toVerifiableService(raw.slice(0, eq));
    out.set(service, raw.slice(eq + 1));
  }
  return out;
}

function defaultRulesPath(config: FirebaseJson | null, service: VerifiableService): string | undefined {
  if (service === 'firestore') return config?.firestore?.rules;
  if (service === 'rtdb') return config?.database?.rules;
  return undefined;
}

async function readFirebaseJsonOrNull(cwd: string): Promise<FirebaseJson | null> {
  try {
    return await readFirebaseJson(cwd);
  } catch {
    return null;
  }
}

function parseRtdbRulesFile(path: string): { rules: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`failed to parse RTDB rules JSON at ${path}: ${messageOf(e)}`);
  }
  return parseRtdbRulesJson(
    parsed,
    () => new Error(`RTDB rules file must contain a top-level "rules" object: ${path}`),
  );
}

function toVerifiableService(raw: string): VerifiableService {
  if (raw === 'firestore' || raw === 'rtdb') return raw;
  if (raw === 'database') return 'rtdb';
  throw new Error(`unsupported verify service '${raw}'. Supported services: firestore, rtdb.`);
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
    return `engine-drift: ${method}${divergence.path ?? ''}: sandbox=${divergence.sandbox}, rulesTestApi=${divergence.rulesTestApi}`;
  }
  return `${divergence.drift}: ${divergence.path ?? ''}`;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
