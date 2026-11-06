/**
 * What the served copy shows after each check: the newest servable commit,
 * one that passed `SERVE_GATES` (`gates.ts`), labelled with the gates it
 * fails, so there is always something to review.
 *
 * - A commit that passed every gate is also recorded in `last-good.json`.
 * - A servable commit that is new restarts the served copy; the one already
 *   served starts it when nothing serves, and otherwise leaves it up with
 *   its label updated in `last-served.json`.
 * - A commit that isn't servable leaves the copy as it is.
 *
 * `last-served.json` is written once the copy is ready, so the commit served
 * before it stays the one its changes are counted from.
 */
import type { AppPaths } from './app-paths.ts';
import type { AppRecord } from './app-setup.ts';
import { meetsServeMinimum, SERVE_GATES, type GateName } from './gates.ts';
import { serveAction, writeLastGood, type ServeAction } from './last-good.ts';
import { nextLastServed, readLastServed, writeLastServed, type LastServed } from './last-served.ts';
import type { SandboxOpener } from './sandbox.ts';
import { serveHost } from './serve-host.ts';
import { servedControl, servedPort, servedUrls, type ServedControl, type ServedUrls } from './served.ts';

/** The commit the served copy shows and the gates it fails; `failing` is absent when no record names that commit. */
export interface ServedLabel {
  commit: string;
  failing?: GateName[];
}

/** What the served copy shows and where, while it is up and ready. */
export type ServedNow = ServedLabel & ServedUrls;

export interface ServeOutcome {
  action: ServeAction;
  /** What happened, for the check's result. */
  note: string;
  served?: ServedNow;
}

export interface ServeInput {
  paths: AppPaths;
  record: AppRecord;
  /** The gates this hour's commit failed. */
  failed: readonly GateName[];
  commit: string;
  hour: number;
  /** The served copy's provider socket, when the run has one. */
  providerSocket?: string;
  signal?: AbortSignal;
  openSandbox?: SandboxOpener;
  say: (line: string) => void;
  /** The served process; tests pass a fake. */
  control?: ServedControl;
}

const short = (commit: string) => commit.slice(0, 12);

function labelOf(commit: string, record: LastServed | undefined): ServedLabel {
  const isRecorded = record !== undefined && record.commit === commit;
  if (!isRecorded) return { commit };
  return { commit, failing: [...record.failing] };
}

function leaveNote(servable: boolean, failed: readonly GateName[], serving: string | undefined): string {
  if (servable) return 'the served copy already shows this commit; its label is updated';
  const missed = SERVE_GATES.filter((gate) => failed.includes(gate)).join(', ');
  const stays = serving === undefined ? 'nothing is served' : `the served copy stays on ${short(serving)}`;
  return `this commit failed ${missed}, so ${stays}`;
}

/** `serving acf8f7a25106, failing: tests, walks`: the label as the check's summary gives it. */
export function labelText(label: ServedLabel): string {
  const serving = `serving ${short(label.commit)}`;
  if (label.failing === undefined) return serving;
  if (label.failing.length === 0) return `${serving}, every gate passed`;
  return `${serving}, failing: ${label.failing.join(', ')}`;
}

/** The summary's sentence on the served copy: its label, where it is, and its status page. */
export function servedLine(served: ServedNow | undefined): string {
  if (served === undefined) return 'nothing is served now';
  const here = served.url === undefined ? served.localUrl : `${served.url} (${served.localUrl} here)`;
  return `${labelText(served)}, at ${here}; status at ${served.statusUrl}`;
}

interface Decided {
  input: ServeInput;
  control: ServedControl;
  port: number;
  urls: () => ServedUrls;
  servable: boolean;
  /** The commit served now, if any. */
  serving: string | undefined;
  /** The record for this hour's commit, once it is the one served. */
  next: () => LastServed;
}

/** Leaves the copy up, or down; the same commit, still servable, gets this hour's label. */
function leave(decided: Decided): ServeOutcome {
  const { input, serving } = decided;
  const isRelabel = decided.servable && serving === input.commit;
  if (isRelabel) writeLastServed(input.paths.lastServed, decided.next());
  const note = leaveNote(decided.servable, input.failed, serving);
  if (serving === undefined) return { action: 'leave', note };
  return { action: 'leave', note, served: { ...labelOf(serving, readLastServed(input.paths.lastServed)), ...decided.urls() } };
}

/** Stops the copy, starts it on this hour's commit, and records it once it is ready. */
async function serveThis(action: ServeAction, decided: Decided): Promise<ServeOutcome> {
  const { input, control, port } = decided;
  await control.stop();
  input.say(`serving ${short(input.commit)} on port ${port}`);
  const problem = await control.start(input.commit);
  if (problem !== undefined) return { action, note: `the served copy failed to start: ${problem}` };
  const record = decided.next();
  writeLastServed(input.paths.lastServed, record);
  const lines = control.publish();
  const note = `serving ${short(input.commit)} on port ${port}; ${lines.join('; ')}`;
  return { action, note, served: { ...labelOf(input.commit, record), ...decided.urls() } };
}

export async function serveNewest(input: ServeInput): Promise<ServeOutcome> {
  const { paths, commit } = input;
  const at = new Date().toISOString();
  const isAllPassed = input.failed.length === 0;
  if (isAllPassed) writeLastGood(paths.lastGood, { commit, hour: input.hour, at });
  const port = servedPort();
  const host = serveHost();
  const control = input.control ?? servedControl(paths, input.record, port, host, input.signal, input.providerSocket);
  const previous = readLastServed(paths.lastServed);
  const serving = control.servingCommit();
  const servable = meetsServeMinimum(input.failed);
  const next = () => nextLastServed(previous, { commit, hour: input.hour, at, failing: input.failed }, input.record.startCommit, paths.gitDir);
  const decided: Decided = { input, control, port, urls: () => servedUrls(port, host), servable, serving, next };
  const action = serveAction({ previous, servable, commit, serving: serving !== undefined });
  if (action === 'leave') return leave(decided);
  return serveThis(action, decided);
}
