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
import { Timestamp } from 'pyric/firestore';
import { timestampEditor, timestampFromInput } from '../../../src/firestore/fieldEditors/timestamp.js';
import { bytesEditor } from '../../../src/firestore/fieldEditors/bytes.js';
import { inferType, isBytesShape } from '../../../src/firestore/types.js';
import { initState } from '../../../src/firestore/reducers/documentEditor.js';

afterEach(() => cleanup());

function input(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input');
  if (!el) throw new Error('no input');
  return el as HTMLInputElement;
}

function localIso(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 23);
}

describe('timestamp editor fidelity', () => {
  const Edit = timestampEditor.Edit;
  const original = new Timestamp(1_700_000_045, 123_456_789);

  it('renders seconds and milliseconds with a millisecond step', () => {
    const { container } = render(<Edit value={original} onChange={() => {}} path="t" />);
    const el = input(container);
    expect(el.getAttribute('step')).toBe('0.001');
    expect(el.value).toBe(localIso(original.toDate()));
    expect(el.value).toHaveLength(23);
  });

  // fireEvent.change does not reach React onChange for inputs under bun and
  // JSDOM, so the input-to-Timestamp conversion is tested as a function.
  it('a minute edit keeps the seconds and milliseconds', () => {
    const bumped = new Date(original.toDate().getTime() + 60_000);
    const out = timestampFromInput(localIso(bumped), original)!;
    expect(out.seconds).toBe(original.seconds + 60);
    expect(out.nanoseconds).toBe(123_000_000);
  });

  it('keeps the original nanoseconds when the edit is unchanged to the millisecond', () => {
    const out = timestampFromInput(localIso(original.toDate()), original)!;
    expect(out.seconds).toBe(original.seconds);
    expect(out.nanoseconds).toBe(123_456_789);
    const serialized = { seconds: original.seconds, nanoseconds: 123_456_789 };
    expect(timestampFromInput(localIso(original.toDate()), serialized)!.nanoseconds).toBe(123_456_789);
  });

  it('accepts the minute-only string a browser emits when seconds are zero', () => {
    const out = timestampFromInput('2024-03-05T10:20', original)!;
    expect(out.nanoseconds).toBe(0);
  });

  it('reads a worker-serialized timestamp with the same precision', () => {
    const { container } = render(
      <Edit value={{ seconds: 1_700_000_045, nanoseconds: 123_456_789 } as any} onChange={() => {}} path="t" />,
    );
    expect(input(container).value).toBe(localIso(original.toDate()));
  });
});

describe('Bytes that crossed the worker', () => {
  const plain = { bytes: new Uint8Array([1, 2, 3]) };
  const json = { type: 'firestore/bytes/1.0', bytes: 'AQID' };

  it('detects both plain shapes structurally', () => {
    expect(isBytesShape(plain)).toBe(true);
    expect(isBytesShape(json)).toBe(true);
    expect(isBytesShape({ bytes: 'x', other: 1 })).toBe(false);
    expect(inferType(plain)).toBe('bytes');
    expect(inferType(json)).toBe('bytes');
    expect(inferType({ bytes: 5 })).toBe('map');
  });

  it('renders a plain shape as bytes', () => {
    const Display = bytesEditor.Display;
    const { container } = render(<Display value={plain as any} path="b" />);
    const code = container.querySelector('[data-pyric-field-type="bytes"]')!;
    expect(code.textContent).toBe('AQID');
    expect(code.getAttribute('data-byte-length')).toBe('3');
  });

  it('opens the document editor without a false validation error', () => {
    expect(initState({ b: plain }).errorCount).toBe(0);
  });
});
