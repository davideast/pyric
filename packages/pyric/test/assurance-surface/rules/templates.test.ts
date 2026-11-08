import { describe, expect, test } from 'bun:test';
import { covers, parseTemplate, renderTemplate, shapeKey } from '../../../src/assurance-surface/rules/templates.js';

describe('templates', () => {
  test('parse both syntaxes', () => {
    expect(parseTemplate('/a/$b/{c}/{d=**}')).toEqual([
      { kind: 'lit', text: 'a' },
      { kind: 'var', name: 'b' },
      { kind: 'var', name: 'c' },
      { kind: 'rest', name: 'd' },
    ]);
  });

  test('a rule variable matches any segment; a client variable does not match a rule literal', () => {
    expect(covers(parseTemplate('ws/{w}/msgs/{m}'), parseTemplate('ws/orbit/msgs/{id}'), false)).toBe(true);
    expect(covers(parseTemplate('ws/orbit/msgs/{m}'), parseTemplate('ws/{w}/msgs/{id}'), false)).toBe(false);
  });

  test('prefix coverage for cascading rules, and recursive wildcards', () => {
    expect(covers(parseTemplate('tokens/$uid'), parseTemplate('tokens/$u/$device'), true)).toBe(true);
    expect(covers(parseTemplate('tokens/$uid'), parseTemplate('tokens/$u/$device'), false)).toBe(false);
    expect(covers(parseTemplate('scenarios/{d=**}'), parseTemplate('scenarios/a/b/c'), false)).toBe(true);
  });

  test('render and shape keys erase variable names', () => {
    expect(renderTemplate(parseTemplate('a/{b}'), 'rtdb')).toBe('a/$b');
    expect(shapeKey('a/$b/{c=**}')).toBe(shapeKey('a/{x}/{y=**}'));
  });
});
