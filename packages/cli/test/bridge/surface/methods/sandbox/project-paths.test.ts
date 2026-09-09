/**
 * The three sandbox methods that name a file agree on what a path may be.
 *
 * `apply`, `exportFixture`, and `seedFromFixture` each take a path from the
 * caller and read or write it. They had two rules between them, so an absolute
 * path inside the project was a fixture the surface would write and a session
 * it would refuse. One rule now: relative or absolute, the path has to resolve
 * inside the project directory, and one that climbs out is refused by name.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';

const surface = renderSurface(undefined);

let projectDir: string;
let outsideDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;

async function run(key: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-project-paths-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'pyric-outside-'));
  sandbox = initializeSandbox();
  ctx = createSurfaceContext(sandbox, projectDir);
  await run('sandbox.fork', { branch: 'draft' });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

/** A recorded session file, written where a call is about to name it. */
function plantSession(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ events: [] }), 'utf8');
}

/** The three calls, each one naming the path under the argument it takes it as. */
const CALLS: ReadonlyArray<{ key: string; argument: string; extra: Record<string, unknown> }> = [
  { key: 'sandbox.apply', argument: 'sessionPath', extra: { branch: 'draft' } },
  { key: 'sandbox.exportFixture', argument: 'path', extra: {} },
  { key: 'sandbox.seedFromFixture', argument: 'path', extra: {} },
];

describe('a path a sandbox method names', () => {
  for (const call of CALLS) {
    it(`${call.key} refuses a relative path that climbs out of the project`, async () => {
      const refused = await run(call.key, { ...call.extra, [call.argument]: '../outside.json' });
      expect(refused.ok).toBe(false);
      expect(refused.summary).toContain(call.argument);
    });

    it(`${call.key} refuses an absolute path outside the project`, async () => {
      const outside = join(outsideDir, 'outside.json');
      const refused = await run(call.key, { ...call.extra, [call.argument]: outside });
      expect(refused.ok).toBe(false);
      expect(refused.summary).toContain(call.argument);
    });

    it(`${call.key} accepts an absolute path inside the project`, async () => {
      const inside = resolve(projectDir, 'state', 'inside.json');
      if (call.key !== 'sandbox.exportFixture') {
        plantSession(inside);
      }
      const accepted = await run(call.key, { ...call.extra, [call.argument]: inside });
      expect(accepted.ok).toBe(true);
    });
  }
});
