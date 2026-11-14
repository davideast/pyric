/**
 * `pyric verify staging` (`init` and `restore`) and staging run-guard
 * helpers for `verify.ts`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { resolveScope } from '../credentials/node/scope.js';
import type { VerifyFixtureOptions } from '../verify/index.js';
import {
  markedProject,
  restoreStagingInstance,
  stagingMarker,
} from '../verify/staging/engine.js';
import { RtdbRestClient } from '../verify/staging/rest.js';
import {
  assertNotAppInstance,
  stagingTargetFrom,
  stagingToken,
  type StagingTarget,
} from '../verify/staging/target.js';
import { readFirebaseJson, readFirebaseRcSync, type FirebaseJson } from './firebase-json.js';
import { resolveFirebaseProject } from './firebase-project.js';
import {
  findMissingValueFlag,
  findUnknownFlag,
  formatCliFlagName,
  type FlagValue,
  type ParsedArgs,
} from './parse-args.js';
import { readPyricConfig } from './pyric-config.js';

export interface VerifyCliDeps {
  resolveScope?: typeof resolveScope;
  /** The staging instance's REST client; tests pass one backed by a local sandbox. */
  stagingClient?: (target: StagingTarget, token: () => Promise<string>) => RtdbRestClient;
}

export class StagingAbortedError extends Error {}

/** Where a staging run keeps the prior rules while it runs, for `pyric verify staging restore`. */
export const STAGING_RESTORE_RELATIVE_PATH = join('.pyric', 'staging-restore.json');

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function stringFlag(value: FlagValue | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') return value;
  return undefined;
}

async function readFirebaseJsonOrNull(cwd: string): Promise<FirebaseJson | null> {
  try {
    return await readFirebaseJson(cwd);
  } catch {
    return null;
  }
}

/** Every instance a `.firebaserc` database target maps for the app's project. */
function databaseTargetInstances(cwd: string, projectId: string | undefined): string[] {
  if (!projectId) return [];
  try {
    const rc = readFirebaseRcSync(cwd) as {
      targets?: Record<string, { database?: Record<string, string[]> }>;
    } | null;
    return Object.values(rc?.targets?.[projectId]?.database ?? {}).flat();
  } catch {
    return [];
  }
}

/** The staging instance from `pyric.json`, refused when the app uses it, with credentials for its project. */
export async function openStagingInstance(
  cwd: string,
  appProjectOption: string | undefined,
  deps: VerifyCliDeps,
): Promise<{ client: RtdbRestClient; projectId: string; target: StagingTarget; source: string }> {
  const target = stagingTargetFrom(await readPyricConfig(cwd));
  const firebaseJson = await readFirebaseJsonOrNull(cwd);
  const projectInput: { projectDir: string; option?: string } = { projectDir: cwd };
  if (appProjectOption) {
    projectInput.option = appProjectOption;
  }
  const appProject = resolveFirebaseProject(projectInput);
  const checkInput: {
    firebaseJson: FirebaseJson | null;
    appProjectId?: string;
    targetInstances: string[];
  } = {
    firebaseJson,
    targetInstances: databaseTargetInstances(cwd, appProject.projectId),
  };
  if (appProject.projectId) {
    checkInput.appProjectId = appProject.projectId;
  }
  assertNotAppInstance(target, checkInput);
  const tokenOpts: { resolve?: typeof resolveScope } = {};
  if (deps.resolveScope) {
    tokenOpts.resolve = deps.resolveScope;
  }
  const credentials = await stagingToken(target.projectId, tokenOpts);
  const client =
    deps.stagingClient?.(target, credentials.token)
    ?? new RtdbRestClient(target.databaseUrl, credentials.token);
  return {
    client,
    projectId: target.projectId,
    target,
    source: credentials.source,
  };
}

