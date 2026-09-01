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
import { useState, useRef } from 'react';
import { Modal, type ModalProps } from '../../src/primitives/index.js';
import { Modal as AgentModal } from '../../src/agents/index.js';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Modal Primitive Exports', () => {
  it('is exported from @pyric/ui/primitives and re-exported identically from @pyric/ui/agents', () => {
    expect(Modal).toBeDefined();
    expect(AgentModal).toBeDefined();
    expect(Modal).toBe(AgentModal);
  });
});

describe('<Modal> DOM Rendering & ARIA Semantics', () => {
  it('renders nothing when open=false', () => {
    render(
      <Modal open={false} onClose={() => {}}>
        <p>Modal content</p>
      </Modal>,
    );
    expect(document.querySelector('[data-pyric-ui="modal"]')).toBeNull();
  });

  it('renders dialog, backdrop, and panel with appropriate ARIA attributes when open=true', () => {
    render(
      <Modal
        open={true}
        onClose={() => {}}
        ariaLabel="Test Dialog"
        ariaLabelledBy="dialog-title"
        ariaDescribedBy="dialog-desc"
        className="custom-root"
        backdropClassName="custom-backdrop"
        panelClassName="custom-panel"
      >
        <h2 id="dialog-title">Title</h2>
        <p id="dialog-desc">Description</p>
        <button type="button">Action</button>
      </Modal>,
    );

    const root = document.querySelector('[data-pyric-ui="modal"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('role')).toBe('dialog');
    expect(root?.getAttribute('aria-modal')).toBe('true');
    expect(root?.getAttribute('aria-label')).toBe('Test Dialog');
    expect(root?.getAttribute('aria-labelledby')).toBe('dialog-title');
    expect(root?.getAttribute('aria-describedby')).toBe('dialog-desc');
    expect(root?.classList.contains('custom-root')).toBe(true);

    const backdrop = document.querySelector('[data-pyric-modal-backdrop]');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop?.classList.contains('custom-backdrop')).toBe(true);

    const panel = document.querySelector('[data-pyric-modal-panel]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('tabindex')).toBe('-1');
    expect(panel?.classList.contains('custom-panel')).toBe(true);
    expect(panel?.textContent).toContain('Title');
    expect(panel?.textContent).toContain('Description');
  });
});

describe('<Modal> Dismissal Triggers', () => {
  it('invokes onClose when Escape key is pressed', () => {
    const handleClose = mock(() => {});
    render(
      <Modal open={true} onClose={handleClose}>
        <button type="button">Inside</button>
      </Modal>,
    );

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onClose when backdrop is clicked', () => {
    const handleClose = mock(() => {});
    render(
      <Modal open={true} onClose={handleClose}>
        <button type="button">Inside</button>
      </Modal>,
    );

    const backdrop = document.querySelector('[data-pyric-modal-backdrop]') as HTMLElement;
    expect(backdrop).not.toBeNull();

    act(() => {
      fireEvent.click(backdrop);
    });

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onClose when clicking inside the modal panel', () => {
    const handleClose = mock(() => {});
    render(
      <Modal open={true} onClose={handleClose}>
        <button type="button" data-testid="inside-btn">Inside</button>
      </Modal>,
    );

    const insideBtn = document.querySelector('[data-testid="inside-btn"]') as HTMLElement;
    act(() => {
      fireEvent.click(insideBtn);
    });

    expect(handleClose).not.toHaveBeenCalled();
  });
});

describe('<Modal> Initial Focus', () => {
  it('automatically focuses the first focusable element inside the modal on open', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <button type="button" id="btn-first">First</button>
        <button type="button" id="btn-second">Second</button>
      </Modal>,
    );

    expect(document.activeElement?.id).toBe('btn-first');
  });

  it('focuses initialFocusRef when provided', () => {
    function CustomFocusHarness() {
      const inputRef = useRef<HTMLInputElement | null>(null);
      return (
        <Modal open={true} onClose={() => {}} initialFocusRef={inputRef}>
          <button type="button" id="btn-first">First</button>
          <input type="text" id="target-input" ref={inputRef} />
        </Modal>
      );
    }

    render(<CustomFocusHarness />);
    expect(document.activeElement?.id).toBe('target-input');
  });

  it('focuses the panel container itself if no focusable children exist', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <p>No interactive elements here</p>
      </Modal>,
    );

    const panel = document.querySelector('[data-pyric-modal-panel]');
    expect(document.activeElement).toBe(panel);
  });
});

