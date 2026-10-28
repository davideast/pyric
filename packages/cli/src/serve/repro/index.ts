/**
 * `@pyric/cli/repro`: replay a repro file that `pyric serve repro capture`
 * wrote, so a bug found in a real project becomes a regression test.
 *
 * ```ts
 * import { readFileSync } from 'node:fs';
 * import { replayRepro } from '@pyric/cli/repro';
 *
 * const report = await replayRepro(JSON.parse(readFileSync('repro.json', 'utf8')));
 * assert.ok(report.ok, JSON.stringify(report.planes, null, 2));
 * ```
 *
 * The Node plane needs Node 22.15 or later, as the Node host does.
 */
export {
  replayRepro,
  type ReplayDivergence,
  type ReplayOperation,
  type ReplayPlaneDifference,
  type ReplayPlaneName,
  type ReplayPlaneReport,
  type ReplayReproOptions,
  type ReproReplayReport,
} from './replay.js';
export { parseRepro, REPRO_SCHEMA, type ReproBase, type ReproEntry, type ReproFile } from './format.js';
