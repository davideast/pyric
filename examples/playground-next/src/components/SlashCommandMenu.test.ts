/**
 * Slash-command pure helpers — token detection, filtering, stripping.
 * (Keyboard/menu behavior is exercised live via Playwright.)
 */
import { describe, expect, test } from 'bun:test';
import { filterSlashItems, slashTokenAt, stripSlashToken } from './SlashCommandMenu';

const ITEMS = [
  { id: 'game-rules', icon: 'x', label: 'Game rules', description: 'turn-based games' },
  { id: 'audit', icon: 'x', label: 'Audit', description: 'inspect the rules of a project' },
];

describe('slashTokenAt', () => {
  test('detects / at the start of the input', () => {
    expect(slashTokenAt('/', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(slashTokenAt('/ga', 3)).toEqual({ start: 0, end: 3, query: 'ga' });
  });

  test('detects / after whitespace mid-prompt', () => {
    const v = 'build chess /game';
    expect(slashTokenAt(v, v.length)).toEqual({ start: 12, end: 17, query: 'game' });
  });

  test('ignores slashes inside words and paths', () => {
    const path = 'read src/App.tsx';
    expect(slashTokenAt(path, path.length)).toBeNull();
    const url = 'https://example.com/x';
    expect(slashTokenAt(url, url.length)).toBeNull();
  });

  test('caret outside the token → no match', () => {
    // Caret in the leading word, token later in the string.
    expect(slashTokenAt('hello /game', 3)).toBeNull();
  });
});

describe('filterSlashItems', () => {
  test('empty query returns all; prefix beats substring', () => {
    expect(filterSlashItems(ITEMS, '').length).toBe(2);
    expect(filterSlashItems(ITEMS, 'ga')[0]!.id).toBe('game-rules');
    // 'rules' substring-matches both (id + description) — registry order kept.
    expect(filterSlashItems(ITEMS, 'rules').map((i) => i.id)).toEqual(['game-rules', 'audit']);
  });

  test('no match → empty', () => {
    expect(filterSlashItems(ITEMS, 'zzz')).toEqual([]);
  });
});

describe('stripSlashToken', () => {
  test('removes the token and collapses the following space', () => {
    const v = '/game build chess';
    const token = slashTokenAt(v, 5)!;
    expect(stripSlashToken(v, token)).toBe('build chess');
  });

  test('mid-prompt token removal keeps surrounding text', () => {
    const v = 'build chess /game please';
    const token = slashTokenAt(v, 17)!;
    expect(stripSlashToken(v, token)).toBe('build chess please');
  });
});
