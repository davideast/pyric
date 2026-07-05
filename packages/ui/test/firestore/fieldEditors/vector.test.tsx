// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import {
  vectorEditor,
  parseVectorInput,
} from '../../../src/firestore/fieldEditors/vector.js';
import { asVectorView } from '../../../src/firestore/types.js';

afterEach(() => cleanup());

function query(container: HTMLElement, sel: string): HTMLElement {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`No element matching ${sel}`);
  return el as HTMLElement;
}

const wireVec = (values: number[]) => ({ __type__: '__vector__', value: values });

describe('vectorEditor', () => {
  it('registers under the "vector" type', () => {
    expect(vectorEditor.type).toBe('vector');
    expect(vectorEditor.Display).toBeDefined();
    expect(vectorEditor.Edit).toBeDefined();
  });

  describe('Display', () => {
    const Display = vectorEditor.Display;

    it('shows "vector · <dims>" and a truncated preview', () => {
      const values = Array.from({ length: 768 }, (_, i) => i / 1000);
      const { container } = render(
        <Display value={wireVec(values)} path="embedding" />,
      );
      const root = query(container, '[data-pyric-field-type="vector"]');
      expect(root.dataset.dimension).toBe('768');
      expect(query(root, '[data-pyric-vector-dims]').textContent).toBe('vector · 768');
      expect(query(root, '[data-pyric-vector-preview]').textContent).toContain('…');
    });
  });

  describe('Edit (read-only / replace-via-raw)', () => {
    const Edit = vectorEditor.Edit!;

    it('renders a replace-the-whole-value note, NOT a per-element grid', () => {
      const { container } = render(
        <Edit value={wireVec([0.1, 0.2, 0.3])} onChange={() => {}} />,
      );
      // The note signals the replace-whole contract.
      const note = query(container, '[data-pyric-vector-note]');
      expect(note.textContent?.toLowerCase()).toContain('replace');
      // Exactly one input surface (the raw textarea) — no N number inputs.
      expect(container.querySelectorAll('input').length).toBe(0);
      expect(container.querySelectorAll('textarea').length).toBe(1);
      expect(query(container, '[data-pyric-vector-raw]')).toBeDefined();
    });

    it('seeds the textarea with the current value as JSON', () => {
      const { container } = render(
        <Edit value={wireVec([0.1, 0.2, 0.3])} onChange={() => {}} />,
      );
      const ta = query(container, 'textarea') as HTMLTextAreaElement;
      expect(ta.value).toBe('[0.1,0.2,0.3]');
    });

    // NOTE: text-input onChange does not fire under this repo's
    // bun:test + JSDOM setup (see DocumentEditor.test.tsx). The
    // commit/validation contract is covered via the pure
    // `parseVectorInput` helper below, which is exactly what the
    // textarea's onChange delegates to.
  });

  describe('parseVectorInput (replace-via-raw contract)', () => {
    it('parses a JSON number array into a wire-sentinel vector', () => {
      const result = parseVectorInput('[0.5, 0.6, 0.7]');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      // Round-trips back through asVectorView as a real vector.
      const view = asVectorView(result.value);
      expect(view!.values).toEqual([0.5, 0.6, 0.7]);
      expect(view!.dimension).toBe(3);
    });

    it('rejects invalid JSON', () => {
      const result = parseVectorInput('not json');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error');
      expect(result.error).toBe('Invalid JSON');
    });

    it('rejects a JSON array containing non-numbers', () => {
      const result = parseVectorInput('[1, "two", 3]');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error');
      expect(result.error).toContain('number');
    });

    it('rejects non-array JSON', () => {
      expect(parseVectorInput('{"a":1}').ok).toBe(false);
      expect(parseVectorInput('42').ok).toBe(false);
    });
  });
});
