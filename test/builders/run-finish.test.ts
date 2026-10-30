// The end of a run whose sandbox left a link where the harness reads or
// appends: the run still gets its record and its measurement line, and the
// harness touches nothing through the link.
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBrief } from './brief.ts';
import { readMeasurements } from './measurement.ts';
import { channelEvent } from './model-channel.ts';
import { builderRunDirsAt, type BuilderRunDirs } from './round-paths.ts';
import { finishRun, KEPT_PHASE_OUTPUT, RUN_PHASE_LOG, type FinishInput, type RunEnd } from './run-finish.ts';
import { BUILDER_LOG } from './run-phase.ts';
import type { RunRecord } from './run-record.ts';
import { createRunDirs } from './scratch.ts';
import { filesContaining } from './token-scan.ts';

const HOST_TEXT = 'host-file-text-the-harness-must-not-keep\n';
const UID = process.getuid?.() ?? -1;
const USAGE_LINE = JSON.stringify({ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.3, usage: { input_tokens: 1, output_tokens: 2 } });

function input(): FinishInput {
  const json = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'briefs', 'brief-1.json'), 'utf8')) as unknown;
  const brief = parseBrief(json);
  if (!brief.ok) throw new Error(brief.errors.join('\n'));
  return {
    identity: { run: 'fake-1-haiku', round: 'fake', brief: 'fake-1', model: 'haiku', builder: 'script', maxBudgetUsd: 1, wallClockMinutes: 10 },
    brief: brief.value,
    provenance: { commit: 'abc', dirty: false, tarballs: {} },
    scanned: [],
    say: () => {},
  };
}

/** A run root as a builder left it, with a host file beside it. */
function plainRun(): { dirs: BuilderRunDirs; outside: string; end: RunEnd } {
  const base = mkdtempSync(join(tmpdir(), 'run-finish-'));
  const outside = join(base, 'host-file');
  writeFileSync(outside, HOST_TEXT);
  const dirs = builderRunDirsAt(join(base, 'run'));
  createRunDirs(dirs.root);
  writeFileSync(join(dirs.logs, BUILDER_LOG), `${USAGE_LINE}\n`);
  writeFileSync(dirs.briefJson, '{}\n');
  const outcome = { action: 'forwarded', reason: null, status: 200, usage: undefined, costUsd: 0.25, reservedUsd: 0.25, chargedUsd: 0.25 } as const;
  const channel = [channelEvent('api.anthropic.com', 'POST /v1/messages HTTP/1.1', undefined, outcome)];
  const end: RunEnd = { dirs, channel, phaseOutput: 'phase output\n', startedAt: new Date(), dataDir: join(base, 'data', 'run'), measurements: join(base, 'data', 'measurements.jsonl') };
  return { dirs, outside, end };
}

/** A run root whose `network.jsonl` and run-phase log the sandbox replaced with links to a host file. */
function plantedRun(): { dirs: BuilderRunDirs; outside: string; end: RunEnd } {
  const run = plainRun();
  const { dirs, outside } = run;
  renameSync(dirs.networkLog, `${dirs.networkLog}.was`);
  symlinkSync(outside, dirs.networkLog);
  symlinkSync(outside, join(dirs.logs, RUN_PHASE_LOG));
  return run;
}

