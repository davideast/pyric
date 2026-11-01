/** Types for `dns-log.mjs`, which Node runs as plain JavaScript inside a run's namespace. */
import type { NamespaceDnsEvent } from './network-record.ts';

export interface DnsQuestion {
  id: number;
  name: string;
  type: string;
  /** Where the question ends in the message. */
  end: number;
}

export function parseQuestion(message: Buffer): DnsQuestion | null;
export function nxdomainFor(message: Buffer, question: DnsQuestion): Buffer;
export function queryEvent(question: Pick<DnsQuestion, 'name' | 'type'>, time?: Date): NamespaceDnsEvent;
export function serveDns(logPath: string): Promise<import('node:dgram').Socket>;
