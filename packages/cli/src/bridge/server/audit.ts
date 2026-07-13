/**
 * Audit log writer. Every sandbox bridge tool call appends
 * one JSON line to the project's events.ndjson file.
 *
 * Audit events land at the project's conventional location:
 *   `~/.pyric/projects/<projectId>/events.ndjson`
 *
 * The bridge passes its `BridgeToolEvent` here through `onToolEvent`.
 * Writes are best-effort — failure to log must not break tool
 * dispatch.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import type { BridgeToolEvent } from './bridge.js';

export interface AuditWriter {
  write(event: BridgeToolEvent): void;
  /** Filesystem path of the active log. */
  readonly path: string;
}

export function createAuditWriter(project: string): AuditWriter {
  const dir = join(homedir(), '.pyric', 'projects', sanitiseProjectId(project));
  const path = join(dir, 'events.ndjson');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    // If we can't create the directory, fall back to silent no-op.
    return {
      write: () => {},
      path,
    };
  }
  return {
    path,
    write(event: BridgeToolEvent) {
      try {
        const line = JSON.stringify(event) + '\n';
        appendFileSync(path, line, { encoding: 'utf8' });
      } catch {
        // Drop the entry; tool dispatch continues.
      }
    },
  };
}

function sanitiseProjectId(value: string): string {
  // Project ids are normally alphanumeric + dash; defend against
  // path traversal just in case (someone passes `../etc` etc.).
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}
