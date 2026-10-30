/**
 * What the harness keeps of one builder run: `runs/<round>/<run>/report.json`
 * in the data root. `builder` is the builder's own report, validated (null
 * when it wrote none, or one that fails the shape). `harness` holds what the
 * harness wrote: every Google-host event in the run's network record, the
 * usage `claude -p` printed and the cost the model forwarder metered, the
 * commit and tarball hashes, the files the harness's token turned up in, and
 * the problems the harness adds on its own:
 *
 * - each must-be-refused action the builder reports pyric allowed;
 * - each Google host or metadata address the run reached for, whichever
 *   layer saw it.
 *
 * The network record is only as trustworthy as where each layer wrote it.
 * The Node, namespace and browser layers write into the run directory,
 * which the sandbox binds read-write, so a builder could add lines there or
 * remove them. The model channel's lines come from outside: from the
 * forwarder's own record, beside the run directory, appended once the
 * sandbox has stopped. The metered cost is read from that record alone.
 */
import type { Brief } from './brief.ts';
import type { BuilderMeasurement } from './measurement.ts';
import { meteredCostUsd, meteredTokens, type ModelChannelEvent } from './model-channel.ts';
import type { PhaseResult } from './run-phase.ts';
import type { Provenance } from './provenance.ts';
import { isGoogleOrMetadata } from './recorder/google-hosts.ts';
import { browserRecordIncomplete, type NetworkEvent } from './recorder/network-record.ts';
import type { BuilderReport, ReadReport, Refusal } from './report.ts';
import type { Usage } from './usage.ts';

export interface RunIdentity {
  run: string;
  round: string;
  brief: string;
  model: string;
  builder: string;
  maxBudgetUsd: number;
  wallClockMinutes: number;
}

export type AutomaticProblem =
  | { kind: 'refusal-allowed'; action: string; firebaseDoc: string; productionAnswer: string; pyricAnswer: string }
  | { kind: 'google-host'; host: string; catalogGap: boolean; metadata: boolean; layers: string[]; events: number };

export interface HarnessFields extends RunIdentity {
  provenance: Provenance;
  startedAt: string;
  endedAt: string;
  /** How the builder ended; null when the run phase never wrote its result. */
  exit: PhaseResult | null;
  report: { state: ReadReport['state']; errors: string[] };
  network: {
    googleEvents: NetworkEvent[];
    /** The browser server was killed, so browser events may be missing: unknown, not absent. */
    browserIncomplete: boolean;
  };
  usage: Usage | null;
  /** What the forwarder metered from the model API's responses: an estimate that errs high. */
  meteredCostUsd: number;
  /** Files of the run that held the harness's token, which `round` redacted or withheld. Empty unless something leaked. */
  tokenFoundIn: string[];
  /**
   * Files of the run root the harness would read, append to or write once
   * the sandbox stopped, but skipped, each as `<path>: <why>` relative to the
   * run root: a link, or a path through one (`planted-links.ts`), or one it
   * could not check, merge into, write or read even after giving the owner
   * its permissions back (`owner-access.ts`). `network.jsonl` is also named
   * when lines of it were not network events, or the record could not be
   * built from it. Empty unless the sandbox left one, which makes the run
   * invalid.
   */
  plantedLinks: string[];
  automaticProblems: AutomaticProblem[];
  /** Must-be-refused actions of the brief the report says nothing about. */
  missingRefusals: string[];
  /** The builder's problems plus the automatic ones. */
  problemsReported: number;
}

export interface RunRecord {
  builder: BuilderReport | null;
  harness: HarnessFields;
}

const isAllowed = (refusal: Refusal) => refusal.result === 'allowed';

function refusalProblems(report: BuilderReport | null): AutomaticProblem[] {
  const allowed = (report?.refusals ?? []).filter(isAllowed);
  return allowed.map(({ action, firebaseDoc, productionAnswer, pyricAnswer }) => ({ kind: 'refusal-allowed', action, firebaseDoc, productionAnswer, pyricAnswer }));
}

