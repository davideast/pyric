/**
 * Judges a canary run from what the plants saw and what the recorder wrote.
 * Every planted request must be in the record and must have been refused by
 * the layer meant to refuse it: the Node preload for Node, Chromium's resolver
 * rules for the browser, and the sandbox for clients no recorder hooks. The
 * sandbox stops everything, so a Node or browser plant it stopped still fails
 * the canary: that layer's own refusal is what is under test. Each Node plant
 * is judged by its own events, the ones after its marker line. An unhooked
 * plant must be in the sandbox's own record: its lookup at the resolver, or
 * for an address, its connection at the catch-all listener. The local
 * requests must have worked and must not be flagged; no Google host may be
 * allowed by the Node layer; no browser socket may leave loopback; and the
 * resolver and the catch-all listener may see only the unhooked plants.
 */
import { normalizeHostname } from '../../../packages/cli/src/google-endpoints.ts';
import type { BrowserConnect, BrowserRequest } from '../recorder/chromium-netlog.ts';
import { isGoogleOrMetadata, isLoopbackHost } from '../recorder/google-hosts.ts';
import { EXPECTED_PLANTS, type ExpectedPlants } from './plant-names.ts';
import { type NamespaceConnectEvent, type NamespaceDnsEvent, type NetworkEvent, type NodeNetworkEvent } from '../recorder/network-record.ts';

export interface NodePlantResult {
  name: string;
  host: string;
  outcome: string;
}

export interface BrowserPlantResult {
  name: string;
  url: string;
  outcome: string;
}

/** A request from a client no recorder hooks: Bun, curl. */
export interface UnhookedPlantResult {
  name: string;
  host: string;
  outcome: string;
}

/** A local request, named as its marker line names it. */
export interface LocalResult {
  name: string;
  url: string;
  outcome: string;
}

export interface CanaryObservations {
  node: { plants: NodePlantResult[]; local: LocalResult };
  browser: { plants: BrowserPlantResult[]; local: { url: string; outcome: string } };
  unhooked: { plants: UnhookedPlantResult[] };
  record: NetworkEvent[];
}

export interface CanaryCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CanaryVerdict {
  ok: boolean;
  checks: CanaryCheck[];
  /** Every Google-host or metadata event in the record, planted or not. */
  googleEvents: number;
}

const SUCCEEDED = 'succeeded';
const REFUSED_BY_RECORDER = 'PYRIC_BUILDER_REFUSED';
/** What Chromium's resolver rules answer for every host but loopback. */
const REFUSED_BY_RESOLVER_RULES = 'ERR_NAME_NOT_RESOLVED';

const hasFailed = (outcome: string) => outcome.startsWith('failed');

function nodeEvents(record: readonly NetworkEvent[]): NodeNetworkEvent[] {
  return record.filter((event): event is NodeNetworkEvent => event.layer === 'node');
}

function browserRequests(record: readonly NetworkEvent[]): BrowserRequest[] {
  return record.filter((event): event is BrowserRequest & { time: string } => event.layer === 'browser' && event.kind === 'request');
}

function namespaceQueries(record: readonly NetworkEvent[]): NamespaceDnsEvent[] {
  return record.filter((event): event is NamespaceDnsEvent => event.layer === 'namespace' && event.kind === 'dns');
}

function catchAllConnects(record: readonly NetworkEvent[]): NamespaceConnectEvent[] {
  return record.filter((event): event is NamespaceConnectEvent => event.layer === 'namespace' && event.kind === 'connect');
}

/**
 * Each Node plant's own events: those its process wrote after the plant's
 * marker line and before the next marker. Worker threads share the pid.
 */
export function plantSegments(events: readonly NodeNetworkEvent[]): Map<string, NodeNetworkEvent[]> {
  const segments = new Map<string, NodeNetworkEvent[]>();
  const current = new Map<number, NodeNetworkEvent[]>();
  for (const event of events) {
    if (event.kind === 'plant' && event.plant !== undefined) {
      const segment = segments.get(event.plant) ?? [];
      segments.set(event.plant, segment);
      current.set(event.pid, segment);
      continue;
    }
    current.get(event.pid)?.push(event);
  }
  return segments;
}

function browserConnects(record: readonly NetworkEvent[]): BrowserConnect[] {
  return record.filter((event): event is BrowserConnect & { time: string } => event.layer === 'browser' && event.kind === 'connect');
}

function refuser(outcome: string): string {
  return outcome.includes(REFUSED_BY_RECORDER) ? 'refused by the recorder' : `failed, but not by the recorder (${outcome})`;
}

