// Host writes during a run: each refuses a link a session could have
// planted, and leaves the link's target as it was.
import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFile, hostDirOf, HostFileError, makeHostDir, readRunFile, replaceFile, writeNewFile } from './host-files.ts';

/** A file of the host's a session would like overwritten, and a run directory with a link to it at `name`. */
function planted(name: string): { run: string; link: string; target: string } {
  const target = join(mkdtempSync(join(tmpdir(), 'factory-decoy-')), 'host-file');
  writeFileSync(target, 'the host’s own file');
  const run = mkdtempSync(join(tmpdir(), 'factory-run-'));
  const link = join(run, name);
  symlinkSync(target, link);
  return { run, link, target };
}

const unchanged = (target: string) => expect(readFileSync(target, 'utf8')).toBe('the host’s own file');

describe('host writes', () => {
  test('a new file refuses a link, or anything already there', () => {
    const { link, target } = planted('phase.json');
    expect(() => writeNewFile(link, 'x')).toThrow(HostFileError);
    unchanged(target);
  });

  test('an append refuses a link', () => {
    const { link, target } = planted('timeline.jsonl');
    expect(() => appendFile(link, 'x\n')).toThrow(HostFileError);
    unchanged(target);
  });

  test('a replace swaps the link for the new file, never writing through it', () => {
    const { link, target } = planted('latest-check.json');
    replaceFile(link, '{"passed":true}\n');
    unchanged(target);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, 'utf8')).toBe('{"passed":true}\n');
  });

  test('a read of a file sessions write refuses a link, a FIFO-like non-file, and reads a regular file', () => {
    const { run, link } = planted('work-list.json');
    expect(readRunFile(link)).toEqual({ ok: false, problem: 'it is a link' });
    expect(readRunFile(run)).toEqual({ ok: false, problem: 'it is not a regular file' });
    writeFileSync(join(run, 'progress.md'), 'notes');
    expect(readRunFile(join(run, 'progress.md'))).toEqual({ ok: true, text: 'notes' });
  });
});

describe('makeHostDir', () => {
  test('makes a directory beside the run directory, and refuses one inside it or reached through a link', () => {
    const run = mkdtempSync(join(tmpdir(), 'factory-run-'));
    const host = hostDirOf(run);
    expect(makeHostDir(join(host, 's', 'lead-1'), host, run)).toBe(join(host, 's', 'lead-1'));
    expect(() => makeHostDir(join(run, 'logs'), run, run)).toThrow(HostFileError);
    const elsewhere = mkdtempSync(join(tmpdir(), 'factory-elsewhere-'));
    symlinkSync(elsewhere, join(host, 'channel'));
    expect(() => makeHostDir(join(host, 'channel'), host, run)).toThrow('is not a directory of the harness\'s own');
    mkdirSync(join(host, 'logs'));
    expect(makeHostDir(join(host, 'logs'), host, run)).toBe(join(host, 'logs'));
  });
});
