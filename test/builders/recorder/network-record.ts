/**
 * A run's `network.jsonl`: one JSON line per event. The Node layer
 * (`node-egress.mjs`), the sandbox's resolver (`dns-log.mjs`) and its
 * catch-all listener (`catch-all-log.mjs`) append as processes run, and the
 * canary's Node plants add a marker line before each plant. The harness
 * appends the browser's events from the NetLog once the browser server has
 * stopped.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { ModelChannelEvent } from '../model-channel.ts';
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

/** Every whole line of a network record. A missing file is an empty record. */
export function readNetworkRecord(path: string): NetworkEvent[] {
  if (!existsSync(path)) return [];
  const events: NetworkEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as NetworkEvent);
    } catch {
      // A line cut short by a process that was killed mid-write.
    }
  }
  return events;
}

/** Appends the browser's events, stamped with when the harness read them. */
export function appendBrowserEvents(path: string, events: readonly BrowserEvent[], time: Date = new Date()): void {
  const stamp = time.toISOString();
  const lines = events.map((event) => `${JSON.stringify({ time: stamp, ...event })}\n`);
  if (lines.length > 0) appendFileSync(path, lines.join(''));
}
