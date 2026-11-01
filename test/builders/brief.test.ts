import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBrief, readBriefs, readBriefsDir, renderBrief } from './brief.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'briefs', 'brief-1.json');
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

function errorsFor(brief: Record<string, unknown>): string[] {
  const parsed = parseBrief(brief);
  return parsed.ok ? [] : parsed.errors;
}

describe('parseBrief', () => {
  test('accepts the fixture brief', () => {
    expect(parseBrief(fixture()).ok).toBe(true);
  });

  test('requires two to five must-be-refused lines', () => {
    const brief = fixture();
    const [first] = brief.mustBeRefused as unknown[];
    expect(errorsFor({ ...brief, mustBeRefused: [first] })).toEqual(['mustBeRefused: Array must contain at least 2 element(s)']);
    expect(errorsFor({ ...brief, mustBeRefused: Array.from({ length: 6 }, () => first) })).toEqual(['mustBeRefused: Array must contain at most 5 element(s)']);
  });

  test('takes a must-be-refused source only from firebase.google.com over https', () => {
    const brief = fixture();
    const line = { action: 'x', productionAnswer: 'denied' };
    for (const firebaseDoc of ['https://example.com/docs', 'http://firebase.google.com/docs', 'https://firebase.google.com.evil.dev/x', 'not a url']) {
      expect(errorsFor({ ...brief, mustBeRefused: [{ ...line, firebaseDoc }, { ...line, firebaseDoc }] })).toEqual([
        'mustBeRefused.0.firebaseDoc: must be an https://firebase.google.com/ page',
        'mustBeRefused.1.firebaseDoc: must be an https://firebase.google.com/ page',
      ]);
    }
  });

  test('takes one or two distinct stress dimensions from the five', () => {
    const brief = fixture();
    expect(errorsFor({ ...brief, stressDimensions: [] })).toEqual(['stressDimensions: Array must contain at least 1 element(s)']);
    expect(errorsFor({ ...brief, stressDimensions: ['scale', 'scale'] })).toEqual(['stressDimensions: must not repeat a dimension']);
    expect(errorsFor({ ...brief, stressDimensions: ['scale', 'lifecycle', 'combination'] })).toEqual(['stressDimensions: Array must contain at most 2 element(s)']);
    expect(errorsFor({ ...brief, stressDimensions: ['speed'] })[0]).toStartWith('stressDimensions.0: Invalid enum value');
  });

  test('takes only the three frameworks and an id of the form <round>-<n>', () => {
    const brief = fixture();
    expect(errorsFor({ ...brief, framework: 'astro' })[0]).toStartWith('framework: Invalid enum value');
    expect(errorsFor({ ...brief, id: 'fake' })).toEqual(['id: must be <round>-<n>']);
  });

  test('rejects a field the shape does not name, such as a model or a cap', () => {
    expect(errorsFor({ ...fixture(), model: 'claude-haiku' })).toEqual(["(top level): Unrecognized key(s) in object: 'model'"]);
    expect(errorsFor({ ...fixture(), limits: { wallClockMinutes: 10, maxBudgetUsd: 5 } })).toEqual(["limits: Unrecognized key(s) in object: 'maxBudgetUsd'"]);
  });
});

describe('readBriefs', () => {
  test('reads every brief and names each file with a problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'builders-briefs-'));
    writeFileSync(join(dir, 'brief-1.json'), readFileSync(FIXTURE));
    writeFileSync(join(dir, 'brief-2.json'), JSON.stringify({ ...fixture(), id: 'fake-2', appIdea: '' }));
    writeFileSync(join(dir, 'brief-3.json'), '{ not json');
    const { briefs, errors } = readBriefs(dir);
    expect(briefs.map((brief) => brief.id)).toEqual(['fake-1']);
    expect(errors[0]).toBe('brief-2.json: appIdea: String must contain at least 1 character(s)');
    expect(errors[1]).toStartWith('brief-3.json: not JSON');
  });

  test('fails a directory with no briefs, or two briefs with one id', () => {
    const empty = mkdtempSync(join(tmpdir(), 'builders-briefs-'));
    expect(readBriefs(empty).errors).toEqual([`no *.json briefs in ${empty}`]);
    const twice = mkdtempSync(join(tmpdir(), 'builders-briefs-'));
    writeFileSync(join(twice, 'a.json'), readFileSync(FIXTURE));
    writeFileSync(join(twice, 'b.json'), readFileSync(FIXTURE));
    expect(readBriefs(twice).errors).toEqual(['two briefs share an id: fake-1, fake-1']);
  });
});

describe('readBriefsDir', () => {
  test('gives the command that makes a missing briefs directory, and makes nothing', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'builders-briefs-')), 'briefs', 'r1');
    expect(readBriefsDir(dir)).toEqual({ briefs: [], errors: [`no briefs directory ${dir}: make it with \`mkdir -p ${dir}\` and write the round's briefs there`] });
    expect(existsSync(dir)).toBe(false);
  });
});

describe('renderBrief', () => {
  test('lays the brief out as the template does, with the run’s model and cap', () => {
    const parsed = parseBrief(fixture());
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const text = renderBrief(parsed.value, { model: 'claude-haiku-test', maxBudgetUsd: 2 });
    expect(text).toStartWith('Brief fake-1\nTarget area:        Storage rules on the Vite plugin plane\n');
    expect(text).toContain('Framework:          Vite\n');
    expect(text).toContain("                    - another user's write under the given rules (https://firebase.google.com/docs/storage/security/rules-conditions): storage/unauthorized\n");
    expect(text).toContain('                    - 3. Try to overwrite another user\'s photo\n');
    expect(text).toContain('Limits:             claude-haiku-test, $2, 10 minutes\n');
  });
});
