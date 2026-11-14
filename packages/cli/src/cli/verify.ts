import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { resolveScope } from '../credentials/node/scope.js';
import { CAPTURE_RELATIVE_PATH } from '../serve/capture-store.js';
import {
  deriveRulesTestCases,
  fixtureVerifiableServices,
  parseVerifyFixture,
  verifyFixture,
  VerifyInputError,
  type PyricVerifyFixture,
  type VerifiableService,
  type VerifyDivergence,
  type VerifyEngine,
  type VerifyFixtureOptions,
  type VerifyResult,
  type VerifyRulesInput,
  type VerifyServiceResult,
} from '../verify/index.js';
import { StagingSafetyError } from '../verify/staging/engine.js';
import type { FlagValue, ParsedArgs } from './parse-args.js';
import {
  flagStrings,
  resolveCandidateRules,
  stringFlag,
  toVerifiableService,
} from './verify-candidate-rules.js';
import {
  openStagingInstance,
  runVerifyStaging,
  STAGING_RESTORE_RELATIVE_PATH,
  StagingAbortedError,
  stagingRunGuard,
  type VerifyCliDeps,
} from './verify-staging-cli.js';

export { STAGING_RESTORE_RELATIVE_PATH, type VerifyCliDeps };

export type Fixture = PyricVerifyFixture;

export interface FixtureResult {
  name: string;
  description?: string;
  ok: boolean;
  result: VerifyResult;
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
  const out: FixtureResult = {
    name,
    ok: result.ok,
    result,
  };
  if (fixture.description !== undefined) {
    out.description = fixture.description;
  }
  return out;
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
        const unevaluated = service.unevaluatedEvents?.length ?? 0;
        const unevaluatedNote = unevaluated > 0 ? `, ${unevaluated} unevaluated` : '';
        if (service.ok) {
          return `${service.service}: ok (${info} informational${unevaluatedNote})`;
        }
        return `${service.service}: ${failures} failure(s)${unevaluatedNote}`;
      })
      .join(', ');
    lines.push(`${marker} ${result.name}${desc} - ${serviceSummary}`);
    for (const service of Object.values(result.result.services)) {
      if (!service) continue;
      const engines = Object.values(service.engines ?? {}).filter((engine) => engine !== undefined);
      // With more than one engine, each line names the engine that reported it.
      let groups = [{ label: '', divergences: service.divergences }];
      if (engines.length > 1) {
        groups = engines.map((engine) => ({
          label: ` ${engine.engine}`,
          divergences: engine.divergences,
        }));
      }
      for (const group of groups) {
        for (const divergence of failingDivergences(group.divergences)) {
          const resource = divergence.instance ?? divergence.bucket;
          const instance = resource === undefined ? '' : ` ${resource}`;
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

  if (parsed.flags.get('static') === true || parsed.flags.get('static') === 'true') {
    const { runVerifyStatic } = await import('./verify-static.js');
    return runVerifyStatic(parsed, { cwd });
  }

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
    if (statSync(inputPath).isDirectory()) {
      loaded = loadFixturesFromDirectory(inputPath);
    } else {
      loaded = [{ name: basename(inputPath, '.json'), fixture: loadFixture(inputPath) }];
    }
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
  let stopStaging: (() => void) | undefined;
  if (engines.includes('staging')) {
    try {
      const opened = await openStagingInstance(cwd, stringFlag(parsed.flags.get('project')), deps);
      process.stderr.write(
        `pyric verify: staging instance ${opened.target.databaseUrl} (project ${opened.projectId}, credentials: ${opened.source})\n`,
      );
      const guard = stagingRunGuard(cwd, opened.target);
      stopStaging = guard.stop;
      staging = { client: opened.client, projectId: opened.projectId, ...guard.hooks };
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
      const resolver = deps.resolveScope ?? resolveScope;
      const resolved = await resolver({
        projectId: stringFlag(parsed.flags.get('project')),
      });
      rulesTestApi = { scope: resolved.scope };
    } catch (e) {
      process.stderr.write(`pyric verify: ${messageOf(e)}\n`);
      return 2;
    }
  }

  let results: FixtureResult[];
  const options: Omit<VerifyFixtureOptions, 'rules'> = {
    services,
    engines,
  };
  if (rulesTestApi) {
    options.rulesTestApi = rulesTestApi;
  }
  if (staging) {
    options.staging = staging;
  }
  try {
    // The staging engine holds one instance, so its fixtures run one at a time.
    if (staging) {
      results = await pipelineFixtures(loaded, (item) =>
        runFixture(item.name, item.fixture, rulesResolution.rules, options),
      );
    } else {
      results = await Promise.all(
        loaded.map((item) => runFixture(item.name, item.fixture, rulesResolution.rules, options)),
      );
    }
  } catch (e) {
    let prefix = 'failed to replay';
    if (e instanceof VerifyInputError) {
      prefix = 'invalid input';
    } else if (e instanceof StagingSafetyError) {
      prefix = 'staging instance';
    }
    process.stderr.write(`pyric verify: ${prefix}: ${messageOf(e)}\n`);
    stopStaging?.();
    if (e instanceof StagingAbortedError || (e as { name?: string }).name === 'AbortError') {
      return 130;
    }
    return 2;
  } finally {
    stopStaging?.();
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
      process.stderr.write(`\n✗ ${failed} session(s) regressed under ${rules}.\n`);
    } else {
      process.stdout.write('\n✓ all selected services replay cleanly.\n');
    }
  }
  if (allOk) return 0;
  return 1;
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
    process.stderr.write(
      'pyric verify cases: only --service firestore is supported for Rules Test API case derivation.\n',
    );
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
  if (result.ok) return 0;
  return 1;
}

async function pipelineFixtures<T>(
  items: T[],
  run: (item: T) => Promise<FixtureResult>,
): Promise<FixtureResult[]> {
  const out: FixtureResult[] = [];
  for (const item of items) out.push(await run(item));
  return out;
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
      throw new Error(
        `unsupported verify engine '${item}'. Supported engines: sandbox, rules-test-api, staging, both.`,
      );
    }
  }
  return out;
}

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) items.push(item);
}

