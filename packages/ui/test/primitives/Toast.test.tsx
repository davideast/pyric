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
import { ToastProvider, useToast } from '../../src/primitives/index.js';

afterEach(() => cleanup());

function Probe({ onAction }: { onAction: (api: ReturnType<typeof useToast>) => void }) {
  const api = useToast();
  return (
    <button type="button" data-test-action onClick={() => onAction(api)}>
      run
    </button>
  );
}

describe('<ToastProvider> + useToast', () => {
  it('renders a toast on demand', async () => {
    let api: ReturnType<typeof useToast> | null = null;
    render(
      <ToastProvider>
        <Probe
          onAction={(a) => {
            api = a;
          }}
        />
      </ToastProvider>,
    );
    const trigger = document.querySelector('[data-test-action]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(trigger);
      api!.toast({ title: 'Saved', kind: 'success' });
    });
    const toast = document.querySelector('[data-pyric-toast]');
    expect(toast).not.toBeNull();
    expect(toast!.querySelector('[data-pyric-toast-title]')?.textContent).toBe('Saved');
    expect(toast!.getAttribute('data-pyric-toast-kind')).toBe('success');
  });

  it('renders body when provided', async () => {
    let api: ReturnType<typeof useToast> | null = null;
    render(
      <ToastProvider>
        <Probe
          onAction={(a) => {
            api = a;
          }}
        />
      </ToastProvider>,
    );
    const trigger = document.querySelector('[data-test-action]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(trigger);
      api!.toast({ title: 'Heads up', body: 'Details below', duration: 0 });
    });
    expect(
      document.querySelector('[data-pyric-toast-body]')?.textContent,
    ).toBe('Details below');
  });

  it('dismissing a toast removes it from the DOM', async () => {
    let api: ReturnType<typeof useToast> | null = null;
    render(
      <ToastProvider>
        <Probe
          onAction={(a) => {
            api = a;
          }}
        />
      </ToastProvider>,
    );
    const trigger = document.querySelector('[data-test-action]') as HTMLButtonElement;
    let id = '';
    await act(async () => {
      fireEvent.click(trigger);
      id = api!.toast({ title: 'Removable', duration: 0 });
    });
    expect(document.querySelector('[data-pyric-toast]')).not.toBeNull();
    await act(async () => {
      api!.dismiss(id);
    });
    expect(document.querySelector('[data-pyric-toast]')).toBeNull();
  });

  it('clicking the dismiss button removes the toast', async () => {
    let api: ReturnType<typeof useToast> | null = null;
    render(
      <ToastProvider>
        <Probe
          onAction={(a) => {
            api = a;
          }}
        />
      </ToastProvider>,
    );
    const trigger = document.querySelector('[data-test-action]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(trigger);
      api!.toast({ title: 'Click me away', duration: 0 });
    });
    const dismiss = document.querySelector('[data-pyric-toast-dismiss]') as HTMLButtonElement;
    expect(dismiss).not.toBeNull();
    await act(async () => {
      fireEvent.click(dismiss);
    });
    expect(document.querySelector('[data-pyric-toast]')).toBeNull();
  });

  it('error toasts carry role="alert"', async () => {
    let api: ReturnType<typeof useToast> | null = null;
    render(
      <ToastProvider>
        <Probe
          onAction={(a) => {
            api = a;
          }}
        />
      </ToastProvider>,
    );
    const trigger = document.querySelector('[data-test-action]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(trigger);
      api!.toast({ title: 'Permission denied', kind: 'error', duration: 0 });
    });
    const toast = document.querySelector('[data-pyric-toast]');
    expect(toast?.getAttribute('role')).toBe('alert');
  });

  it('multiple toasts stack', async () => {
    let api: ReturnType<typeof useToast> | null = null;
    render(
      <ToastProvider>
        <Probe
          onAction={(a) => {
            api = a;
          }}
        />
      </ToastProvider>,
    );
    const trigger = document.querySelector('[data-test-action]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(trigger);
      api!.toast({ title: 'one', duration: 0 });
      api!.toast({ title: 'two', duration: 0 });
      api!.toast({ title: 'three', duration: 0 });
    });
    expect(document.querySelectorAll('[data-pyric-toast]').length).toBe(3);
  });

  it('throws if useToast is called without a provider', () => {
    function Bad() {
      useToast();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(/ToastProvider/);
  });
});
