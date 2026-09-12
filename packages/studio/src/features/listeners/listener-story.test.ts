/** The Listeners journal header's two sentences. */
import { describe, expect, it } from 'bun:test';
import { listenerStory, type ListenerFold } from './listener-story.js';

function fold(overrides: Partial<ListenerFold> = {}): ListenerFold {
  return { listeners: 0, idle: 0, duplicates: [], churn: 0, ...overrides };
}

describe('the headline', () => {
  it('states how many listeners are attached', () => {
    expect(listenerStory(fold({ listeners: 9 })).headline).toBe('9 listeners attached');
    expect(listenerStory(fold({ listeners: 1 })).headline).toBe('1 listener attached');
  });

  it('names a duplicate ahead of the plain count', () => {
    expect(
      listenerStory(fold({ listeners: 9, duplicates: [{ target: 'conversations', count: 2 }] }))
        .headline,
    ).toBe('9 listeners, 1 attached more than once');
  });

  it('names churn when nothing is duplicated', () => {
    expect(listenerStory(fold({ listeners: 9, churn: 2 })).headline).toBe(
      '9 listeners, 2 reattaching repeatedly',
    );
  });

  it('says so when nothing is attached', () => {
    const story = listenerStory(fold());
    expect(story.headline).toBe('No listeners attached');
    expect(story.finding).toBe('Listeners the app attaches appear here as it opens them.');
  });
});

describe('the finding', () => {
  it('names the owner holding the most, then the duplicate', () => {
    expect(
      listenerStory(
        fold({
          listeners: 9,
          busiest: { label: 'ChatPage', count: 7 },
          duplicates: [{ target: 'conversations (query)', count: 2 }],
        }),
      ).finding,
    ).toBe('ChatPage holds 7. conversations (query) is attached twice.');
  });

  it('counts a duplicate attached more than twice', () => {
    expect(
      listenerStory(fold({ listeners: 4, duplicates: [{ target: 'notes', count: 3 }] })).finding,
    ).toBe('notes is attached 3 times.');
  });

  it('reports the absence of incidents with the idle count', () => {
    expect(listenerStory(fold({ listeners: 9, idle: 3 })).finding).toBe(
      'No incidents. 3 listeners have not delivered in this window.',
    );
    expect(listenerStory(fold({ listeners: 9, idle: 1 })).finding).toBe(
      'No incidents. 1 listener has not delivered in this window.',
    );
  });

  it('stops at the absence of incidents when every listener delivered', () => {
    expect(listenerStory(fold({ listeners: 9 })).finding).toBe('No incidents.');
  });

  it('leaves an owner holding one listener out of the sentence', () => {
    expect(
      listenerStory(fold({ listeners: 1, busiest: { label: 'ChatPage', count: 1 } })).finding,
    ).toBe('No incidents.');
  });

  it('reports churn when nothing is duplicated', () => {
    expect(listenerStory(fold({ listeners: 3, churn: 2 })).finding).toBe(
      '2 listeners reattached repeatedly.',
    );
  });
});
