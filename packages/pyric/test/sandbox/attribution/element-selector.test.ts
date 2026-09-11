/** Naming a DOM element so a listener event can point back at it. */
import { describe, expect, it } from 'bun:test';
import {
  isSelectableElement,
  OWNER_ATTRIBUTE,
  ownerSelectorFor,
  regionSelectorFor,
  tagNameOf,
} from '../../../src/sandbox/attribution/element-selector.js';
import { FakeElement } from '../../fixtures/fake-dom.js';

describe('element identity', () => {
  it('recognizes an element by the methods it answers', () => {
    expect(isSelectableElement(new FakeElement('div'))).toBe(true);
    expect(isSelectableElement({ tagName: 'DIV' })).toBe(false);
    expect(isSelectableElement(null)).toBe(false);
  });

  it('reports the lower-case tag name', () => {
    expect(tagNameOf(new FakeElement('UL'))).toBe('ul');
  });
});

describe('ownerSelectorFor', () => {
  it('prefers the element id', () => {
    const element = new FakeElement('table');
    element.id = 'orders';
    expect(ownerSelectorFor(element)).toBe('#orders');
  });

  it('reuses an owner attribute someone already set', () => {
    const element = new FakeElement('table');
    element.setAttribute(OWNER_ATTRIBUTE, 'orders-table');
    expect(ownerSelectorFor(element)).toBe(`[${OWNER_ATTRIBUTE}="orders-table"]`);
  });

  it('mints a stable owner attribute for an element with no identity', () => {
    const element = new FakeElement('section');
    const selector = ownerSelectorFor(element);
    const minted = element.getAttribute(OWNER_ATTRIBUTE);
    expect(minted).not.toBeNull();
    expect(selector).toBe(`[${OWNER_ATTRIBUTE}="${minted}"]`);
    expect(ownerSelectorFor(element)).toBe(selector);
  });
});

describe('regionSelectorFor', () => {
  it('prefers the element id', () => {
    const element = new FakeElement('li');
    element.id = 'row-3';
    expect(regionSelectorFor(element)).toBe('#row-3');
  });

  it('writes nothing to an element it only observed', () => {
    const parent = new FakeElement('div');
    parent.id = 'board';
    const child = new FakeElement('span');
    parent.append(child);
    expect(regionSelectorFor(child)).toBe('#board > span:nth-child(1)');
    expect(child.getAttribute(OWNER_ATTRIBUTE)).toBeNull();
  });

  it('walks up to the nearest identified ancestor', () => {
    const root = new FakeElement('main');
    root.setAttribute(OWNER_ATTRIBUTE, 'app');
    const list = new FakeElement('ul');
    root.append(list);
    const first = new FakeElement('li');
    const second = new FakeElement('li');
    list.append(first);
    list.append(second);
    expect(regionSelectorFor(second)).toBe(
      `[${OWNER_ATTRIBUTE}="app"] > ul:nth-child(1) > li:nth-child(2)`,
    );
  });
});