describe('finishRun on a planted link', () => {
  test('keeps the record naming the planted paths, and appends the measurement line', async () => {
    const { outside, end } = plantedRun();
    const record = await finishRun(input(), end);
    expect(record.harness.plantedLinks).toEqual(['logs/02-run-phase.log: logs/02-run-phase.log is a link', 'network.jsonl: network.jsonl is a link']);
    expect(readFileSync(outside, 'utf8')).toBe(HOST_TEXT);

    const kept = JSON.parse(readFileSync(join(end.dataDir, 'report.json'), 'utf8')) as RunRecord;
    expect(kept.harness.plantedLinks).toEqual(record.harness.plantedLinks);
    expect(kept.harness.meteredCostUsd).toBe(0.25);
    expect(kept.harness.usage?.costUsd).toBe(0.3);
    expect(existsSync(join(end.dataDir, 'network.jsonl'))).toBe(false);
    expect(readFileSync(join(end.dataDir, KEPT_PHASE_OUTPUT), 'utf8')).toBe('phase output\n');

    const { lines, errors } = readMeasurements(end.measurements);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'builder', run: 'fake-1-haiku', meteredCostUsd: 0.25, costUsd: 0.3 });
  });

  test('reads none of a run root whose report and logs directory are links, and still keeps it', async () => {
    const { dirs, outside, end } = plantedRun();
    renameSync(dirs.logs, `${dirs.logs}.was`);
    symlinkSync(join(outside, '..'), dirs.logs);
    symlinkSync(outside, dirs.report);
    const record = await finishRun(input(), end);
    expect(record.harness.plantedLinks).toEqual(['logs/02-run-phase.log: logs is a link', 'logs/builder.log: logs is a link', 'network.jsonl: network.jsonl is a link', 'report.json: report.json is a link']);
    expect(record.harness.report).toEqual({ state: 'invalid', errors: ['report.json is a planted link; the harness did not read it'] });
    expect(record.harness.usage).toBeNull();
    expect(readFileSync(outside, 'utf8')).toBe(HOST_TEXT);
    expect(readFileSync(join(end.dataDir, KEPT_PHASE_OUTPUT), 'utf8')).toBe('phase output\n');
    expect(readMeasurements(end.measurements).lines).toHaveLength(1);
  });

  test('keeps the measurement, and nothing of the host, when a directory sits at the run-phase log', async () => {
    const { dirs, end } = plantedRun();
    const phaseLog = join(dirs.logs, RUN_PHASE_LOG);
    renameSync(phaseLog, `${phaseLog}.was`);
    mkdirSync(phaseLog);
    symlinkSync(join(dirs.root, '..', 'host-file'), join(phaseLog, 'inside'));
    const record = await finishRun(input(), end);
    expect(record.harness.plantedLinks).toEqual(['logs/02-run-phase.log: logs/02-run-phase.log is not a plain file', 'network.jsonl: network.jsonl is a link']);
    expect(readMeasurements(end.measurements).lines).toHaveLength(1);
    expect(readFileSync(join(end.dataDir, KEPT_PHASE_OUTPUT), 'utf8')).toBe('phase output\n');
    expect(existsSync(join(end.dataDir, 'logs', RUN_PHASE_LOG))).toBe(false);
    expect(filesContaining(end.dataDir, HOST_TEXT.trim())).toEqual([]);
  });

  test('finds the token in the phase output of a planted run, and keeps it redacted', async () => {
    const { end } = plantedRun();
    const secret = 'made-up-token-in-the-phase-output';
    const record = await finishRun({ ...input(), scanned: [secret] }, { ...end, phaseOutput: `said ${secret}\n` });
    expect(record.harness.tokenFoundIn).toContain(KEPT_PHASE_OUTPUT);
    expect(filesContaining(end.dataDir, secret)).toEqual([]);
  });
});

/**
 * The sandbox's uid 0 is the harness's own uid, so a builder can take the
 * owner's permissions away from anything in the run root. As uid 0 the
 * harness reads through them anyway, so these run only as another user.
 */
describe.skipIf(UID === 0)('finishRun on a run root whose permissions the builder changed', () => {
  test('keeps a chmod 000 file under logs/', async () => {
    const { dirs, end } = plantedRun();
    const locked = join(dirs.logs, 'locked.log');
    writeFileSync(locked, 'locked\n');
    chmodSync(locked, 0o000);
    await finishRun(input(), end);
    expect(readMeasurements(end.measurements).lines).toHaveLength(1);
    expect(readFileSync(join(end.dataDir, 'logs', 'locked.log'), 'utf8')).toBe('locked\n');
  });

  test('keeps the measurement and the logs when logs/ is chmod 000', async () => {
    const { dirs, end } = plainRun();
    chmodSync(dirs.logs, 0o000);
    const record = await finishRun(input(), end);
    expect(readMeasurements(end.measurements).lines).toHaveLength(1);
    expect(record.harness.usage?.costUsd).toBe(0.3);
    expect(readFileSync(join(end.dataDir, 'logs', RUN_PHASE_LOG), 'utf8')).toBe('phase output\n');
  });

  test('merges into a chmod 444 network.jsonl', async () => {
    const { dirs, end } = plainRun();
    chmodSync(dirs.networkLog, 0o444);
    const record = await finishRun(input(), end);
    expect(readMeasurements(end.measurements).lines).toHaveLength(1);
    expect(record.harness.meteredCostUsd).toBe(0.25);
    expect(readFileSync(join(end.dataDir, 'network.jsonl'), 'utf8')).toContain('"layer":"model-channel"');
  });

  test('writes the run-phase log into a chmod 555 logs/', async () => {
    const { dirs, end } = plainRun();
    chmodSync(dirs.logs, 0o555);
    await finishRun(input(), end);
    expect(readMeasurements(end.measurements).lines).toHaveLength(1);
    expect(readFileSync(join(end.dataDir, 'logs', RUN_PHASE_LOG), 'utf8')).toBe('phase output\n');
  });
});