/** Judges a Node plant by `events`, its own segment of the record. */
export function judgeNodePlant(plant: NodePlantResult, events: readonly NodeNetworkEvent[]): CanaryCheck {
  const host = normalizeHostname(plant.host);
  const matching = events.filter((event) => event.host === host);
  const isRecorded = matching.some(isGoogleOrMetadata);
  const wasAllowed = matching.some((event) => event.action === 'allowed');
  const isRefusedByRecorder = plant.outcome.includes(REFUSED_BY_RECORDER);
  const ok = isRecorded && isRefusedByRecorder && !wasAllowed;
  const detail = [
    isRecorded ? `recorded (${matching.map((event) => `${event.kind} ${event.action}`).join(', ')})` : 'missing from its own events in the record',
    hasFailed(plant.outcome) ? refuser(plant.outcome) : 'the request succeeded',
    ...(wasAllowed ? ['the recorder allowed a connection to it'] : []),
  ].join('; ');
  return { name: `node: ${plant.name}`, ok, detail };
}

/** Judges the Node local request by `events`, its own segment of the record. */
export function judgeNodeLocal(local: LocalResult, events: readonly NodeNetworkEvent[]): CanaryCheck {
  const host = normalizeHostname(new URL(local.url).hostname);
  const matching = events.filter((event) => event.host === host);
  const isFlagged = matching.some(isGoogleOrMetadata);
  const ok = local.outcome === SUCCEEDED && matching.length > 0 && !isFlagged;
  const detail = `${local.outcome}; ${matching.length} events for ${host}${isFlagged ? ', flagged as Google' : ''}`;
  return { name: `node: local request to ${local.url}`, ok, detail };
}

function describeRequests(requests: readonly BrowserRequest[]): string {
  return requests.map((request) => request.netErrorName ?? (request.netError === 0 ? 'completed' : 'unfinished')).join(', ');
}

function netLogPresence(matching: readonly BrowserRequest[], isRecorded: boolean): string {
  if (isRecorded) return `in the NetLog (${describeRequests(matching)})`;
  if (matching.length > 0) return 'in the NetLog but not flagged as Google';
  return 'missing from the NetLog';
}

export function judgeBrowserPlant(plant: BrowserPlantResult, requests: readonly BrowserRequest[]): CanaryCheck {
  const matching = requests.filter((request) => request.url === plant.url);
  const isRecorded = matching.length > 0 && matching.every(isGoogleOrMetadata);
  const isRefusedByRules = matching.length > 0 && matching.every((request) => request.netErrorName === REFUSED_BY_RESOLVER_RULES);
  const ok = isRecorded && isRefusedByRules && hasFailed(plant.outcome);
  const detail = [
    netLogPresence(matching, isRecorded),
    hasFailed(plant.outcome) ? `the page saw ${plant.outcome}` : 'the request succeeded',
  ].join('; ');
  return { name: `browser: ${plant.name}`, ok, detail };
}

function judgeBrowserLocal(local: { url: string; outcome: string }, requests: readonly BrowserRequest[]): CanaryCheck {
  const matching = requests.filter((request) => request.url === local.url);
  const completed = matching.some((request) => request.netError === 0);
  const isFlagged = matching.some(isGoogleOrMetadata);
  const ok = local.outcome === SUCCEEDED && completed && !isFlagged;
  const detail = `${local.outcome}; ${completed ? 'completed in the NetLog' : 'not completed in the NetLog'}${isFlagged ? ', flagged as Google' : ''}`;
  return { name: `browser: local request to ${local.url}`, ok, detail };
}

function judgeNoAllowedGoogle(events: readonly NodeNetworkEvent[]): CanaryCheck {
  const allowed = events.filter((event) => isGoogleOrMetadata(event) && event.action === 'allowed');
  const detail = allowed.length === 0 ? 'none' : allowed.map((event) => `${event.via} ${event.host} in ${event.process}`).join('; ');
  return { name: 'node: no Google host or metadata connection allowed', ok: allowed.length === 0, detail };
}

function judgeBrowserSockets(connects: readonly BrowserConnect[]): CanaryCheck {
  const tcp = connects.filter((connect) => connect.protocol === 'tcp');
  const outside = tcp.filter((connect) => !isLoopbackHost(connect.host));
  const detail = outside.length === 0 ? `${tcp.length} TCP connects, all to loopback` : outside.map((connect) => connect.address).join(', ');
  return { name: 'browser: no TCP socket left loopback', ok: outside.length === 0 && tcp.length > 0, detail };
}

const isIpAddress = (host: string) => /^[\d.]+$/.test(host) || host.includes(':');

/** Where the sandbox records an unhooked plant: the resolver for a name, the catch-all listener for an address. */
function unhookedRecordDetail(needsLookup: boolean, isRecorded: boolean): string {
  if (needsLookup) return isRecorded ? 'its lookup is in the record, from the sandbox resolver' : 'its lookup is missing from the record';
  return isRecorded ? 'its connection is in the record, from the catch-all listener' : 'its connection is missing from the record';
}

