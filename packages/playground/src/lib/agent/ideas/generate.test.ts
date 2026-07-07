import { describe, expect, test } from 'bun:test';
import { parseIdeasResponse } from './generate';

const ok = JSON.stringify([
  { icon: 'forum', title: 'Realtime chat', tagline: 'live messages', examplePrompt: 'Build a chat room.' },
  { icon: 'leaderboard', title: 'Leaderboard', tagline: 'scores', examplePrompt: 'Add a leaderboard.' },
]);

describe('parseIdeasResponse', () => {
  test('parses a bare JSON array', () => {
    const ideas = parseIdeasResponse(ok);
    expect(ideas).toHaveLength(2);
    expect(ideas[0]!.title).toBe('Realtime chat');
    expect(ideas[0]!.icon).toBe('forum');
    expect(ideas[0]!.examplePrompt).toBe('Build a chat room.');
  });

  test('tolerates ```json code fences', () => {
    expect(parseIdeasResponse('```json\n' + ok + '\n```')).toHaveLength(2);
  });

  test('tolerates prose wrapped around the array', () => {
    expect(parseIdeasResponse(`Here are some ideas:\n${ok}\nHope that helps!`)).toHaveLength(2);
  });

  test('drops entries missing title or examplePrompt', () => {
    const mixed = JSON.stringify([
      { icon: 'forum', title: 'Good', tagline: 't', examplePrompt: 'do it' },
      { icon: 'forum', tagline: 'no title' },
      { title: 'no prompt' },
    ]);
    const ideas = parseIdeasResponse(mixed);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.title).toBe('Good');
  });

  test('unknown icon falls back to bolt', () => {
    const ideas = parseIdeasResponse(
      JSON.stringify([{ icon: 'not_a_real_icon', title: 'X', tagline: 't', examplePrompt: 'p' }]),
    );
    expect(ideas[0]!.icon).toBe('bolt');
  });

  test('caps at 5 ideas', () => {
    const many = JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({
        icon: 'bolt', title: `Idea ${i}`, tagline: 't', examplePrompt: 'p',
      })),
    );
    expect(parseIdeasResponse(many)).toHaveLength(5);
  });

  test('returns [] on garbage / no array', () => {
    expect(parseIdeasResponse('sorry, I cannot help')).toEqual([]);
    expect(parseIdeasResponse('{ not: an array }')).toEqual([]);
    expect(parseIdeasResponse('')).toEqual([]);
  });

  test('AI ideas carry no builds bullets (drill-in shows tagline)', () => {
    const ideas = parseIdeasResponse(ok);
    expect(ideas[0]!.builds).toEqual([]);
  });
});
