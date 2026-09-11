/**
 * A minimal DOM stand-in for the listener-attribution tests.
 *
 * `packages/pyric` has no DOM test environment: it declares no `jsdom` or
 * `happy-dom` dependency, and the one package that does (`packages/ui`)
 * installs JSDOM per file precisely because replacing the realm's globals
 * breaks the rules parser this package also loads. Rather than add a
 * dependency and inherit that hazard, these tests install the three things
 * effect attribution actually reaches for: `globalThis.document`,
 * `globalThis.MutationObserver`, and elements that answer `getAttribute`,
 * `setAttribute`, `tagName`, `id`, `parentElement`, and `children`.
 *
 * Mutations are reported synchronously into every connected observer's record
 * queue, which is what `takeRecords()` drains, the same contract the real
 * `MutationObserver` offers for a synchronous window.
 */

interface FakeMutationRecord {
  target: FakeElement;
  addedNodes: FakeElement[];
}

const connected = new Set<FakeMutationObserver>();

/** An element with just enough behavior for selector and region resolution. */
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
    report({ target: this, addedNodes: [] });
  }

  /** Attach a child and report the childList mutation, as a real DOM would. */
  append(child: FakeElement): void {
    child.parentElement = this;
    this.children.push(child);
    report({ target: this, addedNodes: [child] });
  }

  /** Report a text change on this element without adding a node. */
  touchText(): void {
    report({ target: this, addedNodes: [] });
  }
}

function report(record: FakeMutationRecord): void {
  for (const observer of connected) {
    observer.push(record);
  }
}

/** The `MutationObserver` shape effect attribution uses. */
export class FakeMutationObserver {
  private records: FakeMutationRecord[] = [];

  observe(): void {
    connected.add(this);
  }

  push(record: FakeMutationRecord): void {
    this.records.push(record);
  }

  takeRecords(): FakeMutationRecord[] {
    const drained = this.records;
    this.records = [];
    return drained;
  }

  disconnect(): void {
    connected.delete(this);
  }
}

/** A fake `document`, which the code under test only needs to exist. */
export const fakeDocument: FakeElement = new FakeElement('html');

interface DomHost {
  document?: unknown;
  MutationObserver?: unknown;
}

/**
 * Install the fake DOM globals and return the function that removes them.
 * Always call the returned function, so one test's realm does not leak into
 * the next.
 */
export function installFakeDom(): () => void {
  const host = globalThis as DomHost;
  const priorDocument = host.document;
  const priorObserver = host.MutationObserver;
  host.document = fakeDocument;
  host.MutationObserver = FakeMutationObserver;
  return () => {
    connected.clear();
    host.document = priorDocument;
    host.MutationObserver = priorObserver;
  };
}
