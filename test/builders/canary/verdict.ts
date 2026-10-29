/**
 * Judges a canary run from what the plants saw and what the recorder wrote.
 * Every planted request must be in the record and must have been refused by
 * the layer meant to refuse it: the Node preload for Node, Chromium's resolver
 * rules for the browser, and the network namespace for clients no recorder
 * hooks. The namespace stops everything, so a Node or browser plant it stopped
 * still fails the canary: that layer's own refusal is what is under test.
 * The local requests must have worked and must not be flagged; no Google host
 * may be allowed by the Node layer; no browser socket may leave loopback; and
 * the namespace's resolver may see only the unhooked plants' lookups.
 */
import { normalizeHostname } from '../../../packages/cli/src/google-endpoints.ts';
import type { BrowserConnect, BrowserRequest } from '../recorder/chromium-netlog.ts';
import { isLoopbackHost } from '../recorder/google-hosts.ts';
import { isGoogleEvent, type NamespaceDnsEvent, type NetworkEvent, type NodeNetworkEvent } from '../recorder/network-record.ts';

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

export interface CanaryObservations {
  node: { plants: NodePlantResult[]; local: { url: string; outcome: string } };
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
  return record.filter((event): event is NamespaceDnsEvent => event.layer === 'namespace');
}

function browserConnects(record: readonly NetworkEvent[]): BrowserConnect[] {
  return record.filter((event): event is BrowserConnect & { time: string } => event.layer === 'browser' && event.kind === 'connect');
}

function refuser(outcome: string): string {
  return outcome.includes(REFUSED_BY_RECORDER) ? 'refused by the recorder' : `failed, but not by the recorder (${outcome})`;
}

function judgeNodePlant(plant: NodePlantResult, events: readonly NodeNetworkEvent[]): CanaryCheck {
  const host = normalizeHostname(plant.host);
  const matching = events.filter((event) => event.host === host);
  const isRecorded = matching.some(isGoogleEvent);
  const wasAllowed = matching.some((event) => event.action === 'allowed');
  const isRefusedByRecorder = plant.outcome.includes(REFUSED_BY_RECORDER);
  const ok = isRecorded && isRefusedByRecorder && !wasAllowed;
  const detail = [
    isRecorded ? `recorded (${matching.map((event) => `${event.kind} ${event.action}`).join(', ')})` : 'missing from the record',
    hasFailed(plant.outcome) ? refuser(plant.outcome) : 'the request succeeded',
    ...(wasAllowed ? ['the recorder allowed a connection to it'] : []),
  ].join('; ');
  return { name: `node: ${plant.name}`, ok, detail };
}

function judgeNodeLocal(local: { url: string; outcome: string }, events: readonly NodeNetworkEvent[]): CanaryCheck {
  const host = normalizeHostname(new URL(local.url).hostname);
  const matching = events.filter((event) => event.host === host);
  const isFlagged = matching.some(isGoogleEvent);
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

function judgeBrowserPlant(plant: BrowserPlantResult, requests: readonly BrowserRequest[]): CanaryCheck {
  const matching = requests.filter((request) => request.url === plant.url);
  const isRecorded = matching.length > 0 && matching.every(isGoogleEvent);
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
  const isFlagged = matching.some(isGoogleEvent);
  const ok = local.outcome === SUCCEEDED && completed && !isFlagged;
  const detail = `${local.outcome}; ${completed ? 'completed in the NetLog' : 'not completed in the NetLog'}${isFlagged ? ', flagged as Google' : ''}`;
  return { name: `browser: local request to ${local.url}`, ok, detail };
}

function judgeNoAllowedGoogle(events: readonly NodeNetworkEvent[]): CanaryCheck {
  const allowed = events.filter((event) => isGoogleEvent(event) && event.action === 'allowed');
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

function unhookedRecordDetail(needsLookup: boolean, isRecorded: boolean): string {
  if (!needsLookup) return 'an address needs no lookup, so only the namespace saw it';
  if (isRecorded) return 'its lookup is in the record, from the namespace resolver';
  return 'its lookup is missing from the record';
}

function judgeUnhookedPlant(plant: UnhookedPlantResult, queries: readonly NamespaceDnsEvent[]): CanaryCheck {
  const host = normalizeHostname(plant.host);
  const needsLookup = !isIpAddress(host);
  const isRecorded = queries.some((query) => query.host === host && isGoogleEvent(query));
  const ok = hasFailed(plant.outcome) && (isRecorded || !needsLookup);
  const detail = [unhookedRecordDetail(needsLookup, isRecorded), hasFailed(plant.outcome) ? `stopped by the namespace (${plant.outcome})` : 'the request succeeded'].join('; ');
  return { name: `unhooked: ${plant.name}`, ok, detail };
}

function judgeResolverQueries(queries: readonly NamespaceDnsEvent[], unhooked: readonly UnhookedPlantResult[]): CanaryCheck {
  const expected = new Set(unhooked.map((plant) => normalizeHostname(plant.host)));
  const unexpected = [...new Set(queries.map((query) => query.host).filter((host) => !expected.has(host)))];
  const detail = unexpected.length === 0 ? `${queries.length} queries, all from the unhooked plants` : `lookups no hooked layer should have sent: ${unexpected.join(', ')}`;
  return { name: 'namespace: only the unhooked plants reached the resolver', ok: unexpected.length === 0, detail };
}

export function judgeCanary(observations: CanaryObservations): CanaryVerdict {
  const node = nodeEvents(observations.record);
  const requests = browserRequests(observations.record);
  const checks = [
    ...observations.node.plants.map((plant) => judgeNodePlant(plant, node)),
    judgeNodeLocal(observations.node.local, node),
    judgeNoAllowedGoogle(node),
    ...observations.browser.plants.map((plant) => judgeBrowserPlant(plant, requests)),
    judgeBrowserLocal(observations.browser.local, requests),
    judgeBrowserSockets(browserConnects(observations.record)),
    ...observations.unhooked.plants.map((plant) => judgeUnhookedPlant(plant, namespaceQueries(observations.record))),
    judgeResolverQueries(namespaceQueries(observations.record), observations.unhooked.plants),
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
    googleEvents: observations.record.filter(isGoogleEvent).length,
  };
}
