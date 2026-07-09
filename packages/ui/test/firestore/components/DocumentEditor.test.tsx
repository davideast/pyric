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
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import {
  DocumentEditor,
  type UseDocumentEditorResult,
} from '../../../src/firestore/index.js';

afterEach(() => cleanup());

function query(container: HTMLElement, sel: string): HTMLElement {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`No element matching ${sel}`);
  return el as HTMLElement;
}

function queryAll(container: HTMLElement, sel: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(sel)) as HTMLElement[];
}

describe('<DocumentEditor>', () => {
  it('renders top-level fields with their type-specific Edit components', () => {
    const { container } = render(
      <DocumentEditor.Root initial={{ name: 'Alice', score: 42, active: true }}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    expect(queryAll(container, '[data-pyric-field-entry]').length).toBeGreaterThanOrEqual(3);
    expect(query(container, 'input[type="text"]')).toBeDefined();
    expect(query(container, 'input[type="number"]')).toBeDefined();
    expect(query(container, '[data-pyric-boolean-select]')).toBeDefined();
  });

  it('exposes data-pyric-is-valid + data-pyric-is-dirty on the root', () => {
    const { container } = render(
      <DocumentEditor.Root initial={{ a: 1 }}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    const root = query(container, '[data-pyric-ui="document-editor"]');
    expect(root.hasAttribute('data-pyric-is-valid')).toBe(true);
    expect(root.hasAttribute('data-pyric-is-dirty')).toBe(false);
  });

  // NOTE on text-input events under bun:test + JSDOM:
  // `fireEvent.change` (and `fireEvent.input`) on a controlled `<input
  // type="text">` does not fire React 19's onChange handler in this
  // environment — confirmed in isolation with a minimal controlled
  // component. Click events work; checkbox change events work; only
  // text-input value changes are broken.
  //
  // Coverage for the input → onChange → setValue path lives in the
  // hook tests (useDocumentEditor.test.tsx) plus the reducer tests
  // (documentEditor.test.ts) which exercise the same dispatch chain
  // without the JSDOM event layer. The tests below verify the
  // wiring by driving the editor API directly through the onChange-
  // captured handle.
  it('fires onChange with updated state after setValue dispatch', async () => {
    let latest: UseDocumentEditorResult | null = null;
    render(
      <DocumentEditor.Root
        initial={{ name: 'Alice' }}
        onChange={(state) => {
          latest = state;
        }}
      >
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    const nameId = latest!.tree.childIds[latest!.tree.rootId][0];
    await act(async () => {
      latest!.setValue(nameId, 'Bob');
    });
    expect(latest!.isDirty).toBe(true);
    expect(latest!.toData()).toEqual({ name: 'Bob' });
  });

  it('Add field button appends a new map entry to the root', async () => {
    let latest: UseDocumentEditorResult | null = null;
    const { container } = render(
      <DocumentEditor.Root
        initial={{ a: 1 }}
        onChange={(state) => {
          latest = state;
        }}
      >
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    const beforeChildren =
      latest!.tree.childIds[latest!.tree.rootId].length;
    const addBtn = query(container, '[data-pyric-add-map-entry]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(addBtn);
    });
    const afterChildren = latest!.tree.childIds[latest!.tree.rootId].length;
    expect(afterChildren).toBe(beforeChildren + 1);
  });

  it('Remove button drops the entry from the tree', async () => {
    let latest: UseDocumentEditorResult | null = null;
    const { container } = render(
      <DocumentEditor.Root
        initial={{ a: 1, b: 2 }}
        onChange={(state) => {
          latest = state;
        }}
      >
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    expect(latest!.tree.childIds[latest!.tree.rootId].length).toBe(2);
    const removeBtns = queryAll(container, '[data-pyric-remove]');
    await act(async () => {
      fireEvent.click(removeBtns[0]);
    });
    expect(latest!.tree.childIds[latest!.tree.rootId].length).toBe(1);
  });

  it('Field-name uniqueness flips errorCount after setKey dispatch', async () => {
    // See note above about JSDOM/bun:test text-input events — we
    // exercise setKey directly to avoid the broken event path.
    let latest: UseDocumentEditorResult | null = null;
    render(
      <DocumentEditor.Root
        initial={{ a: 1, b: 2 }}
        onChange={(state) => {
          latest = state;
        }}
      >
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    const tree = latest!.tree;
    const bId = (tree.childIds[tree.rootId] ?? []).find(
      (id) => tree.nodes[id].key === 'b',
    )!;
    await act(async () => {
      latest!.setKey(bId, 'a');
    });
    expect(latest!.isValid).toBe(false);
    expect(latest!.errorCount).toBeGreaterThanOrEqual(2);
  });

  it('exposes a key input for each map child', () => {
    const { container } = render(
      <DocumentEditor.Root initial={{ alpha: 1, beta: 2 }}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    const keyInputs = queryAll(container, '[data-pyric-field-key-input]');
    expect(keyInputs.length).toBe(2);
    expect((keyInputs[0] as HTMLInputElement).value).toBe('alpha');
    expect((keyInputs[1] as HTMLInputElement).value).toBe('beta');
  });

  it('Type select can switch a string field to a number', () => {
    const { container } = render(
      <DocumentEditor.Root initial={{ name: 'Alice' }}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    const typeSelect = query(container, '[data-pyric-field-type-select]') as HTMLSelectElement;
    expect(typeSelect.value).toBe('string');
    act(() => {
      fireEvent.change(typeSelect, { target: { value: 'number' } });
    });
    // After type switch, the input becomes a number input.
    expect(query(container, 'input[type="number"]')).toBeDefined();
  });

  it('Array field renders children with an Add item button', () => {
    const { container } = render(
      <DocumentEditor.Root initial={{ tags: ['a', 'b'] }}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    expect(queryAll(container, '[data-pyric-array-children] > li').length).toBe(2);
    const addBtn = query(container, '[data-pyric-add-array-entry]') as HTMLButtonElement;
    act(() => {
      fireEvent.click(addBtn);
    });
    expect(queryAll(container, '[data-pyric-array-children] > li').length).toBe(3);
  });

  it('field rows keep stable insertion order while a key is being renamed (no sort-by-key)', async () => {
    // Regression for the "rows visibly reorder while typing a field name"
    // bug: the tree was rendered in an order re-sorted by the (currently
    // being typed) key on every render. Rows must stay in insertion order.
    let latest: UseDocumentEditorResult | null = null;
    const { container } = render(
      <DocumentEditor.Root
        initial={{ zeta: 1, alpha: 2 }}
        onChange={(state) => {
          latest = state;
        }}
      >
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    const orderBefore = queryAll(container, '[data-pyric-field-key-input]').map(
      (el) => (el as HTMLInputElement).value,
    );
    expect(orderBefore).toEqual(['zeta', 'alpha']);

    // Rename "zeta" -> "aaaa" (alphabetically it would now sort BEFORE
    // "alpha" under a lexicographic sort) and confirm the DOM order is
    // untouched — same two `<input>` elements, same position.
    const zetaId = latest!.tree.childIds[latest!.tree.rootId].find(
      (id) => latest!.tree.nodes[id].key === 'zeta',
    )!;
    await act(async () => {
      latest!.setKey(zetaId, 'aaaa');
    });
    const orderAfter = queryAll(container, '[data-pyric-field-key-input]').map(
      (el) => (el as HTMLInputElement).value,
    );
    expect(orderAfter).toEqual(['aaaa', 'alpha']);
  });

  it('a freshly-added field row shows no error until touched (blurred)', async () => {
    let latest: UseDocumentEditorResult | null = null;
    const { container } = render(
      <DocumentEditor.Root
        initial={{}}
        onChange={(state) => {
          latest = state;
        }}
      >
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    const addBtn = query(container, '[data-pyric-add-map-entry]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(addBtn);
    });
    // The tree itself is invalid (empty key) immediately — Save must stay
    // disabled — but nothing in the DOM should be flagged as an error yet.
    expect(latest!.isValid).toBe(false);
    expect(container.querySelector('[data-pyric-error]')).toBeNull();
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();

    const keyInput = query(container, '[data-pyric-field-key-input]');
    await act(async () => {
      fireEvent.blur(keyInput);
    });
    // Now that the row has been touched, the same still-invalid state
    // is visible.
    expect(container.querySelector('[data-pyric-error]')).not.toBeNull();
    expect(keyInput.getAttribute('aria-invalid')).toBe('true');
  });

  it('Nested map field renders recursively', () => {
    const { container } = render(
      <DocumentEditor.Root initial={{ addr: { city: 'SF' } }}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>,
    );
    const mapChildren = query(container, '[data-pyric-map-children]');
    expect(mapChildren.querySelectorAll('input[type="text"]').length).toBeGreaterThanOrEqual(1);
  });
});
