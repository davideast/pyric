/**
 * Which RTDB instances a capture recorded, and replaying one of them.
 *
 * Each instance is its own database with its own rules and data, so each one
 * replays on its own: only its events, into the tree the session left it
 * with, under its candidate rules. The default instance is the top of
 * `services.rtdb`, and its events carry no `instance`. A named instance's
 * events carry its name, and its rules and tree sit under
 * `services.rtdb.instances`.
 */
import { replay as replayRtdb, type RtdbReplayDivergence } from 'pyric/rules/internal/rtdb';
import { resolveDatabaseInstance } from 'pyric/sandbox/internal';

import type { PyricVerifyFixture } from './fixture.js';

/** One instance's replay: the events it checked and what diverged, tagged with a named instance. */
export interface RtdbInstanceReplay {
  checkedEvents: number;
  divergences: Array<RtdbReplayDivergence & { instance?: string }>;
}

type FixtureEvent = PyricVerifyFixture['events'][number];

function rtdbEventInstance(event: FixtureEvent): string | undefined {
  const isRtdb = 'service' in event && event.service === 'rtdb';
  if (!isRtdb) return undefined;
  const instance = (event as { instance?: unknown }).instance;
  return typeof instance === 'string' ? instance : undefined;
}

function isDefaultRtdbEvent(event: FixtureEvent): boolean {
  const isRtdb = 'service' in event && event.service === 'rtdb';
  return isRtdb && rtdbEventInstance(event) === undefined;
}

/** The named instances a capture recorded: the ones its events name and the ones it captured, sorted. */
export function recordedRtdbInstances(fixture: PyricVerifyFixture): string[] {
  const names = new Set<string>(Object.keys(fixture.services.rtdb?.instances ?? {}));
  for (const event of fixture.events) {
    const instance = rtdbEventInstance(event);
    if (instance !== undefined) names.add(instance);
  }
  return [...names].sort();
}

/**
 * Whether a capture recorded the default instance: an event on it, data in
 * it, or no named instance at all, as a capture recorded before instances
 * were captured is the default instance's alone.
 */
export function recordsDefaultRtdbInstance(fixture: PyricVerifyFixture): boolean {
  const holdsData = holdsRtdbData(fixture.services.rtdb?.state.tree);
  const hasEvents = fixture.events.some(isDefaultRtdbEvent);
  return hasEvents || holdsData || recordedRtdbInstances(fixture).length === 0;
}

/** Whether a captured tree holds data: an empty database snapshots as `null` or `{}`. */
function holdsRtdbData(tree: unknown): boolean {
  if (tree === null || tree === undefined) return false;
  const isObject = typeof tree === 'object' && !Array.isArray(tree);
  return !isObject || Object.keys(tree).length > 0;
}

/** The default instance's name, when the capture recorded its URL. */
export function capturedDefaultRtdbInstance(fixture: PyricVerifyFixture): string | undefined {
  const url = fixture.services.rtdb?.databaseUrl;
  if (url === undefined) return undefined;
  try {
    return resolveDatabaseInstance(url)?.name;
  } catch {
    return undefined;
  }
}

/** Replay one instance's events under `rules`; `instance` is a named instance, absent for the default. */
export async function replayRtdbInstance(
  fixture: PyricVerifyFixture,
  rules: { rules: Record<string, unknown> },
  instance?: string,
): Promise<RtdbInstanceReplay> {
  const rtdb = fixture.services.rtdb;
  const capturedState = instance === undefined ? rtdb?.state.tree : rtdb?.instances?.[instance]?.state.tree;
  const replayed = await replayRtdb(fixture.events, {
    rules,
    ...(capturedState === undefined ? {} : { capturedState }),
    ...(instance === undefined ? {} : { instance }),
  });
  const tag = instance === undefined ? {} : { instance };
  return {
    checkedEvents: replayed.checkedEvents,
    divergences: replayed.divergences.map((divergence) => ({ ...divergence, ...tag })),
  };
}
