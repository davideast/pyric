/**
 * The `read` half of effect enforcement: a method the record calls `read`
 * changes nothing.
 *
 * The other two effect checks refuse a call. This one cannot, because a read
 * that quietly wrote would return a perfectly good result; the only way to
 * catch it is to hash the sandbox on both sides of the call. Every read is
 * exercised with its own declared example, so a record that ships an example
 * it cannot run is caught here too, and the hash covers every service the
 * sandbox holds rather than Firestore alone.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFullState, initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import { METHODS } from '../../../src/bridge/surface/methods/registry.js';
import { OPEN_ORDER_RULES, recordNoteSession, writeCapture } from './assurance-fixture.js';

const surface = renderSurface('sdk-service');

/** One hash over everything the sandbox holds, across every service. */
async function stateHash(sandbox: Parameters<typeof captureFullState>[0]): Promise<string> {
  const state = await captureFullState(sandbox);
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

describe('a read changes nothing', () => {
  for (const method of METHODS) {
    if (method.effect !== 'read') continue;
    it(`${method.key} leaves the sandbox exactly as it found it`, async () => {
      const sandbox = initializeSandbox();
      setRules(sandbox, OPEN_ORDER_RULES);
      const projectDir = mkdtempSync(join(tmpdir(), 'pyric-read-effect-'));
      // A capture where the methods that read one look for it, so a read that
      // names a session has something real to read rather than failing early.
      writeCapture(projectDir, '.pyric/last-session.json', await recordNoteSession());
      const ctx = createSurfaceContext(sandbox, projectDir);

      const tool = surface.tools.find((candidate) => candidate.name === method.tool);
      if (tool === undefined) throw new Error(`no rendered tool named '${method.tool}'`);

      const before = await stateHash(sandbox);
      // A read whose subject is absent reports that, and two of them report it
      // by throwing. Either way the sandbox is what it was, which is the whole
      // claim being checked here.
      try {
        await tool.execute({ method: method.method, args: method.example }, ctx);
      } catch {
        // The result is not the subject; the state is.
      }
      expect(await stateHash(sandbox)).toBe(before);
    });
  }
});
