/**
 * The one sandbox, context, and rules sources the handler suite exercises
 * every method record against.
 *
 * Held apart from the suite so the suite is the assertions and nothing else.
 * A single sandbox is deliberate: the methods compose, and a suite that reset
 * between them would exercise each handler against a state no session ever
 * has.
 */
import 'fake-indexeddb/auto';
import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import { METHODS } from '../../../src/bridge/surface/methods/registry.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';

export const TENANT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tenants/{docId} {
      allow read, write: if request.auth.token.firebase.tenant == 'tenant-a';
    }
  }
}`;

export const DATABASE_RULES = JSON.stringify({ rules: { '.read': true, '.write': true } });

export const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

export const SIGNED_IN_ONLY_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

export const sandbox = initializeSandbox();
setRules(sandbox, TENANT_RULES);

export const surface = renderSurface(undefined);

/**
 * A project directory of its own, because the methods that reach the file
 * system must not leave `.pyric/` behind in the package this suite runs from.
 */
export const projectDir = mkdtempSync(join(tmpdir(), 'pyric-handlers-'));
export const ctx: SurfaceContext = createSurfaceContext(sandbox, projectDir);

/** Every method key the suite has called, checked for completeness at the end. */
export const exercised = new Set<string>();

/**
 * The suites that together exercise every method record.
 *
 * The coverage check has to run after all of them, and a test runner gives no
 * ordering guarantee across files, so each suite reports when it is done and
 * whichever reports last runs the check. Adding a suite here without adding
 * its `finishHandlerSuite` call leaves the check unrun, which is why the list
 * is short and lives beside the set it guards.
 */
// Each entry names a handler suite file; a service's depth methods get their
// own suite rather than growing `handlers.test.ts` past the file-size limit.
const SUITES: readonly string[] = [
  'services',
  'assurance',
  'storage',
  'firestore-depth',
  'messaging',
  'functions',
  'ai-logic',
  'sandbox-listeners',
];
const finished = new Set<string>();

/** Call one method through its service tool and record that it ran. */
export async function run(
  key: string,
  args: Record<string, unknown> = {},
): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  exercised.add(key);
  return tool.execute({ method, args }, ctx);
}

/**
 * Report that one suite is done. The last one to report checks that every
 * method record was exercised and clears the project directory.
 */
export function finishHandlerSuite(name: string): void {
  if (!SUITES.includes(name)) throw new Error(`'${name}' is not one of the handler suites`);
  finished.add(name);
  if (finished.size < SUITES.length) return;
  expect([...exercised].sort()).toEqual(METHODS.map((method) => method.key).sort());
  rmSync(projectDir, { recursive: true, force: true });
}