describe('<Modal> Focus Trapping & Containment', () => {
  it('cycles focus forward with Tab and wraps from last to first', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <button type="button" id="btn-1">1</button>
        <input type="text" id="input-2" />
        <button type="button" id="btn-3">3</button>
      </Modal>,
    );

    const b1 = document.getElementById('btn-1') as HTMLElement;
    const i2 = document.getElementById('input-2') as HTMLElement;
    const b3 = document.getElementById('btn-3') as HTMLElement;

    expect(document.activeElement).toBe(b1);

    // Tab -> i2
    act(() => {
      fireEvent.keyDown(b1, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(i2);

    // Tab -> b3
    act(() => {
      fireEvent.keyDown(i2, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(b3);

    // Tab on last element -> wraps to b1
    act(() => {
      fireEvent.keyDown(b3, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(b1);
  });

  it('cycles focus backward with Shift+Tab and wraps from first to last', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <button type="button" id="btn-1">1</button>
        <input type="text" id="input-2" />
        <button type="button" id="btn-3">3</button>
      </Modal>,
    );

    const b1 = document.getElementById('btn-1') as HTMLElement;
    const i2 = document.getElementById('input-2') as HTMLElement;
    const b3 = document.getElementById('btn-3') as HTMLElement;

    expect(document.activeElement).toBe(b1);

    // Shift+Tab on first element -> wraps to b3
    act(() => {
      fireEvent.keyDown(b1, { key: 'Tab', shiftKey: true });
    });
    expect(document.activeElement).toBe(b3);

    // Shift+Tab on b3 -> moves to i2
    act(() => {
      fireEvent.keyDown(b3, { key: 'Tab', shiftKey: true });
    });
    expect(document.activeElement).toBe(i2);

    // Shift+Tab on i2 -> moves to b1
    act(() => {
      fireEvent.keyDown(i2, { key: 'Tab', shiftKey: true });
    });
    expect(document.activeElement).toBe(b1);
  });

  it('snaps focus back inside the panel when Tab or Shift+Tab is pressed while focus is outside', () => {
    render(
      <div>
        <button type="button" id="outside-btn">Outside</button>
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="btn-1">1</button>
          <button type="button" id="btn-2">2</button>
        </Modal>
      </div>,
    );

    const outsideBtn = document.getElementById('outside-btn') as HTMLElement;
    const b1 = document.getElementById('btn-1') as HTMLElement;
    const b2 = document.getElementById('btn-2') as HTMLElement;

    // Focus starts on b1 due to initialFocus. Move focus outside the modal panel.
    outsideBtn.focus();
    expect(document.activeElement).toBe(outsideBtn);

    // Forward Tab while outside snaps to first element
    act(() => {
      fireEvent.keyDown(outsideBtn, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(b1);

    // Move focus outside again
    outsideBtn.focus();
    expect(document.activeElement).toBe(outsideBtn);

    // Shift+Tab while outside snaps to last element
    act(() => {
      fireEvent.keyDown(outsideBtn, { key: 'Tab', shiftKey: true });
    });
    expect(document.activeElement).toBe(b2);
  });

  it('keeps focus pinned to a single focusable element without escaping on Tab or Shift+Tab', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <button type="button" id="only-btn">Only</button>
      </Modal>,
    );

    const onlyBtn = document.getElementById('only-btn') as HTMLElement;
    expect(document.activeElement).toBe(onlyBtn);

    act(() => {
      fireEvent.keyDown(onlyBtn, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(onlyBtn);

    act(() => {
      fireEvent.keyDown(onlyBtn, { key: 'Tab', shiftKey: true });
    });
    expect(document.activeElement).toBe(onlyBtn);
  });

  it('ignores disabled and aria-hidden elements in focus cycling', () => {
    render(
      <Modal open={true} onClose={() => {}}>
        <button type="button" id="active-1">1</button>
        <button type="button" id="disabled-btn" disabled>Disabled</button>
        <button type="button" id="hidden-btn" aria-hidden="true">Hidden</button>
        <button type="button" id="negative-tabindex" tabIndex={-1}>Negative</button>
        <button type="button" id="active-2">2</button>
      </Modal>,
    );

    const a1 = document.getElementById('active-1') as HTMLElement;
    const a2 = document.getElementById('active-2') as HTMLElement;

    expect(document.activeElement).toBe(a1);

    // Tab from active-1 should skip disabled, hidden, and tabIndex=-1, jumping straight to active-2
    act(() => {
      fireEvent.keyDown(a1, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(a2);

    // Tab from active-2 wraps back to active-1
    act(() => {
      fireEvent.keyDown(a2, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(a1);
  });
});

describe('<Modal> Focus Restoration', () => {
  function FocusRestorationHarness() {
    const [open, setOpen] = useState(false);

    return (
      <div>
        <button
          type="button"
          data-testid="trigger-btn"
          onClick={() => setOpen(true)}
        >
          Open Modal
        </button>
        <Modal open={open} onClose={() => setOpen(false)}>
          <button
            type="button"
            data-testid="modal-close-btn"
            onClick={() => setOpen(false)}
          >
            Close Inside
          </button>
          <button type="button" data-testid="modal-other-btn">
            Other
          </button>
        </Modal>
      </div>
    );
  }

  it('restores focus to the triggering element when closed via Escape', async () => {
    render(<FocusRestorationHarness />);

    const trigger = document.querySelector('[data-testid="trigger-btn"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();

    // Trigger has focus before opening
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Open modal
    act(() => {
      fireEvent.click(trigger);
    });

    const modalBtn = document.querySelector('[data-testid="modal-close-btn"]') as HTMLElement;
    expect(document.activeElement).toBe(modalBtn);

    // Dismiss with Escape
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await act(async () => {});

    // Focus must be restored to trigger
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the triggering element when closed via backdrop click', async () => {
    render(<FocusRestorationHarness />);

    const trigger = document.querySelector('[data-testid="trigger-btn"]') as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Open modal
    act(() => {
      fireEvent.click(trigger);
    });

    const backdrop = document.querySelector('[data-pyric-modal-backdrop]') as HTMLElement;
    expect(backdrop).not.toBeNull();

    // Dismiss with backdrop click
    act(() => {
      fireEvent.click(backdrop);
    });

    await act(async () => {});

    // Focus must be restored to trigger
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the triggering element when closed via internal close button', async () => {
    render(<FocusRestorationHarness />);

    const trigger = document.querySelector('[data-testid="trigger-btn"]') as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Open modal
    act(() => {
      fireEvent.click(trigger);
    });

    const modalCloseBtn = document.querySelector('[data-testid="modal-close-btn"]') as HTMLElement;
    expect(document.activeElement).toBe(modalCloseBtn);

    // Click close button inside
    act(() => {
      fireEvent.click(modalCloseBtn);
    });

    await act(async () => {});

    // Focus must be restored to trigger
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the triggering element when component unmounts while open', async () => {
    function UnmountHarness() {
      const [open, setOpen] = useState(false);
      const [mounted, setMounted] = useState(true);
      return (
        <div>
          <button
            type="button"
            data-testid="unmount-trigger"
            onClick={() => setOpen(true)}
          >
            Trigger
          </button>
          {mounted && open && (
            <Modal open={open} onClose={() => setOpen(false)}>
              <button
                type="button"
                data-testid="unmount-btn"
                onClick={() => setMounted(false)}
              >
                Unmount Modal
              </button>
            </Modal>
          )}
        </div>
      );
    }

    render(<UnmountHarness />);

    const trigger = document.querySelector('[data-testid="unmount-trigger"]') as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      fireEvent.click(trigger);
    });

    const unmountBtn = document.querySelector('[data-testid="unmount-btn"]') as HTMLElement;
    expect(document.activeElement).toBe(unmountBtn);

    // Click button to unmount modal
    act(() => {
      fireEvent.click(unmountBtn);
    });

    await act(async () => {});

    expect(document.querySelector('[data-pyric-ui="modal"]')).toBeNull();
    // Focus restored to trigger on unmount
    expect(document.activeElement).toBe(trigger);
  });
});
