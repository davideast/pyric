/**
 * A sparse array read on a served plane keeps its holes, as production's
 * `val()` does (hunt finding RT-6, #1371). The Node host's transport carries
 * JSON, which turns each hole into `null`; the client turns those back into
 * holes, which is safe because RTDB never stores a `null` child.
 *
 * Each plane runs `sparse-array-probe.ts` in its own process: the worker plane
 * under Bun, the Node host under Node against the built `dist`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildForNode } from '../../rtdb-differential/differential.js';

const CLI_ROOT = resolve(import.meta.dir, '../../../..');
const PROBE = resolve(import.meta.dir, '../../rtdb-differential/sparse-array-probe.ts');
/** The probe's result line starts with this. */
const RESULT = 'sparse-array-probe: ';
const HOLE ={ isArray: true, length: 3, hasIndex1: false, first: 'a', last: 'c' };

let directory = '';
let nodeProbe = '';
/** Bundling the Node probe takes seconds on a loaded runner, past the 5 s default (#1593). */
const BUILD_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'pyric-sparse-probe-'));
  nodeProbe = await buildForNode(directory, 'sparse-array-probe.ts');
}, BUILD_TIMEOUT_MS);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function probe(plane: 'worker' | 'node'): Promise<unknown> {
  const command = plane === 'node'
    ? [process.env.PYRIC_TEST_NODE ?? 'node', nodeProbe, plane]
    : [process.execPath, PROBE, plane];
  const child = Bun.spawn(command, { cwd: CLI_ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${plane} probe exited ${code}: ${stderr.slice(-4000)}`);
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(RESULT));
  if (line === undefined) throw new Error(`${plane} probe printed no result: ${stdout.slice(-4000)}`);
  return JSON.parse(line.slice(RESULT.length));
}

describe('served sparse arrays keep their holes', () => {
  it.each(['worker', 'node'] as const)('on the %s plane, from get(), a parent get(), onValue and a transaction', async (plane) => {
    expect(await probe(plane)).toEqual({
      get: HOLE, nested: HOLE, onValue: HOLE, transactionInput: HOLE, transactionCommitted: true,
    });
  }, 60_000);
});
