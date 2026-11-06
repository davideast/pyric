/**
 * A run's `network.jsonl`: one JSON line per event. The Node layer
 * (`node-egress.mjs`), the sandbox's resolver (`dns-log.mjs`) and its
 * catch-all listener (`catch-all-log.mjs`) append as processes run, and the
 * canary's Node plants add a marker line before each plant. The harness
 * appends the browser's events from the NetLog once the browser server has
 * stopped.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ModelChannelEvent } from '../model-channel.ts';
import { parseJsonText } from '../parse.ts';
import type { BrowserEvent } from './chromium-netlog.ts';

/** What the Node layer did about an event. */
export type NodeAction = 'refused' | 'allowed' | 'recorded';

/** One line the Node layer wrote. */
export interface NodeNetworkEvent {
  time: string;
  layer: 'node';
  pid: number;
  thread: number;
  process: string;
  /** `plant` is the canary's marker: the events after it, from the same pid, are that plant's. */
  kind: 'start' | 'plant' | 'request' | 'dns' | 'connect';
  via: string;
  host?: string;
  port?: number;
  url?: string;
  method?: string;
  google?: boolean;
  catalogGap?: boolean;
  metadata?: boolean;
  service?: string;
  action?: NodeAction;
  /** On a `plant` marker: the plant whose events follow. */
  plant?: string;
}

/** One DNS query the sandbox's resolver (`dns-log.mjs`) answered NXDOMAIN. */
export interface NamespaceDnsEvent {
  time: string;
  layer: 'namespace';
  kind: 'dns';
  via: 'resolver';
  queryType: string;
  host: string;
  google: boolean;
  catalogGap: boolean;
  metadata: boolean;
  service?: string;
  action: 'refused';
}

/** One TCP connection the sandbox's catch-all listener (`catch-all-log.mjs`) took and reset. */
export interface NamespaceConnectEvent {
  time: string;
  layer: 'namespace';
  kind: 'connect';
  via: 'catch-all';
  /** The address the client dialed. */
  address: string;
  port: number;
  host: string;
  google: boolean;
  catalogGap: boolean;
  metadata: boolean;
  service?: string;
  action: 'refused';
}

/**
 * The harness's note that a layer's record is cut short: the browser server
 * was killed after its stop timed out, so its NetLog may end before the
 * browser's last events. A reader takes that layer's missing events as
 * unknown, not as absent.
 */
export interface IncompleteMarker {
  time: string;
  layer: 'browser';
  kind: 'incomplete';
  via: 'browser-server';
  reason: string;
  /** A marker is no Google-host or metadata event. */
  google: false;
  catalogGap: false;
  metadata: false;
}

export type NetworkEvent = NodeNetworkEvent | NamespaceDnsEvent | NamespaceConnectEvent | ModelChannelEvent | IncompleteMarker | (BrowserEvent & { time: string });

/** Appends a marker that the browser's part of the record may be cut short. */
export function appendBrowserIncomplete(path: string, reason: string, time: Date = new Date()): void {
  const marker: IncompleteMarker = { time: time.toISOString(), layer: 'browser', kind: 'incomplete', via: 'browser-server', reason, google: false, catalogGap: false, metadata: false };
  appendFileSync(path, `${JSON.stringify(marker)}\n`);
}

/** Whether a record says the browser's events may be cut short. */
export function browserRecordIncomplete(events: readonly NetworkEvent[]): boolean {
  return events.some((event) => event.kind === 'incomplete' && event.layer === 'browser');
}

/**
 * The fields a reader of the record relies on, with their types. A builder
 * can write the record, so a line is checked before anything reads it;
 * the fields a layer adds beyond these pass through.
 */
const networkLineSchema = z.object({
  time: z.string(),
  layer: z.string(),
  kind: z.string(),
  via: z.string(),
  host: z.string().optional(),
  google: z.boolean().optional(),
  catalogGap: z.boolean().optional(),
  metadata: z.boolean().optional(),
  protocol: z.string().optional(),
}).passthrough();

/** Whether `value` has the fields a reader relies on, with their types. */
const isNetworkEvent = (value: unknown): value is NetworkEvent => networkLineSchema.safeParse(value).success;

/** A network record's events, and how many whole lines were JSON but no event. */
export interface NetworkLines {
  events: NetworkEvent[];
  rejected: number;
}

/**
 * Every whole line of a network record that has an event's shape. A line
 * cut short by a process killed mid-write is no JSON and is passed over; a
 * line of JSON without an event's shape is counted as rejected. A missing
 * file is an empty record.
 */
export function readNetworkLines(path: string): NetworkLines {
  if (!existsSync(path)) return { events: [], rejected: 0 };
  const lines: NetworkLines = { events: [], rejected: 0 };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const json = parseJsonText(line);
    if (!json.ok) continue;
    if (isNetworkEvent(json.value)) lines.events.push(json.value);
    else lines.rejected += 1;
  }
  return lines;
}

/** Every event of a network record, without the count of rejected lines. */
export const readNetworkRecord = (path: string): NetworkEvent[] => readNetworkLines(path).events;

/** Appends the browser's events, stamped with when the harness read them. */
export function appendBrowserEvents(path: string, events: readonly BrowserEvent[], time: Date = new Date()): void {
  const stamp = time.toISOString();
  const lines = events.map((event) => `${JSON.stringify({ time: stamp, ...event })}\n`);
  if (lines.length > 0) appendFileSync(path, lines.join(''));
}
