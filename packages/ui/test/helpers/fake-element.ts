/**
 * A minimal `SelectableElement` stand-in for `useListenerOwner` ref tests.
 *
 * `packages/ui`'s DOM-free test family (`test/primitives`, `test/firestore`
 * without an installed JSDOM) has no real DOM element to attach a ref to.
 * `useListenerOwner`'s `ref` callback only needs the small interface
 * `pyric/sandbox/internal`'s `SelectableElement` declares, so a plain object
 * implementing it stands in for a real element without pulling in JSDOM.
 */
export class FakeElement {
  readonly tagName: string;
  id = '';
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private readonly attributes = new Map<string, string>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}