/** The host an event names. Every classified event carries one; the fallback keeps a malformed line visible. */
function hostOf(event: NetworkEvent): string {
  const named = 'host' in event && typeof event.host === 'string';
  return named ? event.host : '(no host)';
}

/** One problem per Google host or metadata address, with every layer that saw it. */
export function googleHostProblems(events: readonly NetworkEvent[]): AutomaticProblem[] {
  const byHost = new Map<string, NetworkEvent[]>();
  for (const event of events) {
    const host = hostOf(event);
    byHost.set(host, [...(byHost.get(host) ?? []), event]);
  }
  return [...byHost].sort(([a], [b]) => a.localeCompare(b)).map(([host, seen]) => ({
    kind: 'google-host',
    host,
    catalogGap: seen.some((event) => 'catalogGap' in event && event.catalogGap === true),
    metadata: seen.some((event) => 'metadata' in event && event.metadata === true),
    layers: [...new Set(seen.map((event) => event.layer))].sort(),
    events: seen.length,
  }));
}

const normalized = (action: string) => action.trim().toLowerCase();

export function missingRefusals(brief: Brief, report: BuilderReport | null): string[] {
  const reported = new Set((report?.refusals ?? []).map((refusal) => normalized(refusal.action)));
  return brief.mustBeRefused.map((line) => line.action).filter((action) => !reported.has(normalized(action)));
}

export interface RunOutcome {
  identity: RunIdentity;
  brief: Brief;
  provenance: Provenance;
  startedAt: Date;
  endedAt: Date;
  exit: PhaseResult | null;
  report: ReadReport;
  record: readonly NetworkEvent[];
  /** The forwarder's own record of the run. */
  channel: readonly ModelChannelEvent[];
  usage: Usage | null;
  tokenFoundIn: string[];
  plantedLinks: string[];
}

/**
 * Chromium connects a UDP socket to a Google DNS address to learn whether
 * IPv6 works. A UDP connect sends no packet, so it is no request.
 */
function isUdpConnect(event: NetworkEvent): boolean {
  return event.layer === 'browser' && event.kind === 'connect' && 'protocol' in event && event.protocol === 'udp';
}

/** Events that reached for a Google host or the metadata server. */
export function googleEventsIn(record: readonly NetworkEvent[]): NetworkEvent[] {
  return record.filter((event) => 'google' in event && isGoogleOrMetadata(event) && !isUdpConnect(event));
}

export function runRecord(outcome: RunOutcome): RunRecord {
  const googleEvents = googleEventsIn(outcome.record);
  const automatic = [...refusalProblems(outcome.report.report), ...googleHostProblems(googleEvents)];
  const builder = outcome.report.report;
  return {
    builder,
    harness: {
      ...outcome.identity,
      provenance: outcome.provenance,
      startedAt: outcome.startedAt.toISOString(),
      endedAt: outcome.endedAt.toISOString(),
      exit: outcome.exit,
      report: { state: outcome.report.state, errors: outcome.report.errors },
      network: { googleEvents, browserIncomplete: browserRecordIncomplete(outcome.record) },
      usage: outcome.usage,
      meteredCostUsd: meteredCostUsd(outcome.channel),
      tokenFoundIn: outcome.tokenFoundIn,
      plantedLinks: outcome.plantedLinks,
      automaticProblems: automatic,
      missingRefusals: missingRefusals(outcome.brief, builder),
      problemsReported: (builder?.problems.length ?? 0) + automatic.length,
    },
  };
}

/**
 * The run's line in measurements.jsonl, from the harness's own state alone:
 * the run's identity, the forwarder's record and the harness's timing of
 * the run phase. Nothing of the run root, which the builder can write.
 */
export function measurementLine(identity: RunIdentity, channel: readonly ModelChannelEvent[], wallMs: number): BuilderMeasurement {
  return {
    kind: 'builder',
    run: identity.run,
    round: identity.round,
    brief: identity.brief,
    model: identity.model,
    maxBudgetUsd: identity.maxBudgetUsd,
    meteredCostUsd: meteredCostUsd(channel),
    tokens: meteredTokens(channel),
    wallMs,
  };
}
