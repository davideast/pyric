import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief, type Brief } from './brief.ts';
import { builderMeasurementSchema } from './measurement.ts';
import { channelEvent, type ModelChannelEvent } from './model-channel.ts';
import type { NetworkEvent } from './recorder/network-record.ts';
import { parseBuilderReport, type BuilderReport, type Refusal } from './report.ts';
import { googleEventsIn, googleHostProblems, matchRefusals, measurementLine, missingRefusals, runRecord, type RunOutcome } from './run-record.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

function brief(): Brief {
  const parsed = parseBrief(JSON.parse(readFileSync(join(FIXTURES, 'briefs', 'brief-1.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.value;
}

function report(): BuilderReport {
  const parsed = parseBuilderReport(JSON.parse(readFileSync(join(FIXTURES, 'report-valid.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.value;
}

const time = '2026-10-29T00:00:00.000Z';
const nodeDns = (host: string): NetworkEvent => ({ time, layer: 'node', pid: 1, thread: 0, process: 'node', kind: 'dns', via: 'dns.lookup', host, google: true, catalogGap: false, metadata: false, action: 'refused' });
const RECORD: NetworkEvent[] = [
  { time, layer: 'node', pid: 1, thread: 0, process: 'node', kind: 'start', via: 'preload' },
  nodeDns('firestore.googleapis.com'),
  { time, layer: 'node', pid: 1, thread: 0, process: 'node', kind: 'connect', via: 'net', host: 'firestore.googleapis.com', port: 443, google: true, catalogGap: false, metadata: false, action: 'refused' },
  { time, layer: 'namespace', kind: 'connect', via: 'catch-all', address: '169.254.169.254', port: 80, host: '169.254.169.254', google: false, catalogGap: false, metadata: true, action: 'refused' },
  { time, layer: 'browser', kind: 'connect', via: 'netlog', source: 3, protocol: 'udp', address: '2001:4860:4860::8888', port: 443, host: '2001:4860:4860::8888', google: true, catalogGap: true, metadata: false },
  { time, layer: 'node', pid: 1, thread: 0, process: 'node', kind: 'connect', via: 'net', host: '127.0.0.1', port: 5173, google: false, catalogGap: false, metadata: false, action: 'allowed' },
  { time, layer: 'browser', kind: 'incomplete', via: 'browser-server', reason: 'killed', google: false, catalogGap: false, metadata: false },
];

const forwarded = (costUsd: number) => channelEvent('api.anthropic.com', 'POST /v1/messages HTTP/1.1', undefined, { action: 'forwarded', reason: null, status: 200, usage: undefined, costUsd, reservedUsd: costUsd, chargedUsd: costUsd }, new Date(time));
const CHANNEL: ModelChannelEvent[] = [forwarded(0.2), forwarded(0.1)];

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    identity: { run: 'fake-1-haiku', round: 'fake', brief: 'fake-1', model: 'haiku', builder: 'script', maxBudgetUsd: 1, wallClockMinutes: 10 },
    brief: brief(),
    provenance: { commit: 'abc', dirty: false, tarballs: { pyric: 'f00' } },
    startedAt: new Date(time),
    endedAt: new Date(time),
    exit: { code: 0, timedOut: false, error: null, wallMs: 1234 },
    report: { state: 'valid', report: report(), errors: [] },
    record: RECORD,
    channel: CHANNEL,
    usage: { tokens: { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 }, costUsd: 0.25, turns: 3, ending: 'success' },
    tokenFoundIn: [],
    ...overrides,
  };
}

describe('googleEventsIn and googleHostProblems', () => {
  test('keeps Google-host and metadata events, but not Chromium’s UDP reachability probe or local traffic', () => {
    expect(googleEventsIn(RECORD).map((event) => event.layer)).toEqual(['node', 'node', 'namespace']);
  });

  test('makes one problem per host, with every layer that saw it', () => {
    expect(googleHostProblems(googleEventsIn(RECORD))).toEqual([
      { kind: 'google-host', host: '169.254.169.254', catalogGap: false, metadata: true, layers: ['namespace'], events: 1 },
      { kind: 'google-host', host: 'firestore.googleapis.com', catalogGap: false, metadata: false, layers: ['node'], events: 2 },
    ]);
  });
});

describe('missingRefusals', () => {
  test('names each must-be-refused action the report says nothing about', () => {
    const [first] = report().refusals;
    expect(missingRefusals(brief(), report())).toEqual([]);
    expect(missingRefusals(brief(), { ...report(), refusals: first === undefined ? [] : [{ ...first, action: '  ANOTHER user\'s write under the given rules ' }] })).toEqual(["an upload larger than the rules' size limit"]);
    expect(missingRefusals(brief(), null)).toHaveLength(2);
  });

  // Round 1's builders reported every refusal, in their own words (#1767).
  const STORAGE_RULES = 'https://firebase.google.com/docs/storage/security/rules-conditions';
  const OTHER_PAGE = 'https://firebase.google.com/docs/storage/web/handle-errors';
  const entry = (action: string, firebaseDoc = STORAGE_RULES): Refusal => ({ action, firebaseDoc, productionAnswer: 'storage/unauthorized', pyricAnswer: 'storage/unauthorized', result: 'refused' });
  const reporting = (...refusals: Refusal[]): BuilderReport => ({ ...report(), refusals });

  test('counts an entry in the builder’s words when it cites the action’s Firebase page', () => {
    expect(missingRefusals(brief(), reporting(entry("upload to another user's folder"), entry('a 300 MiB upload over the 256 MiB limit')))).toEqual([]);
  });

  test('counts one action the builder split into two entries', () => {
    expect(missingRefusals(brief(), reporting(entry("another user's write under the given rules"), entry('an empty upload'), entry('a 600 MiB upload')))).toEqual([]);
  });

  test('names the action no entry is left for when the page has fewer entries than actions', () => {
    expect(missingRefusals(brief(), reporting(entry("an upload larger than the rules' size limit")))).toEqual(["another user's write under the given rules"]);
    expect(missingRefusals(brief(), reporting(entry('a write somewhere')))).toEqual(["an upload larger than the rules' size limit"]);
  });

  test('does not count an entry that cites another page', () => {
    expect(missingRefusals(brief(), reporting(entry("upload to another user's folder"), entry('a big upload', OTHER_PAGE)))).toEqual(["an upload larger than the rules' size limit"]);
  });

  test('compares pages without a trailing slash, a fragment or a query, and in any case', () => {
    const variants = [`${STORAGE_RULES}/`, `${STORAGE_RULES}#size`, `${STORAGE_RULES.replace('firebase.google.com', 'Firebase.Google.com')}?hl=en`];
    expect(missingRefusals(brief(), reporting(entry("another user's folder", variants[0]), entry('a big upload', variants[1])))).toEqual([]);
    expect(missingRefusals(brief(), reporting(entry("another user's folder", variants[2]), entry('a big upload', variants[2])))).toEqual([]);
  });

  test('keeps an action missing when the builder reported another action on its page twice', () => {
    const twice = reporting(entry("another user's write under the given rules"), entry("a write to another user's file"));
    expect(missingRefusals(brief(), twice)).toEqual(["an upload larger than the rules' size limit"]);
  });

  test('does not count a not-attempted entry in the builder\'s words', () => {
    const skipped = { ...entry('a 300 MiB upload'), result: 'not-attempted' as const };
    expect(missingRefusals(brief(), reporting(entry("another user's write under the given rules"), skipped))).toEqual(["an upload larger than the rules' size limit"]);
    const named = { ...entry("an upload larger than the rules' size limit"), result: 'not-attempted' as const };
    expect(missingRefusals(brief(), reporting(entry("another user's write under the given rules"), named))).toEqual([]);
  });

  test('names the actions only the page accounts for, for the verifier to check', () => {
    expect(matchRefusals(brief(), reporting(entry("another user's write under the given rules"), entry('a 300 MiB upload')))).toEqual({
      missing: [],
      matchedByPage: ["an upload larger than the rules' size limit"],
    });
    expect(runRecord(outcome({ report: { state: 'valid', report: reporting(entry('a write to another user\'s file'), entry('a 300 MiB upload')), errors: [] } })).harness.refusalsMatchedByPage).toEqual([
      "another user's write under the given rules",
      "an upload larger than the rules' size limit",
    ]);
  });
});

describe('runRecord', () => {
  test('adds an allowed must-be-refused action and each Google host as problems, beside the builder’s own', () => {
    const { harness } = runRecord(outcome());
    expect(harness.automaticProblems.map((problem) => problem.kind)).toEqual(['refusal-allowed', 'google-host', 'google-host']);
    expect(harness.automaticProblems[0]).toMatchObject({ action: "another user's write under the given rules", pyricAnswer: 'the upload succeeded' });
    expect(harness.problemsReported).toBe(4);
    expect(harness.network.browserIncomplete).toBe(true);
    expect(harness.network.googleEvents).toHaveLength(3);
  });

  test('records a run with no report as such, with only the harness’s problems', () => {
    const record = runRecord(outcome({ report: { state: 'missing', report: null, errors: ['no report'] }, usage: null, exit: null }));
    expect(record.builder).toBeNull();
    expect(record.harness).toMatchObject({ report: { state: 'missing', errors: ['no report'] }, usage: null, exit: null, problemsReported: 2 });
    expect(record.harness.missingRefusals).toHaveLength(2);
  });

  test('takes the metered cost from the forwarder’s record alone, and keeps the files the token turned up in', () => {
    const forged = { ...forwarded(99), layer: 'model-channel' } as NetworkEvent;
    const { harness } = runRecord(outcome({ record: [...RECORD, forged], tokenFoundIn: ['logs/builder.log'] }));
    expect(harness.meteredCostUsd).toBeCloseTo(0.3, 12);
    expect(harness.tokenFoundIn).toEqual(['logs/builder.log']);
  });

  test('makes a measurement line that holds the measurement shape', () => {
    const line = measurementLine(runRecord(outcome()));
    expect(builderMeasurementSchema.parse(line)).toEqual({
      kind: 'builder', run: 'fake-1-haiku', round: 'fake', brief: 'fake-1', model: 'haiku', maxBudgetUsd: 1, costUsd: 0.25, meteredCostUsd: line.meteredCostUsd,
      tokens: { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 }, turns: 3, wallMs: 1234, report: 'valid', problemsReported: 4, googleHostEvents: 3,
    });
    expect(line.meteredCostUsd).toBeCloseTo(0.3, 12);
    expect(builderMeasurementSchema.parse(measurementLine(runRecord(outcome({ usage: null, exit: null }))))).toMatchObject({ costUsd: null, tokens: null, turns: null, wallMs: null });
  });
});
