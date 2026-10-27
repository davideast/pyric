/**
 * Which database instance an {@link RtdbCase} runs on, which rules apply
 * there, and which tree those rules read.
 *
 * Production evaluates a request with the rules deployed to the instance it
 * goes to, and a rule's `root` and `data` read that instance's tree only. A
 * case therefore resolves to one instance, that instance's ruleset, and that
 * instance's tree; data held on other instances is invisible to it.
 */

import type { RtdbRulesDocumentInternal } from '../rtdb/constraints/document.js';
import type { RtdbCase, RtdbInstancesData } from './case-types.js';
import {
  isDefaultDatabaseInstance,
  resolveDatabaseInstance,
  UNNAMED_DEFAULT_DATABASE_INSTANCE,
} from '../../sandbox/internal/instances.js';

/** One instance's ruleset, with the file it was read from, when it was. */
export interface InstanceRules {
  readonly doc: RtdbRulesDocumentInternal;
  /** The rules file as `firebase.json` names it. */
  readonly file?: string;
  /** The text of that file. */
  readonly source?: string;
}

/**
 * Where a ruleset's rules apply: one ruleset on whichever instance a case
 * names, or the rules `firebase.json` deploys to each declared instance.
 */
export type RulesPlacement =
  | { readonly kind: 'every-instance'; readonly rules: InstanceRules }
  | {
      readonly kind: 'per-instance';
      /** The instance `getDatabase()` selects without a URL. */
      readonly defaultInstance: string;
      /** The project id, which also names the default instance (`https://<projectId>.firebaseio.com`). */
      readonly projectId?: string;
      /** Each declared instance's rules, keyed by instance name. */
      readonly instances: ReadonlyMap<string, InstanceRules>;
    };

/** The instance, rules and tree one case evaluates against. */
export interface ResolvedInstanceCase {
  /** Absent when the case named no instance and the rules apply on every instance. */
  instance?: string;
  rules: InstanceRules;
  /** The case with `data` replaced by the instance's tree. */
  evaluated: RtdbCase;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object whose one key is `instances`, holding an object. */
function hasInstancesShape(data: unknown): data is RtdbInstancesData {
  if (!isPlainObject(data)) return false;
  const keys = Object.keys(data);
  return keys.length === 1 && keys[0] === 'instances' && isPlainObject(data.instances);
}

/**
 * The instance a name selects, as `getDatabase(app, url)` selects it: a bare
 * name, lowercased; a database URL; or `default` and the empty string for
 * `defaultKey`, as is a name of the project's default instance. Returns the
 * SDK's error for a name it refuses.
 */
function selectInstance(name: unknown, defaultKey: string, projectId: string | undefined): { name: string } | { problem: string } {
  if (typeof name !== 'string') return { problem: 'instance must be a string naming a database instance, such as "my-app-default-rtdb".' };
  try {
    const selected = resolveDatabaseInstance(name)?.name;
    const isDefault = selected === undefined || isDefaultDatabaseInstance(selected, projectId);
    return { name: isDefault ? defaultKey : selected };
  } catch (error) {
    const reason = error instanceof Error ? error.message.trim() : String(error);
    return { problem: `"${name}" is not a database instance name: ${reason}` };
  }
}

function quoted(names: Iterable<string>): string {
  return [...names].map((name) => `"${name}"`).join(', ');
}

/** What a placement holds for `instance`, or why it holds nothing. */
export function rulesForInstance(
  placement: RulesPlacement,
  instance: string,
  named: boolean,
): InstanceRules | { problem: string } {
  if (placement.kind === 'every-instance') return placement.rules;
  const found = placement.instances.get(instance);
  if (found !== undefined) return found;
  const declared = placement.instances.size === 0
    ? 'it declares no instances'
    : `it holds rules for ${quoted(placement.instances.keys())}`;
  const which = named ? `database instance "${instance}"` : `the default instance "${instance}"`;
  return { problem: `this ruleset has no rules for ${which}; ${declared}.` };
}

/**
 * Resolve a case to the instance it runs on, that instance's rules, and the
 * tree they read. Returns the reason instead, with the instance when it is
 * known, when the case names an instance the ruleset holds no rules for, or
 * its per-instance data is malformed or names an instance the ruleset does
 * not declare.
 */
export function resolveInstanceCase(
  placement: RulesPlacement,
  c: RtdbCase,
): ResolvedInstanceCase | { instance?: string; problem: string } {
  const perInstance = placement.kind === 'per-instance';
  const defaultKey = perInstance ? placement.defaultInstance : UNNAMED_DEFAULT_DATABASE_INSTANCE;
  const projectId = perInstance ? placement.projectId : undefined;
  let instance: string | undefined;
  if (c.instance !== undefined) {
    const selected = selectInstance(c.instance, defaultKey, projectId);
    if ('problem' in selected) return selected;
    instance = selected.name;
  } else if (perInstance) {
    instance = defaultKey;
  }
  const located = <T extends object>(value: T): T & { instance?: string } =>
    instance === undefined ? value : { ...value, instance };

  const rules = rulesForInstance(placement, instance ?? defaultKey, c.instance !== undefined);
  if ('problem' in rules) return located(rules);

  const evaluated: RtdbCase = { ...c };
  const readsPerInstance = instance !== undefined && hasInstancesShape(c.data);
  if (readsPerInstance) {
    const trees = new Map<string, Record<string, unknown>>();
    for (const [key, tree] of Object.entries((c.data as RtdbInstancesData).instances)) {
      const selected = selectInstance(key, defaultKey, projectId);
      if ('problem' in selected) return located({ problem: `data.instances: ${selected.problem}` });
      if (!isPlainObject(tree)) {
        return located({ problem: `data.instances["${key}"] must be an object: the tree of database instance "${selected.name}".` });
      }
      if (trees.has(selected.name)) {
        return located({
          problem: `data.instances names database instance "${selected.name}" more than once (key "${key}" repeats an earlier key); name each instance once, so the verdict does not depend on key order.`,
        });
      }
      trees.set(selected.name, tree);
    }
    if (placement.kind === 'per-instance') {
      const unknown = [...trees.keys()].filter((name) => !placement.instances.has(name));
      if (unknown.length > 0) {
        return located({
          problem: `data.instances names ${quoted(unknown)}, which this ruleset does not declare; it holds rules for ${quoted(placement.instances.keys())}.`,
        });
      }
    }
    const tree = trees.get(instance!);
    if (tree === undefined) delete evaluated.data;
    else evaluated.data = tree;
  }
  return located({ rules, evaluated });
}
