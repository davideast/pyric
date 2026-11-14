/**
 * `pyric verify`: the candidate RTDB rules for each instance a session used.
 *
 * Each instance a capture recorded is checked against its own rules. Rules
 * come from `--rules rtdb=<path>` (the default instance) and
 * `--rules rtdb:<instance>=<path>`, else from `firebase.json`, resolved as
 * `pyric sandbox` and `firebase deploy` resolve them: an array entry's
 * `instance`, a `target` that `.firebaserc` maps for the project, and
 * `database.rules.json` when there is no `database` key. The project's
 * default instance name selects the default instance.
 *
 * A recorded instance without rules is an error that names it, and so is an
 * override for an instance the session never used. Declared instances the
 * session did not use are ignored.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import {
  UNNAMED_DEFAULT_DATABASE_INSTANCE,
  defaultDatabaseInstanceName,
  isDefaultDatabaseInstance,
  resolveDatabaseInstance,
} from 'pyric/sandbox/internal';

import {
  capturedDefaultRtdbInstance,
  recordedRtdbInstances,
  recordsDefaultRtdbInstance,
  type PyricVerifyFixture,
  type VerifyRulesInput,
} from '../verify/index.js';
import { parseRtdbRulesText } from '../rtdb/rules-json.js';
import { databaseRulesTargets, type DatabaseRulesTargets } from '../serve/rules.js';
import { resolveContainedRulesFile } from './contained-rules-file.js';
import type { FirebaseJson } from './firebase-json.js';
import { resolveFirebaseProject, type FirebaseProjectResolution } from './firebase-project.js';

/** The `--rules` values for RTDB: `rtdb=<path>` and each `rtdb:<instance>=<path>`, as typed. */
export interface RtdbRulesOverrides {
  default?: string;
  instances: Array<{ instance: string; path: string }>;
}

export interface RtdbCandidateRulesInput {
  cwd: string;
  fixtures: readonly PyricVerifyFixture[];
  overrides: RtdbRulesOverrides;
  /** `firebase.json`, or null when it is missing or unreadable. */
  readFirebaseJson: () => Promise<FirebaseJson | null>;
  /** `--project`. */
  project?: string;
}

export interface RtdbCandidateRules {
  rules: Pick<VerifyRulesInput, 'rtdb' | 'rtdbInstances'>;
  /** Each rules file read: `rtdb` for the default instance, `rtdb:<instance>` for a named one. */
  paths: Record<string, string>;
}

/** An instance key: `undefined` is the default instance. */
type InstanceKey = string | undefined;

/** The prefix of an instance-qualified `--rules` value. */
const INSTANCE_PREFIX = /^(?:rtdb|database):/;

/** Whether a `--rules` service key names one RTDB instance (`rtdb:<instance>`). */
export function isRtdbInstanceRulesKey(key: string): boolean {
  return INSTANCE_PREFIX.test(key);
}

/** The instance a `rtdb:<instance>` key names, as typed. */
export function rtdbInstanceOfRulesKey(key: string): string {
  return key.replace(INSTANCE_PREFIX, '');
}

function pathKey(instance: InstanceKey): string {
  return instance === undefined ? 'rtdb' : `rtdb:${instance}`;
}

function describeInstance(instance: InstanceKey): string {
  return instance === undefined ? 'the default instance' : `instance "${instance}"`;
}

function parseRulesFile(
  realPath: string,
  displayPath: string,
  instance: InstanceKey,
): { rules: Record<string, unknown> } {
  const label = `RTDB rules file ${displayPath} for ${describeInstance(instance)}`;
  const rules = parseRtdbRulesText(
    readFileSync(realPath, 'utf8'),
    (reason) => new Error(`${label} did not parse: ${reason.message}`),
  );
  const rejection = rtdbRulesSourceRejection(rules);
  if (rejection !== null) throw new Error(`${label} would not deploy. ${rejection.message}`);
  return rules;
}

/** The names that mean the default instance: the project's, the capture's, and the config's unnamed default. `<projectId>` is matched by `isDefaultDatabaseInstance`. */
function defaultNames(input: RtdbCandidateRulesInput, projectId: string | undefined): Set<string> {
  const names = new Set<string>([UNNAMED_DEFAULT_DATABASE_INSTANCE]);
  if (projectId !== undefined) names.add(defaultDatabaseInstanceName(projectId));
  for (const fixture of input.fixtures) {
    const captured = capturedDefaultRtdbInstance(fixture);
    if (captured !== undefined) names.add(captured);
  }
  return names;
}

function databaseTargets(input: RtdbCandidateRulesInput, config: FirebaseJson | null, project: FirebaseProjectResolution): DatabaseRulesTargets {
  try {
    return databaseRulesTargets(input.cwd, config, project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^pyric sandbox: /, ''));
  }
}

