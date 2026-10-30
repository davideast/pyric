import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeRecords, readPhaseResult } from './run-finish.ts';
import { channelEvent } from './model-channel.ts';
import { assertNoPlantedLinks, PlantedLink, plantedLinkProblem } from './planted-links.ts';
import { tryEvidence } from './reproduce.ts';
import { builderRunDirsAt } from './round-paths.ts';
import { createRunDirs } from './scratch.ts';

/** A run root whose `network.jsonl` the sandbox replaced with a link to a host file. */
function plantedRun(): { root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'planted-'));
  const outside = join(base, 'host-file');
  writeFileSync(outside, 'host\n');
  const root = join(base, 'run');
  const dirs = createRunDirs(root);
  const networkLog = dirs.networkLog;
  Bun.spawnSync(['mv', networkLog, `${networkLog}.was`]);
  symlinkSync(outside, networkLog);
  return { root, outside };
}

describe('plantedLinkProblem', () => {
  test('passes a plain file or an absent one, inside the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'planted-'));
    mkdirSync(join(root, 'logs'));
    writeFileSync(join(root, 'logs', 'a.log'), '');
    expect(plantedLinkProblem(root, join(root, 'logs', 'a.log'))).toBeUndefined();
    expect(plantedLinkProblem(root, join(root, 'logs', 'absent.log'))).toBeUndefined();
    expect(plantedLinkProblem(root, join(root, '..', 'elsewhere'))).toContain('is not inside the run root');
  });

  test('refuses a link at the file or at any directory on the way to it', () => {
    const base = mkdtempSync(join(tmpdir(), 'planted-'));
    const root = join(base, 'run');
    mkdirSync(root);
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'builder.log'), 'host\n');
    symlinkSync(elsewhere, join(root, 'logs'));
    symlinkSync(join(elsewhere, 'builder.log'), join(root, 'report.json'));
    mkdirSync(join(root, 'netlog-dir'));
    expect(plantedLinkProblem(root, join(root, 'logs', 'builder.log'))).toBe(`${join(root, 'logs')} is a link`);
    expect(plantedLinkProblem(root, join(root, 'report.json'))).toBe(`${join(root, 'report.json')} is a link`);
    expect(plantedLinkProblem(root, join(root, 'netlog-dir'))).toContain('is not a plain file');
    expect(() => assertNoPlantedLinks(root, [join(root, 'report.json')])).toThrow(PlantedLink);
  });
});

describe.skipIf((process.getuid?.() ?? -1) === 0)('plantedLinkProblem on a directory it cannot search', () => {
  test('names the path it could not check, instead of throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'planted-'));
    mkdirSync(join(root, 'logs'));
    chmodSync(join(root, 'logs'), 0o000);
    try {
      expect(plantedLinkProblem(root, join(root, 'logs', 'builder.log'))).toBe(`${join(root, 'logs', 'builder.log')} could not be checked (EACCES)`);
    } finally {
      chmodSync(join(root, 'logs'), 0o700);
    }
  });
});

describe('a link to a file outside the run root', () => {
  test('stops a round\'s run before it appends the forwarder\'s record', () => {
    const { root, outside } = plantedRun();
    const outcome = { action: 'forwarded', reason: null, status: 200, usage: undefined, costUsd: 0, reservedUsd: 0, chargedUsd: 0 } as const;
    const channel = [channelEvent('api.anthropic.com', 'POST /v1/messages HTTP/1.1', undefined, outcome)];
    expect(() => mergeRecords(builderRunDirsAt(root), channel)).toThrow(PlantedLink);
    expect(readFileSync(outside, 'utf8')).toBe('host\n');
  });

  test('stops a reproduction\'s try before it reads or appends anything', () => {
    const { root, outside } = plantedRun();
    expect(() => tryEvidence(builderRunDirsAt(root), 'phase output')).toThrow(PlantedLink);
    expect(readFileSync(outside, 'utf8')).toBe('host\n');
  });
});

describe('readPhaseResult', () => {
  test('a phase result that is not JSON reads as none', () => {
    const dirs = createRunDirs(mkdtempSync(join(tmpdir(), 'phase-result-')));
    writeFileSync(builderRunDirsAt(dirs.root).phaseResult, '{not json');
    expect(readPhaseResult(builderRunDirsAt(dirs.root))).toBeNull();
  });
});
