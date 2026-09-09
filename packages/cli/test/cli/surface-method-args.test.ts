/**
 * How a command line spells one record's arguments, including the file
 * convention: any string or object argument `--<arg>` may instead be supplied
 * as `--<arg>-file <path>`, and the file is read as that argument's kind.
 *
 * A ruleset, a seed, and a document body are all things a project keeps in a
 * file, and a shell that has to inline one loses the newlines a rules source
 * needs. The convention is the CLI's, not the record's: it is derived from the
 * argument names a record already declares, so a new record gets it for free
 * and no record mentions it.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'bun:test';

import { argumentsFromFlags } from '../../src/cli/surface-method-args.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { methodByKey } from '../../src/bridge/surface/methods/registry.js';

const workDir = mkdtempSync(join(tmpdir(), 'pyric-surface-args-'));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const RULES = ["rules_version = '2';", 'service cloud.firestore {', '}'].join('\n');
writeFileSync(join(workDir, 'firestore.rules'), RULES, 'utf8');
writeFileSync(join(workDir, 'post.json'), '{"title":"Hello"}\n', 'utf8');
writeFileSync(join(workDir, 'broken.json'), 'not json at all', 'utf8');

/** The arguments one command line carries, read against one record. */
function argsFor(key: string, argv: string[]) {
  return argumentsFromFlags(methodByKey(key), parseArgs(argv), workDir);
}

describe('--<arg>-file', () => {
  it('reads a string argument from a file, newlines and all', () => {
    const read = argsFor('rules.lint', [
      'rules',
      'lint',
      '--service',
      'firestore',
      '--rules-file',
      'firestore.rules',
    ]);
    expect(read).toEqual({ args: { service: 'firestore', rules: RULES } });
  });

  it('parses an object argument read from a file', () => {
    const read = argsFor('firestore.setDoc', [
      'firestore',
      'setDoc',
      '--path',
      'posts/p1',
      '--data-file',
      'post.json',
    ]);
    expect(read).toEqual({ args: { path: 'posts/p1', data: { title: 'Hello' } } });
  });

  it('takes an absolute path as written', () => {
    const read = argsFor('rules.lint', [
      'rules',
      'lint',
      '--service',
      'firestore',
      '--rules-file',
      join(workDir, 'firestore.rules'),
    ]);
    expect(read).toEqual({ args: { service: 'firestore', rules: RULES } });
  });

  it('refuses a file that does not parse as the argument expects', () => {
    const read = argsFor('firestore.setDoc', [
      'firestore',
      'setDoc',
      '--path',
      'posts/p1',
      '--data-file',
      'broken.json',
    ]);
    expect(read).toHaveProperty('error');
    expect((read as { error: string }).error).toContain('broken.json');
    expect((read as { error: string }).error).toContain('JSON');
  });

  it('refuses a file it cannot read, naming the path', () => {
    const read = argsFor('rules.lint', ['rules', 'lint', '--rules-file', 'absent.rules']);
    expect(read).toHaveProperty('error');
    expect((read as { error: string }).error).toContain('absent.rules');
  });

  it('refuses an argument supplied both inline and from a file', () => {
    const read = argsFor('rules.lint', [
      'rules',
      'lint',
      '--rules',
      'inline',
      '--rules-file',
      'firestore.rules',
    ]);
    expect(read).toHaveProperty('error');
    expect((read as { error: string }).error).toContain('--rules');
  });

  it('refuses a file for an argument that is a number or a boolean', () => {
    const read = argsFor('sandbox.reset', ['sandbox', 'reset', '--confirm-file', 'post.json']);
    expect(read).toHaveProperty('error');
    expect((read as { error: string }).error).toContain('--confirm');
  });

  it('refuses a file flag for an argument the record does not declare', () => {
    const read = argsFor('firestore.getDoc', ['firestore', 'getDoc', '--document-file', 'x']);
    expect(read).toHaveProperty('error');
    expect((read as { error: string }).error).toContain('--document-file');
  });
});