function unhookedOutcomeDetail(needsLookup: boolean, outcome: string): string {
  if (!hasFailed(outcome)) return 'the request succeeded';
  return needsLookup ? `the resolver answered NXDOMAIN and the client saw ${outcome}` : `the catch-all listener reset it and the client saw ${outcome}`;
}

function judgeUnhookedPlant(plant: UnhookedPlantResult, queries: readonly NamespaceDnsEvent[], connects: readonly NamespaceConnectEvent[]): CanaryCheck {
  const host = normalizeHostname(plant.host);
  const needsLookup = !isIpAddress(host);
  const sandboxEvents = needsLookup ? queries : connects;
  const isRecorded = sandboxEvents.some((event) => event.host === host && isGoogleOrMetadata(event));
  const ok = hasFailed(plant.outcome) && isRecorded;
  const detail = [unhookedRecordDetail(needsLookup, isRecorded), unhookedOutcomeDetail(needsLookup, plant.outcome)].join('; ');
  return { name: `unhooked: ${plant.name}`, ok, detail };
}

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function unexpectedHosts(events: readonly { host: string }[], unhooked: readonly UnhookedPlantResult[]): string[] {
  const expected = new Set(unhooked.map((plant) => normalizeHostname(plant.host)));
  return [...new Set(events.map((event) => event.host).filter((host) => !expected.has(host)))];
}

function judgeResolverQueries(queries: readonly NamespaceDnsEvent[], unhooked: readonly UnhookedPlantResult[]): CanaryCheck {
  const unexpected = unexpectedHosts(queries, unhooked);
  const detail = unexpected.length === 0 ? `${counted(queries.length, 'query', 'queries')}, all from the unhooked plants` : `lookups no hooked layer should have sent: ${unexpected.join(', ')}`;
  return { name: 'sandbox: only the unhooked plants reached the resolver', ok: unexpected.length === 0, detail };
}

function judgeCatchAllConnects(connects: readonly NamespaceConnectEvent[], unhooked: readonly UnhookedPlantResult[]): CanaryCheck {
  const unexpected = unexpectedHosts(connects, unhooked);
  const detail = unexpected.length === 0 ? `${counted(connects.length, 'connection', 'connections')}, all from the unhooked plants` : `connections no hooked layer should have made: ${unexpected.join(', ')}`;
  return { name: 'sandbox: only the unhooked plants reached the catch-all listener', ok: unexpected.length === 0, detail };
}

/** Fails a side whose report is missing an expected plant or names one not expected. */
export function judgePlantSet(side: string, reported: readonly { name: string }[], expected: readonly string[]): CanaryCheck {
  const names = reported.map((plant) => plant.name);
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  const ok = missing.length === 0 && unexpected.length === 0 && names.length === expected.length;
  const parts = [
    ...(missing.length > 0 ? [`missing: ${missing.join('; ')}`] : []),
    ...(unexpected.length > 0 ? [`not expected: ${unexpected.join('; ')}`] : []),
  ];
  const detail = ok ? `${names.length} of ${expected.length}` : parts.join('; ') || `${names.length} reported, ${expected.length} expected`;
  return { name: `${side}: every expected plant reported`, ok, detail };
}

export function judgeCanary(observations: CanaryObservations, expected: ExpectedPlants = EXPECTED_PLANTS): CanaryVerdict {
  const node = nodeEvents(observations.record);
  const segments = plantSegments(node);
  const ownEvents = (name: string) => segments.get(name) ?? [];
  const requests = browserRequests(observations.record);
  const queries = namespaceQueries(observations.record);
  const connects = catchAllConnects(observations.record);
  const checks = [
    judgePlantSet('node', observations.node.plants, expected.node),
    judgePlantSet('browser', observations.browser.plants, expected.browser),
    judgePlantSet('unhooked', observations.unhooked.plants, expected.unhooked),
    ...observations.node.plants.map((plant) => judgeNodePlant(plant, ownEvents(plant.name))),
    judgeNodeLocal(observations.node.local, ownEvents(observations.node.local.name)),
    judgeNoAllowedGoogle(node),
    ...observations.browser.plants.map((plant) => judgeBrowserPlant(plant, requests)),
    judgeBrowserLocal(observations.browser.local, requests),
    judgeBrowserSockets(browserConnects(observations.record)),
    ...observations.unhooked.plants.map((plant) => judgeUnhookedPlant(plant, queries, connects)),
    judgeResolverQueries(queries, observations.unhooked.plants),
    judgeCatchAllConnects(connects, observations.unhooked.plants),
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
    googleEvents: observations.record.filter(isGoogleOrMetadata).length,
  };
}
