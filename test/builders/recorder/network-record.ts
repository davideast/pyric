/**
 * A run's `network.jsonl`: one JSON line per event. The Node layer
 * (`node-egress.mjs`) and the namespace's resolver (`dns-log.mjs`) append as
 * processes run; the harness appends the browser's events from the NetLog
 * once the browser server has stopped.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
  kind: 'start' | 'request' | 'dns' | 'connect';
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
}

/** One DNS query the namespace's resolver (`dns-log.mjs`) answered NXDOMAIN. */
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

export type NetworkEvent = NodeNetworkEvent | NamespaceDnsEvent | (BrowserEvent & { time: string });

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

/** Google hosts and the metadata server: every one is a finding in a builder run. */
export function isGoogleEvent(event: { google?: boolean; metadata?: boolean }): boolean {
  return event.google === true || event.metadata === true;
}