function failingDivergences(divergences: VerifyDivergence[]): VerifyDivergence[] {
  return divergences.filter((divergence) => divergence.kind !== 'expected-drift');
}

function formatDivergence(divergence: VerifyDivergence): string {
  if (divergence.kind === 'now-denied') {
    const method = divergence.method ? `${divergence.method} ` : '';
    const reason = divergence.reason ? ` (${divergence.reason})` : '';
    return `now-denied: ${method}${divergence.path ?? ''}${reason}`;
  }
  if (divergence.kind === 'now-allowed') {
    const method = divergence.method ? `${divergence.method} ` : '';
    const reason = divergence.reason ? ` (${divergence.reason})` : '';
    return `now-allowed: ${method}${divergence.path ?? ''}${reason}`;
  }
  if (divergence.kind === 'state-drift') {
    const field = divergence.field ? `.${divergence.field}` : '';
    const where = `${divergence.path ?? ''}${field}`;
    return `state-drift: ${where}: ${JSON.stringify(divergence.before)} -> ${JSON.stringify(divergence.after)}`;
  }
  if (divergence.kind === 'unsupported') {
    return `unsupported: ${divergence.method ?? 'operation'} ${divergence.path ?? ''}: ${divergence.reason}`;
  }
  if (divergence.kind === 'engine-drift') {
    const method = divergence.method ? `${divergence.method} ` : '';
    let other = `rulesTestApi=${divergence.rulesTestApi}`;
    if (divergence.staging !== undefined) {
      other = `staging=${divergence.staging}`;
    }
    return `engine-drift: ${method}${divergence.path ?? ''}: sandbox=${divergence.sandbox}, ${other}`;
  }
  return `${divergence.drift}: ${divergence.path ?? ''}`;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
