/** The element label read off a listener's owners. */
import { describe, expect, it } from 'bun:test';
import type { ListenerOwner } from 'pyric/sandbox';
import { elementLabel } from './listener-element.js';

describe('elementLabel', () => {
  it('joins the tag the owners name to the element’s id', () => {
    const owners: ListenerOwner[] = [
      { kind: 'tag', name: 'nav', element: '#conversations' },
    ];
    expect(elementLabel(owners)).toBe('nav#conversations');
  });

  it('keeps a tag and its first class', () => {
    const owners: ListenerOwner[] = [
      { kind: 'component', name: 'ChatPage', element: 'div.conversation.active' },
    ];
    expect(elementLabel(owners)).toBe('div.conversation');
  });

  it('reads the tag out of a generated attribute selector', () => {
    const owners: ListenerOwner[] = [
      { kind: 'component', name: 'ChatPage', element: '[data-pyric-owner="nav-3"]' },
    ];
    expect(elementLabel(owners)).toBe('nav');
  });

  it('prefers the tag the owners state over the minted prefix', () => {
    const owners: ListenerOwner[] = [
      { kind: 'component', name: 'ChatPage', element: '[data-pyric-owner="sidebar"]' },
      { kind: 'tag', name: 'aside' },
    ];
    expect(elementLabel(owners)).toBe('aside');
  });

  it('takes the element a structural path ends at, without its position', () => {
    const owners: ListenerOwner[] = [
      { kind: 'tag', name: 'li', element: '#board > div:nth-child(2) > li:nth-child(3)' },
    ];
    expect(elementLabel(owners)).toBe('li');
  });

  it('has nothing to say when no owner recorded an element', () => {
    expect(elementLabel([{ kind: 'component', name: 'ChatPage' }])).toBeUndefined();
    expect(elementLabel(undefined)).toBeUndefined();
  });
});
