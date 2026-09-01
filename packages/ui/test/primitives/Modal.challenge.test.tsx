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

// Polyfill attachEvent/detachEvent in JSDOM so React 19 input polyfills do not throw
if (typeof (dom.window.HTMLElement.prototype as any).attachEvent === 'undefined') {
  (dom.window.HTMLElement.prototype as any).attachEvent = () => {};
  (dom.window.HTMLElement.prototype as any).detachEvent = () => {};
}

import { afterEach, describe, it, expect, mock } from 'bun:test';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { useState, useRef, useEffect } from 'react';
import { Modal } from '../../src/primitives/index.js';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Challenger M2.2: Focus Restoration & Lifecycle Empirical Stress Suite', () => {
  // Test 1: Button Trigger -> Escape
  it('Scenario 1: When opened from a button, closing via Escape restores focus to that button', async () => {
    function ButtonTriggerHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" id="trigger-btn" onClick={() => setOpen(true)}>
            Open from Button
          </button>
          <Modal open={open} onClose={() => setOpen(false)}>
            <h2>Modal Title</h2>
            <button type="button" id="modal-first-btn">Action 1</button>
            <button type="button" id="modal-second-btn">Action 2</button>
          </Modal>
        </div>
      );
    }

    render(<ButtonTriggerHarness />);

    const triggerBtn = document.getElementById('trigger-btn') as HTMLButtonElement;
    expect(triggerBtn).not.toBeNull();

    // 1. Focus button
    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    // 2. Open modal via click
    act(() => {
      fireEvent.click(triggerBtn);
    });

    const modalBtn = document.getElementById('modal-first-btn') as HTMLButtonElement;
    expect(document.activeElement).toBe(modalBtn);

    // 3. Press Escape to close
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    // Allow microtasks to resolve
    await act(async () => {
      await Promise.resolve();
    });

    // 4. Modal is closed
    expect(document.querySelector('[data-pyric-ui="modal"]')).toBeNull();

    // 5. Verify focus restored to button
    expect(document.activeElement).toBe(triggerBtn);
  });

  // Test 2: Input Trigger -> Backdrop Click
  it('Scenario 2: When opened from an input, closing via backdrop click restores focus to that input', async () => {
    function InputTriggerHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <input
            type="text"
            id="trigger-input"
            defaultValue="User text input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setOpen(true);
              }
            }}
          />
          <button type="button" id="other-page-btn">Other</button>
          <Modal open={open} onClose={() => setOpen(false)}>
            <h2>Dialog for Input</h2>
            <button type="button" id="modal-inner-btn">Submit</button>
          </Modal>
        </div>
      );
    }

    render(<InputTriggerHarness />);

    const triggerInput = document.getElementById('trigger-input') as HTMLInputElement;
    expect(triggerInput).not.toBeNull();

    // 1. Focus input
    triggerInput.focus();
    expect(document.activeElement).toBe(triggerInput);

    // 2. Open modal while input is focused
    act(() => {
      fireEvent.keyDown(triggerInput, { key: 'Enter' });
    });

    const modalInnerBtn = document.getElementById('modal-inner-btn') as HTMLButtonElement;
    expect(document.activeElement).toBe(modalInnerBtn);

    // 3. Click backdrop
    const backdrop = document.querySelector('[data-pyric-modal-backdrop]') as HTMLElement;
    expect(backdrop).not.toBeNull();

    act(() => {
      fireEvent.click(backdrop);
    });

    await act(async () => {
      await Promise.resolve();
    });

    // 4. Modal is closed
    expect(document.querySelector('[data-pyric-ui="modal"]')).toBeNull();

    // 5. Verify focus is restored to the input element
    expect(document.activeElement).toBe(triggerInput);
  });

  // Test 3: Internal Close Button -> External Trigger Restoration
  it('Scenario 3: When closed via an internal close button, focus is restored to the external trigger element', async () => {
    function InternalCloseHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" id="external-trigger" onClick={() => setOpen(true)}>
            Launch Modal
          </button>
          <Modal open={open} onClose={() => setOpen(false)}>
            <h2>Dialog Title</h2>
            <button type="button" id="dialog-content-btn">Random Action</button>
            <button
              type="button"
              id="dialog-close-btn"
              onClick={() => setOpen(false)}
            >
              Close Window
            </button>
          </Modal>
        </div>
      );
    }

    render(<InternalCloseHarness />);

    const externalTrigger = document.getElementById('external-trigger') as HTMLButtonElement;
    externalTrigger.focus();
    expect(document.activeElement).toBe(externalTrigger);

    // Open modal
    act(() => {
      fireEvent.click(externalTrigger);
    });

    // Verify modal opened and first element is focused
    const randomActionBtn = document.getElementById('dialog-content-btn') as HTMLButtonElement;
    expect(document.activeElement).toBe(randomActionBtn);

    // Navigate to close button and click it
    const closeBtn = document.getElementById('dialog-close-btn') as HTMLButtonElement;
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);

    act(() => {
      fireEvent.click(closeBtn);
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Modal is closed
    expect(document.querySelector('[data-pyric-ui="modal"]')).toBeNull();

    // Focus restored to external trigger
    expect(document.activeElement).toBe(externalTrigger);
  });

  // Test 4: Unmounted while open -> Focus Restored
  it('Scenario 4: When component is unmounted while open, focus is restored to the external trigger', async () => {
    // Set active element BEFORE rendering modal open
    const initialButton = document.createElement('button');
    initialButton.id = 'standalone-trigger';
    document.body.appendChild(initialButton);
    initialButton.focus();
    expect(document.activeElement).toBe(initialButton);

    const { unmount } = render(
      <Modal open={true} onClose={() => {}}>
        <button type="button" id="inner-modal-child">Inside</button>
      </Modal>
    );

    const innerChild = document.getElementById('inner-modal-child') as HTMLButtonElement;
    expect(document.activeElement).toBe(innerChild);

    // Unmount modal directly while open
    act(() => {
      unmount();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.getElementById('inner-modal-child')).toBeNull();
    // Focus should be restored to initialButton
    expect(document.activeElement).toBe(initialButton);

    initialButton.remove();
  });

  it('Scenario 4b: When component unmounts while open and trigger was detached, handles gracefully without error', async () => {
    const detachedTrigger = document.createElement('button');
    detachedTrigger.id = 'ephemeral-trigger';
    document.body.appendChild(detachedTrigger);
    detachedTrigger.focus();
    expect(document.activeElement).toBe(detachedTrigger);

    const { unmount } = render(
      <Modal open={true} onClose={() => {}}>
        <button type="button" id="inner-ephemeral">Inside</button>
      </Modal>
    );

    // Detach the trigger element from DOM while modal is open
    detachedTrigger.remove();
    expect(detachedTrigger.isConnected).toBe(false);

    // Unmounting should not throw or crash trying to focus detached element
    expect(() => {
      act(() => {
        unmount();
      });
    }).not.toThrow();

    await act(async () => {
      await Promise.resolve();
    });
  });

  // Test 5: Rapid Toggle (50 cycles)
  it('Scenario 5a: Rapid toggle (50 cycles) without listener leaks, memory leaks, or race conditions', async () => {
    // Spy on addEventListener and removeEventListener to verify listener lifecycle
    let activeKeydownListeners = 0;
    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);

    window.addEventListener = (type: string, listener: any, options?: any) => {
      if (type === 'keydown') {
        activeKeydownListeners++;
      }
      return originalAdd(type, listener, options);
    };

    window.removeEventListener = (type: string, listener: any, options?: any) => {
      if (type === 'keydown') {
        activeKeydownListeners--;
      }
      return originalRemove(type, listener, options);
    };

    try {
      function RapidToggleHarness() {
        const [open, setOpen] = useState(false);
        const [counter, setCounter] = useState(0);

        return (
          <div>
            <button
              type="button"
              id="rapid-toggle-trigger"
              onClick={() => {
                setOpen((prev) => !prev);
                setCounter((c) => c + 1);
              }}
            >
              Toggle (Count: {counter})
            </button>
            <Modal open={open} onClose={() => setOpen(false)}>
              <button type="button" id="rapid-inner-btn">
                Inner {counter}
              </button>
            </Modal>
          </div>
        );
      }

      render(<RapidToggleHarness />);

      const trigger = document.getElementById('rapid-toggle-trigger') as HTMLButtonElement;
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      const baselineListeners = activeKeydownListeners;

      // Execute 50 rapid toggle cycles (100 state transitions: open, close, open, close...)
      for (let i = 0; i < 50; i++) {
        // Open
        act(() => {
          fireEvent.click(trigger);
        });

        const innerBtn = document.getElementById('rapid-inner-btn');
        expect(innerBtn).not.toBeNull();
        expect(document.activeElement).toBe(innerBtn);
        expect(activeKeydownListeners).toBe(baselineListeners + 1);

        // Close
        act(() => {
          fireEvent.click(trigger);
        });

        expect(document.getElementById('rapid-inner-btn')).toBeNull();
        expect(activeKeydownListeners).toBe(baselineListeners);
      }

      await act(async () => {
        await Promise.resolve();
      });

      // Verify that after 50 rapid cycles:
      // 1. Zero listener leak
      expect(activeKeydownListeners).toBe(baselineListeners);

      // 2. Focus is restored to trigger
      expect(document.activeElement).toBe(trigger);
    } finally {
      window.addEventListener = originalAdd;
      window.removeEventListener = originalRemove;
    }
  });

  // Test 5b: Rapid synchronous state toggling does not produce out-of-order focus stealing
  it('Scenario 5b: Rapid synchronous state toggling does not produce out-of-order focus stealing', async () => {
    function RapidSyncHarness({ open }: { open: boolean }) {
      return (
        <div>
          <button type="button" id="sync-trigger">Sync Trigger</button>
          <Modal open={open} onClose={() => {}}>
            <button type="button" id="sync-modal-btn">Sync Inside</button>
          </Modal>
        </div>
      );
    }

    const { rerender } = render(<RapidSyncHarness open={false} />);

    const trigger = document.getElementById('sync-trigger') as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Rapidly alternate open prop 50 times in rapid succession
    for (let i = 0; i < 25; i++) {
      act(() => {
        rerender(<RapidSyncHarness open={true} />);
      });
      expect(document.activeElement?.id).toBe('sync-modal-btn');

      act(() => {
        rerender(<RapidSyncHarness open={false} />);
      });
      expect(document.activeElement).toBe(trigger);
    }

    // Flush all pending microtasks
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(trigger);
  });

  // Test 5c: Rapid re-open after close does not allow stale microtask to steal focus from newly opened modal
  it('Scenario 5c: Opening modal immediately after closing does not allow prior microtask to steal focus', async () => {
    function QuickReopenHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" id="reopen-trigger">Reopen Trigger</button>
          <Modal open={open} onClose={() => setOpen(false)}>
            <button type="button" id="reopen-modal-btn">Reopen Inside</button>
          </Modal>
        </div>
      );
    }

    render(<QuickReopenHarness />);

    const trigger = document.getElementById('reopen-trigger') as HTMLButtonElement;
    trigger.focus();

    // Open first time
    const { rerender } = render(
      <div>
        <button type="button" id="root-btn">Root</button>
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="modal-elem">Elem</button>
        </Modal>
      </div>
    );

    const elem = document.getElementById('modal-elem') as HTMLElement;
    expect(document.activeElement).toBe(elem);

    // Close modal, then synchronously open again without microtask flush in between
    act(() => {
      rerender(
        <div>
          <button type="button" id="root-btn">Root</button>
          <Modal open={false} onClose={() => {}}>
            <button type="button" id="modal-elem">Elem</button>
          </Modal>
        </div>
      );
      rerender(
        <div>
          <button type="button" id="root-btn">Root</button>
          <Modal open={true} onClose={() => {}}>
            <button type="button" id="modal-elem">Elem</button>
          </Modal>
        </div>
      );
    });

    // Wait for microtasks
    await act(async () => {
      await Promise.resolve();
    });

    // The modal is currently open. Focus MUST remain on modal element, NOT stolen by stale microtask!
    const activeId = document.activeElement?.id;
    expect(activeId).toBe('modal-elem');
  });

  // Test 6: Non-button triggers (Link, Select, Textarea)
  it('Scenario 6: Focus restoration works across diverse trigger types (a[href], select, textarea)', async () => {
    function DiverseTriggersHarness() {
      const [openModal, setOpenModal] = useState<'link' | 'select' | 'textarea' | null>(null);

      return (
        <div>
          <a
            href="#anchor"
            id="link-trigger"
            onClick={(e) => {
              e.preventDefault();
              setOpenModal('link');
            }}
          >
            Link Trigger
          </a>
          <select
            id="select-trigger"
            onChange={(e) => {
              if (e.target.value === 'modal') {
                setOpenModal('select');
              }
            }}
          >
            <option value="none">Choose</option>
            <option value="modal">Open</option>
          </select>
          <textarea
            id="textarea-trigger"
            onKeyDown={(e) => {
              if (e.key === 'F2') {
                setOpenModal('textarea');
              }
            }}
          />

          <Modal open={openModal !== null} onClose={() => setOpenModal(null)}>
            <button type="button" id="generic-modal-btn">Dismiss</button>
          </Modal>
        </div>
      );
    }

    render(<DiverseTriggersHarness />);

    // 1. Link trigger
    const link = document.getElementById('link-trigger') as HTMLAnchorElement;
    link.focus();
    expect(document.activeElement).toBe(link);

    act(() => {
      fireEvent.click(link);
    });
    expect(document.activeElement?.id).toBe('generic-modal-btn');

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(link);

    // 2. Select trigger
    const select = document.getElementById('select-trigger') as HTMLSelectElement;
    select.focus();
    expect(document.activeElement).toBe(select);

    act(() => {
      fireEvent.change(select, { target: { value: 'modal' } });
    });
    expect(document.activeElement?.id).toBe('generic-modal-btn');

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(select);

    // 3. Textarea trigger
    const textarea = document.getElementById('textarea-trigger') as HTMLTextAreaElement;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    act(() => {
      fireEvent.keyDown(textarea, { key: 'F2' });
    });
    expect(document.activeElement?.id).toBe('generic-modal-btn');

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(textarea);
  });

  // Test 7: Nested / stacked modal focus handover
  it('Scenario 7: Stacked modals preserve focus restoration chain', async () => {
    function StackedModalsHarness() {
      const [open1, setOpen1] = useState(false);
      const [open2, setOpen2] = useState(false);

      return (
        <div>
          <button type="button" id="root-trigger" onClick={() => setOpen1(true)}>
            Open Modal 1
          </button>
          <Modal open={open1} onClose={() => setOpen1(false)}>
            <h2>Modal 1</h2>
            <button
              type="button"
              id="m1-open-m2"
              onClick={() => setOpen2(true)}
            >
              Open Modal 2
            </button>
            <button type="button" id="m1-close" onClick={() => setOpen1(false)}>
              Close M1
            </button>
          </Modal>

          <Modal open={open2} onClose={() => setOpen2(false)}>
            <h2>Modal 2</h2>
            <button
              type="button"
              id="m2-close"
              onClick={() => setOpen2(false)}
            >
              Close M2
            </button>
          </Modal>
        </div>
      );
    }

    render(<StackedModalsHarness />);

    const rootTrigger = document.getElementById('root-trigger') as HTMLButtonElement;
    rootTrigger.focus();
    expect(document.activeElement).toBe(rootTrigger);

    // 1. Open Modal 1
    act(() => {
      fireEvent.click(rootTrigger);
    });
    const m1Btn = document.getElementById('m1-open-m2') as HTMLButtonElement;
    expect(document.activeElement).toBe(m1Btn);

    // 2. Open Modal 2 from Modal 1
    act(() => {
      fireEvent.click(m1Btn);
    });
    const m2Btn = document.getElementById('m2-close') as HTMLButtonElement;
    expect(document.activeElement).toBe(m2Btn);

    // 3. Close Modal 2 -> focus should return to m1Btn in Modal 1
    act(() => {
      fireEvent.click(m2Btn);
    });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(m1Btn);

    // 4. Close Modal 1 -> focus should return to rootTrigger
    const m1Close = document.getElementById('m1-close') as HTMLButtonElement;
    act(() => {
      fireEvent.click(m1Close);
    });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(rootTrigger);
  });
});
