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
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import {
  ConfirmDialog,
  ConfirmProvider,
  useConfirm,
} from '../../src/primitives/index.js';
import { useState } from 'react';

afterEach(() => cleanup());

function getByTestSel(sel: string): HTMLElement | null {
  // Radix portals render into document.body, so query off document
  // rather than the rendered container.
  return document.querySelector(sel);
}

describe('<ConfirmDialog>', () => {
  it('renders title + body when open', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Delete document?"
        body="This is permanent."
        onConfirm={() => undefined}
      />,
    );
    expect(getByTestSel('[data-pyric-confirm-title]')?.textContent).toBe('Delete document?');
    expect(getByTestSel('[data-pyric-confirm-body]')?.textContent).toBe('This is permanent.');
  });

  it('does not render anything when closed', () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={() => undefined}
        title="Hidden"
        onConfirm={() => undefined}
      />,
    );
    expect(getByTestSel('[data-pyric-confirm-title]')).toBeNull();
  });

  it('emits data-pyric-destructive when destructive', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Delete"
        destructive
        onConfirm={() => undefined}
      />,
    );
    const content = getByTestSel('[data-pyric-ui="confirm-dialog"]');
    expect(content?.hasAttribute('data-pyric-destructive')).toBe(true);
  });

  it('clicking confirm fires onConfirm; the dialog itself does not auto-close', () => {
    let fired = false;
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Delete"
        onConfirm={() => {
          fired = true;
        }}
      />,
    );
    const btn = getByTestSel('[data-pyric-confirm-confirm]') as HTMLButtonElement;
    act(() => {
      fireEvent.click(btn);
    });
    expect(fired).toBe(true);
  });

  it('clicking cancel triggers onOpenChange(false)', () => {
    let open = true;
    function Harness() {
      const [o, setO] = useState(true);
      open = o;
      return (
        <ConfirmDialog
          open={o}
          onOpenChange={setO}
          title="Cancelable"
          onConfirm={() => undefined}
        />
      );
    }
    render(<Harness />);
    const cancel = getByTestSel('[data-pyric-confirm-cancel]') as HTMLButtonElement;
    act(() => {
      fireEvent.click(cancel);
    });
    expect(open).toBe(false);
  });
});

describe('<ConfirmProvider> + useConfirm', () => {
  function Probe({
    onResult,
    options,
  }: {
    onResult: (ok: boolean) => void;
    options?: Parameters<ReturnType<typeof useConfirm>>[0];
  }) {
    const confirm = useConfirm();
    return (
      <button
        type="button"
        data-test-trigger
        onClick={async () => {
          const ok = await confirm(options ?? { title: 'Sure?' });
          onResult(ok);
        }}
      >
        ask
      </button>
    );
  }

  it('resolves to true when the user confirms', async () => {
    let result: boolean | null = null;
    render(
      <ConfirmProvider>
        <Probe
          onResult={(ok) => {
            result = ok;
          }}
        />
      </ConfirmProvider>,
    );
    const trigger = document.querySelector('[data-test-trigger]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(trigger);
    });
    const confirmBtn = getByTestSel('[data-pyric-confirm-confirm]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    // Microtask flush
    await act(async () => {});
    expect(result).toBe(true);
  });

  it('resolves to false when the user cancels', async () => {
    let result: boolean | null = null;
    render(
      <ConfirmProvider>
        <Probe
          onResult={(ok) => {
            result = ok;
          }}
        />
      </ConfirmProvider>,
    );
    const trigger = document.querySelector('[data-test-trigger]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(trigger);
    });
    const cancelBtn = getByTestSel('[data-pyric-confirm-cancel]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    await act(async () => {});
    expect(result).toBe(false);
  });

  it('throws if useConfirm is called without a provider', () => {
    function Bad() {
      useConfirm();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(/ConfirmProvider/);
  });
});
