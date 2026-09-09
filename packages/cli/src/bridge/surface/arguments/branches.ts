/**
 * The branch methods' shared argument vocabulary and the reads they make of
 * the project directory.
 *
 * Six method records name a branch, four of them have to say the same thing
 * when the project holds no branch by that name, and two of them read a file
 * the caller named. Those are the pieces that would otherwise be written six
 * times and drift, so they live here and the records carry only what is their
 * own.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SandboxEvent, SandboxSnapshot } from 'pyric/sandbox';
import {
  deserializeFromBuckets,
  parseBundle,
} from 'pyric/sandbox';
import { z } from 'zod';

import type { Args, Fail, InvalidArguments } from '../method-types.js';

/** Where a step that creates checkpoints writes them, relative to the project. */
export const CHECKPOINT_STORE_RELATIVE = join('.pyric', 'state', 'checkpoints');

/** The value of `against` that names the live sandbox rather than a checkpoint. */
export const AGAINST_LIVE = 'live';

/** The recorded session a `sandbox.apply` call reads when it names no other. */
export const DEFAULT_SESSION_PATH = '.pyric/last-session.json';

/**
 * The branch a method names. It is a directory name under the branch store, so
 * the shape is checked by the validator and a name that could reach outside
 * that directory never gets as far as a handler.
 */
export const branchName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'a branch name is 1 to 64 characters of lowercase letters, digits, dot, dash, or underscore, starting with a letter or digit',
  )
  .describe(
    'The branch name, which is its directory under .pyric/state/branches. Lowercase letters, digits, dot, dash, and underscore.',
  );

/** Whether the project already holds a branch under this name. */
export function branchExists(projectDir: string, name: string): boolean {
  return storedBranchNames(projectDir).includes(name);
}

/** The one refusal every method that names a missing branch returns. */
export function refuseUnknownBranch(
  projectDir: string,
  name: string,
  fail: Fail,
): InvalidArguments {
  const known = storedBranchNames(projectDir);
  if (known.length === 0) {
    return fail(
      `the project holds no branch named '${name}', and no branches at all.`,
      'Call fork to create one.',
      'branch',
    );
  }
  return fail(
    `the project holds no branch named '${name}'. It holds ${known.join(', ')}.`,
    `Pass 'branch' as a branch the project holds, or call fork to create '${name}'.`,
    'branch',
  );
}

/** Every branch directory name the project holds, from the listing itself. */
function storedBranchNames(projectDir: string): string[] {
  const root = join(projectDir, '.pyric', 'state', 'branches');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every checkpoint name the project holds, from the directory a checkpoint method writes. */
export function storedCheckpointNames(projectDir: string): string[] {
  const root = join(projectDir, CHECKPOINT_STORE_RELATIVE);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

/**
 * The snapshot one checkpoint file carries.
 *
 * The file is written by the checkpoint methods, and it is one of two shapes:
 * the v3 record bundle the headless state file uses, or a plain snapshot
 * object with a `firestore` map. Both are read here, and anything else is a
 * file this method cannot compare against rather than a file it guesses at.
 */
export function readCheckpointSnapshot(path: string): SandboxSnapshot | null {
  const raw = readFileSync(path, 'utf8');
  const records = parseBundle(raw);
  if (records.size > 0) {
    const { firestore, services } = deserializeFromBuckets(records);
    return { firestore, services };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const shaped = parsed as { firestore?: unknown; services?: unknown };
  if (typeof shaped.firestore !== 'object' || shaped.firestore === null) return null;
  const services = typeof shaped.services === 'object' && shaped.services !== null
    ? (shaped.services as Record<string, unknown>)
    : {};
  return { firestore: shaped.firestore as SandboxSnapshot['firestore'], services };
}

/** A path inside the project directory, or a refusal naming why it is not one. */
export function resolveProjectPath(
  projectDir: string,
  candidate: string,
  field: string,
  fail: Fail,
): { path: string } | InvalidArguments {
  if (isAbsolute(candidate)) {
    return fail(
      `'${field}' is an absolute path. It names a file relative to the project directory.`,
      `Pass '${field}' as a path relative to the project directory, such as '${DEFAULT_SESSION_PATH}'.`,
      field,
    );
  }
  const resolved = resolve(projectDir, candidate);
  const inside = relative(projectDir, resolved);
  if (inside.startsWith('..')) {
    return fail(
      `'${field}' leaves the project directory.`,
      `Pass '${field}' as a path inside the project directory, such as '${DEFAULT_SESSION_PATH}'.`,
      field,
    );
  }
  return { path: resolved };
}

/**
 * The events a recorded session file carries. A session file is the fixture
 * the capture writes: an object with an `events` array. A bare array is
 * accepted too, because that is what a caller who saved only the event log
 * has in hand.
 */
export function readSessionEvents(path: string): SandboxEvent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed as SandboxEvent[];
  if (parsed === null || typeof parsed !== 'object') return null;
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  return events as SandboxEvent[];
}

/**
 * Refuse an `apply` call that names neither an event list nor a session file,
 * or both. There is no default: applying the last recorded session because a
 * call said nothing would change a branch the caller did not ask to change.
 */
export function refuseAmbiguousSource(args: Args, fail: Fail): InvalidArguments | null {
  const hasEvents = args.events !== undefined;
  const hasSession = args.sessionPath !== undefined;
  if (hasEvents && !hasSession) return null;
  if (hasSession && !hasEvents) return null;
  if (hasEvents && hasSession) {
    return fail(
      "'events' and 'sessionPath' name two different sources for the same call.",
      "Pass 'events' with the events to apply, or 'sessionPath' with the recorded session to read, not both.",
      'events',
    );
  }
  return fail(
    'apply names the events it applies, and this call named none.',
    `Pass 'events' with the events to apply, or 'sessionPath' with a recorded session such as '${DEFAULT_SESSION_PATH}'.`,
    'events',
  );
}