/** Resolve each recorded instance's candidate rules; throws a message naming the instance it cannot resolve. */
export async function resolveRtdbCandidateRules(input: RtdbCandidateRulesInput): Promise<RtdbCandidateRules> {
  const named = [...new Set(input.fixtures.flatMap(recordedRtdbInstances))].sort();
  const needed: InstanceKey[] = [];
  if (input.fixtures.some(recordsDefaultRtdbInstance)) {
    needed.push(undefined);
  }
  needed.push(...named);
  const projectOpts: { projectDir: string; option?: string } = {
    projectDir: input.cwd,
  };
  if (input.project) {
    projectOpts.option = input.project;
  }
  const project = resolveFirebaseProject(projectOpts);
  const defaults = defaultNames(input, project.projectId);
  const keyOf = (name: string): InstanceKey => {
    // The config's unnamed default is matched before it is parsed as a name.
    if (defaults.has(name)) return undefined;
    const instance = resolveDatabaseInstance(name)?.name;
    const isDefault = instance === undefined || defaults.has(instance) || isDefaultDatabaseInstance(instance, project.projectId);
    return isDefault ? undefined : instance;
  };
  let config: FirebaseJson | null | undefined;
  const readConfig = async (): Promise<FirebaseJson | null> => (config === undefined ? (config = await input.readFirebaseJson()) : config);

  const chosen = new Map<InstanceKey, string>();
  const configuredKeys = new Set<InstanceKey>();
  if (input.overrides.default !== undefined) {
    if (!needed.includes(undefined)) {
      throw new Error(
        `--rules rtdb=${input.overrides.default}: the session never used the default instance. Instances the session used: ${recordedList(needed)}.`,
      );
    }
    chosen.set(undefined, input.overrides.default);
  }
  for (const override of input.overrides.instances) {
    const key = overrideKey(override.instance, keyOf);
    const isRecorded = needed.includes(key);
    if (!isRecorded) throw new Error(unrecordedOverride(override.instance, key, needed, await readConfig()));
    const existing = chosen.get(key);
    if (existing !== undefined) {
      const checkedExisting = requireContainedRtdbRules(input.cwd, existing, key, false);
      const checkedNext = requireContainedRtdbRules(input.cwd, override.path, key, false);
      if (checkedExisting.realFile !== checkedNext.realFile) {
        throw new Error(`--rules names two rules files for ${describeInstance(key)}: ${existing} and ${override.path}.`);
      }
    }
    chosen.set(key, override.path);
  }

  let targets: DatabaseRulesTargets | undefined;
  const unresolved = needed.filter((key) => !chosen.has(key));
  if (unresolved.length > 0) {
    targets = databaseTargets(input, await readConfig(), project);
    for (const target of targets.targets) {
      const key = keyOf(target.instance);
      const isWanted = unresolved.includes(key) && !chosen.has(key);
      if (!isWanted) continue;
      if (target.configured) {
        chosen.set(key, target.path);
        configuredKeys.add(key);
        continue;
      }
      if (existsSync(target.path)) {
        chosen.set(key, target.path);
      }
    }
  }

  const rules: RtdbCandidateRules['rules'] = {};
  const paths: Record<string, string> = {};
  for (const key of needed) {
    const rel = chosen.get(key);
    if (rel === undefined) throw new Error(missingCandidate(key, targets));
    const checked = requireContainedRtdbRules(
      input.cwd,
      rel,
      key,
      configuredKeys.has(key),
    );
    const parsed = parseRulesFile(checked.realFile, checked.resolvedPath, key);
    paths[pathKey(key)] = checked.resolvedPath;
    if (key === undefined) rules.rtdb = parsed;
    else (rules.rtdbInstances ??= {})[key] = parsed;
  }
  return { rules, paths };
}

function requireContainedRtdbRules(
  cwd: string,
  rel: string,
  instance: InstanceKey,
  fromConfiguredTarget: boolean,
): { realFile: string; resolvedPath: string } {
  const checked = resolveContainedRulesFile({
    projectRoot: cwd,
    lexicalProjectRoot: cwd,
    cwd,
    fileArg: rel,
  });
  if (!checked.ok) {
    if (checked.kind === 'not-found') {
      const abs = resolve(cwd, rel);
      if (fromConfiguredTarget) {
        throw new Error(
          `rules file not found for rtdb ${describeInstance(instance)}: ${abs}, and firebase.json deploys it.`,
        );
      }
      throw new Error(`rules file not found for rtdb ${describeInstance(instance)}: ${abs}`);
    }
    throw new Error(`invalid rtdb rules path for ${describeInstance(instance)}: ${checked.message}`);
  }
  return { realFile: checked.realFile, resolvedPath: checked.resolvedPath };
}

function overrideKey(raw: string, keyOf: (name: string) => InstanceKey): InstanceKey {
  try {
    return keyOf(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message.trim() : String(error);
    throw new Error(`--rules rtdb:${raw}: "${raw}" is not a database instance name or URL. ${reason}`);
  }
}

function recordedList(needed: readonly InstanceKey[]): string {
  if (needed.length === 0) return 'none';
  return needed.map((key) => key ?? 'the default instance').join(', ');
}

function unrecordedOverride(
  raw: string,
  key: InstanceKey,
  needed: readonly InstanceKey[],
  config: FirebaseJson | null,
): string {
  const lines = [`--rules rtdb:${raw}: the session never used ${describeInstance(key)}. Instances the session used: ${recordedList(needed)}.`];
  const entries = Array.isArray(config?.database) ? config.database : [];
  const isTarget = entries.some((entry) => entry.target === raw);
  if (isTarget) lines.push(`"${raw}" is a deploy target in firebase.json; name the instance it deploys to.`);
  return lines.join(' ');
}

function missingCandidate(key: InstanceKey, targets: DatabaseRulesTargets | undefined): string {
  if (key === undefined) {
    return 'missing candidate rtdb rules for the default instance. Pass --rules rtdb=<path> or configure firebase.json.';
  }
  const lines = [`missing candidate rtdb rules for instance "${key}", which the session used.`];
  for (const target of targets?.pending ?? []) {
    lines.push(`firebase.json deploy target "${target.target}" (${target.label}) did not resolve: ${target.reason}.`);
  }
  lines.push(`Pass --rules rtdb:${key}=<path>, or deploy rules to it in firebase.json.`);
  return lines.join(' ');
}
