import { describe, expect, test } from 'bun:test';

import { suggestRepoNameFromPrompt } from './suggest-repo-name';

describe('suggestRepoNameFromPrompt', () => {
  test('a repo name is an identity, not a summary — content words only, capped', () => {
    expect(suggestRepoNameFromPrompt('Build a todo app with auth')).toBe('todo-auth');
    const long = suggestRepoNameFromPrompt(
      'A turn-based multiplayer JRPG grid race where players alternate turns moving toward a finish line.',
    );
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.split('-').length).toBeLessThanOrEqual(5);
  });

  test('prefers a name the prompt declares (called/named/quoted)', () => {
    expect(
      suggestRepoNameFromPrompt(
        'Create a top-down JRPG style game called Math Quest. Players are on a town map…',
      ),
    ).toBe('math-quest');
    expect(suggestRepoNameFromPrompt('An app named Fridge Poet for magnetic poetry')).toBe(
      'fridge-poet',
    );
    expect(suggestRepoNameFromPrompt('Build "Space Lobby" — a chat for astronauts')).toBe(
      'space-lobby',
    );
  });

  test('never emits punctuation runs (the -.- bug)', () => {
    const s = suggestRepoNameFromPrompt('game called math quest . players move');
    expect(s).toBe('math-quest');
    expect(s).not.toMatch(/[-.]{2,}/);
  });

  test('trims and collapses punctuation', () => {
    expect(suggestRepoNameFromPrompt('  Hello---World!!!  ')).toBe('hello-world');
  });

  test('falls back when prompt yields nothing usable', () => {
    expect(suggestRepoNameFromPrompt('...')).toBe('playground-project');
    expect(suggestRepoNameFromPrompt('')).toBe('playground-project');
    expect(suggestRepoNameFromPrompt('create a simple app')).toBe('playground-project');
  });
});