/**
 * While a staging run is active: keep the prior rules on disk, and turn
 * SIGINT/SIGTERM into an abort between steps so the run still cleans up. A
 * second signal exits at once, naming the recovery command.
 */
export function stagingRunGuard(
  cwd: string,
  target: StagingTarget,
): {
  hooks: Pick<NonNullable<VerifyFixtureOptions['staging']>, 'onBeforeChange' | 'onRestored' | 'signal'>;
  stop: () => void;
} {
  const controller = new AbortController();
  const restorePath = join(cwd, STAGING_RESTORE_RELATIVE_PATH);
  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals === 1) {
      process.stderr.write(
        `\npyric verify: ${signal}: stopping after the current step and restoring ${target.databaseUrl}. Press again to quit without restoring.\n`,
      );
      controller.abort(new StagingAbortedError(`interrupted by ${signal}`));
      return;
    }
    process.stderr.write(
      `pyric verify: quitting without restoring ${target.databaseUrl}. Run \`pyric verify staging restore\` to put it back.\n`,
    );
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let stopped = false;
  return {
    hooks: {
      signal: controller.signal,
      onBeforeChange: (priorRules) => {
        mkdirSync(dirname(restorePath), { recursive: true });
        writeFileSync(
          restorePath,
          `${JSON.stringify(
            {
              databaseUrl: target.databaseUrl,
              projectId: target.projectId,
              rules: priorRules,
              startedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
        );
      },
      onRestored: () => rmSync(restorePath, { force: true }),
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

/**
 * `pyric verify staging restore`: put the configured instance back after a run
 * that could not, from the prior rules the run kept in
 * `.pyric/staging-restore.json`; with `--force` and no such file, enroll it
 * afresh with deny-all rules. Its data is deleted either way.
 */
const ALLOWED_STAGING_INIT_FLAGS: ReadonlySet<string> = new Set(['project']);
const ALLOWED_STAGING_RESTORE_FLAGS: ReadonlySet<string> = new Set([
  'project',
  'force',
]);

async function runVerifyStagingRestore(
  parsed: ParsedArgs,
  cwd: string,
  deps: VerifyCliDeps,
): Promise<number> {
  const unknownFlag = findUnknownFlag(
    parsed.flags,
    ALLOWED_STAGING_RESTORE_FLAGS,
  );
  if (unknownFlag !== undefined) {
    process.stderr.write(
      `pyric verify staging restore: unknown option '${formatCliFlagName(unknownFlag)}'\n`,
    );
    return 2;
  }
  const missingFlag = findMissingValueFlag(parsed.flags, ['project']);
  if (missingFlag !== undefined) {
    process.stderr.write(
      `pyric verify staging restore: missing value for --${missingFlag}\n`,
    );
    return 2;
  }
  let opened: Awaited<ReturnType<typeof openStagingInstance>>;
  try {
    opened = await openStagingInstance(cwd, stringFlag(parsed.flags.get('project')), deps);
  } catch (e) {
    process.stderr.write(`pyric verify staging restore: ${messageOf(e)}\n`);
    return 2;
  }
  const { client, target } = opened;
  const restorePath = join(cwd, STAGING_RESTORE_RELATIVE_PATH);
  let rules: string | undefined;
  if (existsSync(restorePath)) {
    const kept = JSON.parse(readFileSync(restorePath, 'utf8')) as {
      databaseUrl?: string;
      rules?: string;
    };
    if (kept.databaseUrl !== target.databaseUrl) {
      process.stderr.write(
        `pyric verify staging restore: ${STAGING_RESTORE_RELATIVE_PATH} is for ${kept.databaseUrl}, not ${target.databaseUrl}.\n`,
      );
      return 2;
    }
    rules = kept.rules;
  } else if (parsed.flags.get('force') === true) {
    rules = `${stagingMarker(target.projectId)}\n{\n  "rules": {\n    ".read": false,\n    ".write": false\n  }\n}`;
  } else {
    const current = await client.getRulesText().catch(() => '');
    if (
      markedProject(current) === target.projectId &&
      (await client.get('/', { shallow: true })).body === null
    ) {
      process.stdout.write(
        `✓ ${target.databaseUrl} is enrolled and empty; nothing to restore.\n`,
      );
      return 0;
    }
    process.stderr.write(
      `pyric verify staging restore: no ${STAGING_RESTORE_RELATIVE_PATH} holds the rules ${target.databaseUrl} had. ` +
        'Pass --force to deploy deny-all rules with the enrollment marker and delete its data.\n',
    );
    return 2;
  }
  if (typeof rules !== 'string' || markedProject(rules) !== target.projectId) {
    process.stderr.write(
      `pyric verify staging restore: the kept rules do not carry the enrollment marker for ${target.projectId}; refusing to deploy them.\n`,
    );
    return 2;
  }
  const result = await restoreStagingInstance(client, rules);
  if (!result.rulesRestored || !result.dataRemoved) {
    process.stderr.write(
      `pyric verify staging restore: ${target.databaseUrl} is not restored (${result.errors.join('; ')}).\n`,
    );
    return 1;
  }
  rmSync(restorePath, { force: true });
  process.stdout.write(
    `✓ restored ${target.databaseUrl}: enrolled rules deployed, data deleted.\n`,
  );
  return 0;
}

/** `pyric verify staging init`: enroll the configured instance, once. */
export async function runVerifyStaging(
  parsed: ParsedArgs,
  cwd: string,
  deps: VerifyCliDeps,
): Promise<number> {
  if (parsed.positional[1] === 'restore') {
    return runVerifyStagingRestore(parsed, cwd, deps);
  }
  if (parsed.positional[1] !== 'init') {
    process.stderr.write(
      'pyric verify staging: use `init` to enroll the instance pyric.json names, or `restore` to put it back after an interrupted run.\n',
    );
    return 2;
  }
  const unknownFlag = findUnknownFlag(parsed.flags, ALLOWED_STAGING_INIT_FLAGS);
  if (unknownFlag !== undefined) {
    process.stderr.write(
      `pyric verify staging init: unknown option '${formatCliFlagName(unknownFlag)}'\n`,
    );
    return 2;
  }
  const missingFlag = findMissingValueFlag(parsed.flags, ['project']);
  if (missingFlag !== undefined) {
    process.stderr.write(
      `pyric verify staging init: missing value for --${missingFlag}\n`,
    );
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
      process.stdout.write(
        `✓ ${target.databaseUrl} is already enrolled for project ${target.projectId}.\n`,
      );
      return 0;
    }
    if (marked !== undefined) {
      process.stderr.write(
        `pyric verify staging init: ${target.databaseUrl} is enrolled for project ${marked}, not ${target.projectId}.\n`,
      );
      return 2;
    }
    const root = await client.get('/', { shallow: true });
    if (root.status !== 200 || root.body !== null) {
      process.stderr.write(
        `pyric verify staging init: refusing to enroll ${target.databaseUrl}: it holds data (or could not be read, HTTP ${root.status}). ` +
          "The staging engine replaces an instance's rules and data, so enroll an empty instance created for it.\n",
      );
      return 2;
    }
    const enrolled = `${stagingMarker(target.projectId)}\n${rules.trimStart()}`;
    const dry = await client.putRules(enrolled, { dryRun: true });
    if (dry.status !== 200) {
      throw new Error(
        `production refused the marked rules: HTTP ${dry.status} ${dry.text.slice(0, 200)}`,
      );
    }
    const put = await client.putRules(enrolled);
    if (put.status !== 200) {
      throw new Error(
        `deploying the marked rules failed: HTTP ${put.status} ${put.text.slice(0, 200)}`,
      );
    }
    if (markedProject(await client.getRulesText()) !== target.projectId) {
      throw new Error('the marker did not read back.');
    }
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
