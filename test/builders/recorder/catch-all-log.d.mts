/** Types for `catch-all-log.mjs`, which Node runs as plain JavaScript inside a run's sandbox. */
import type { Server } from 'node:net';
import type { NamespaceConnectEvent } from './network-record.ts';

export const CATCH_ALL_PORTS: number[];
export function plainAddress(address: string): string;
export function connectEvent(address: string, port: number, time?: Date): NamespaceConnectEvent;
export function serveCatchAll(logPath: string): Promise<Server[]>;
