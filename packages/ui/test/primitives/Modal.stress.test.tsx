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

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from '../../src/primitives/index.js';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Modal Focus Trap Empirical Stress Tests', () => {
  // -------------------------------------------------------------------------
  // Mission 1.1: Panel with 0 focusable elements: does Tab crash or escape?
  // -------------------------------------------------------------------------
  describe('Boundary Condition 1: Panel with 0 focusable elements', () => {
    it('does not crash and retains focus on panel container when Tab is pressed', () => {
      render(
        <div>
          <button type="button" id="outside-before">Outside Before</button>
          <Modal open={true} onClose={() => {}}>
            <p id="static-para">Static paragraph with zero focusable elements</p>
            <span id="static-span">Another static label</span>
          </Modal>
          <button type="button" id="outside-after">Outside After</button>
        </div>,
      );

      const panel = document.querySelector('[data-pyric-modal-panel]') as HTMLElement;
      expect(panel).not.toBeNull();
      // On mount, initial focus falls back to panel itself
      expect(document.activeElement).toBe(panel);

      // Press Tab on panel
      let eventDispatched = false;
      act(() => {
        eventDispatched = fireEvent.keyDown(panel, { key: 'Tab' });
      });

      // Default should be prevented (eventDispatched is false when preventDefault is called)
      expect(eventDispatched).toBe(false);
      // Focus must not escape to outside buttons or document body
      expect(document.activeElement).toBe(panel);
    });

    it('does not crash and retains focus on panel container when Shift+Tab is pressed', () => {
      render(
        <div>
          <button type="button" id="outside-before">Outside Before</button>
          <Modal open={true} onClose={() => {}}>
            <div>Informational notice with no buttons or inputs</div>
          </Modal>
          <button type="button" id="outside-after">Outside After</button>
        </div>,
      );

      const panel = document.querySelector('[data-pyric-modal-panel]') as HTMLElement;
      expect(document.activeElement).toBe(panel);

      let eventDispatched = false;
      act(() => {
        eventDispatched = fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
      });

      expect(eventDispatched).toBe(false);
      expect(document.activeElement).toBe(panel);
    });

    it('recovers focus to panel container if focus was accidentally outside when 0 focusables exist', () => {
      render(
        <div>
          <button type="button" id="outside-btn">Outside Button</button>
          <Modal open={true} onClose={() => {}}>
            <p>Zero focusable items</p>
          </Modal>
        </div>,
      );

      const outside = document.getElementById('outside-btn') as HTMLElement;
      const panel = document.querySelector('[data-pyric-modal-panel]') as HTMLElement;

      // Force focus outside
      outside.focus();
      expect(document.activeElement).toBe(outside);

      // Press Tab while outside
      let eventDispatched = false;
      act(() => {
        eventDispatched = fireEvent.keyDown(outside, { key: 'Tab' });
      });

      expect(eventDispatched).toBe(false);
      expect(document.activeElement).toBe(panel);

      // Force focus outside again and press Shift+Tab
      outside.focus();
      expect(document.activeElement).toBe(outside);

      act(() => {
        eventDispatched = fireEvent.keyDown(outside, { key: 'Tab', shiftKey: true });
      });

      expect(eventDispatched).toBe(false);
      expect(document.activeElement).toBe(panel);
    });

    it('treats a panel containing only disabled/hidden elements as 0 focusables and confines to panel', () => {
      render(
        <div>
          <button type="button" id="outside-btn">Outside</button>
          <Modal open={true} onClose={() => {}}>
            <button type="button" disabled id="dis-1">Disabled 1</button>
            <input type="hidden" id="hid-1" value="secret" />
            <a href="#test" tabIndex={-1} id="link-neg">Negative Tabindex</a>
            <button type="button" aria-hidden="true" id="aria-hid-direct">Aria Hidden</button>
          </Modal>
        </div>,
      );

      const panel = document.querySelector('[data-pyric-modal-panel]') as HTMLElement;
      expect(document.activeElement).toBe(panel);

      // Tab does not advance to disabled or hidden children
      act(() => {
        fireEvent.keyDown(panel, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(panel);

      // Shift+Tab does not advance either
      act(() => {
        fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
      });
      expect(document.activeElement).toBe(panel);
    });

    it('empirically reveals whether ancestor aria-hidden containers filter focusable children', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="standalone-valid">Valid</button>
          <div aria-hidden="true" id="ancestor-aria-hidden">
            <button type="button" id="child-of-aria-hidden">Child of aria-hidden</button>
          </div>
        </Modal>,
      );

      const valid = document.getElementById('standalone-valid') as HTMLElement;
      const child = document.getElementById('child-of-aria-hidden') as HTMLElement;

      expect(document.activeElement).toBe(valid);

      // Advance with Tab: because Modal.tsx only checks el.getAttribute('aria-hidden') on the element itself,
      // the child button inside <div aria-hidden="true"> is treated as focusable by Modal.tsx
      act(() => {
        fireEvent.keyDown(valid, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(child);
    });
  });

  // -------------------------------------------------------------------------
  // Mission 1.2: Panel with exactly 1 focusable element: Tab & Shift+Tab stay on it
  // -------------------------------------------------------------------------
  describe('Boundary Condition 2: Panel with exactly 1 focusable element', () => {
    it('stays focused on the single element under repeated Tab presses', () => {
      render(
        <div>
          <button type="button" id="outside-1">Outside 1</button>
          <Modal open={true} onClose={() => {}}>
            <p>Read the terms carefully</p>
            <button type="button" id="solo-btn">Acknowledge</button>
          </Modal>
          <button type="button" id="outside-2">Outside 2</button>
        </div>,
      );

      const solo = document.getElementById('solo-btn') as HTMLElement;
      expect(document.activeElement).toBe(solo);

      // Press Tab 5 times in succession
      for (let i = 0; i < 5; i++) {
        let dispatched = false;
        act(() => {
          dispatched = fireEvent.keyDown(solo, { key: 'Tab' });
        });
        expect(dispatched).toBe(false);
        expect(document.activeElement).toBe(solo);
      }
    });

    it('stays focused on the single element under repeated Shift+Tab presses', () => {
      render(
        <div>
          <button type="button" id="outside-1">Outside 1</button>
          <Modal open={true} onClose={() => {}}>
            <button type="button" id="solo-btn">Acknowledge</button>
          </Modal>
          <button type="button" id="outside-2">Outside 2</button>
        </div>,
      );

      const solo = document.getElementById('solo-btn') as HTMLElement;
      expect(document.activeElement).toBe(solo);

      // Press Shift+Tab 5 times in succession
      for (let i = 0; i < 5; i++) {
        let dispatched = false;
        act(() => {
          dispatched = fireEvent.keyDown(solo, { key: 'Tab', shiftKey: true });
        });
        expect(dispatched).toBe(false);
        expect(document.activeElement).toBe(solo);
      }
    });

    it('recovers focus to the single element when focus starts outside', () => {
      render(
        <div>
          <button type="button" id="outside-btn">Outside</button>
          <Modal open={true} onClose={() => {}}>
            <button type="button" id="solo-btn">Only Button</button>
          </Modal>
        </div>,
      );

      const outside = document.getElementById('outside-btn') as HTMLElement;
      const solo = document.getElementById('solo-btn') as HTMLElement;

      outside.focus();
      expect(document.activeElement).toBe(outside);

      act(() => {
        fireEvent.keyDown(outside, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(solo);

      outside.focus();
      expect(document.activeElement).toBe(outside);

      act(() => {
        fireEvent.keyDown(outside, { key: 'Tab', shiftKey: true });
      });
      expect(document.activeElement).toBe(solo);
    });

    it('stays focused on single focusable element even when surrounded by disabled & hidden items', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" disabled id="dis-before">Disabled Before</button>
          <input type="hidden" id="hid-before" />
          <button type="button" id="the-one">The One</button>
          <a href="#link" tabIndex={-1} id="link-after">Link After</a>
          <button type="button" aria-hidden="true" id="aria-after">Aria After</button>
        </Modal>,
      );

      const theOne = document.getElementById('the-one') as HTMLElement;
      expect(document.activeElement).toBe(theOne);

      act(() => {
        fireEvent.keyDown(theOne, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(theOne);

      act(() => {
        fireEvent.keyDown(theOne, { key: 'Tab', shiftKey: true });
      });
      expect(document.activeElement).toBe(theOne);
    });
  });

  // -------------------------------------------------------------------------
  // Mission 1.3: Disabled buttons, hidden inputs (type="hidden"), negative tabindex="-1", aria-hidden="true"
  // -------------------------------------------------------------------------
  describe('Boundary Condition 3: Skipping non-focusable elements', () => {
    it('strictly skips disabled buttons, type="hidden" inputs, negative tabindex, and aria-hidden in forward and backward traversal', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="valid-1">Valid 1</button>
          {/* Non-focusable 1: disabled button */}
          <button type="button" disabled id="skip-disabled-btn">Disabled Button</button>
          {/* Non-focusable 2: hidden input */}
          <input type="hidden" id="skip-hidden-input" value="123" />
          {/* Non-focusable 3: anchor with tabindex="-1" */}
          <a href="https://example.com" tabIndex={-1} id="skip-negative-anchor">Negative Anchor</a>
          {/* Non-focusable 4: button with aria-hidden="true" */}
          <button type="button" aria-hidden="true" id="skip-aria-hidden-btn">Aria Hidden Button</button>
          {/* Non-focusable 5: input with disabled attribute */}
          <input type="text" disabled id="skip-disabled-input" />
          {/* Non-focusable 6: div with tabindex="-1" */}
          <div tabIndex={-1} id="skip-negative-div">Negative Div</div>
          {/* Non-focusable 7: element with display: none */}
          <button type="button" style={{ display: 'none' }} id="skip-display-none">Display None</button>
          {/* Non-focusable 8: element with visibility: hidden */}
          <button type="button" style={{ visibility: 'hidden' }} id="skip-visibility-hidden">Visibility Hidden</button>
          <button type="button" id="valid-2">Valid 2</button>
          {/* Non-focusable 9: trailing disabled select */}
          <select disabled id="skip-disabled-select"><option>Opt</option></select>
          {/* Non-focusable 10: trailing textarea with negative tabindex */}
          <textarea tabIndex={-1} id="skip-negative-textarea" />
          <button type="button" id="valid-3">Valid 3</button>
        </Modal>,
      );

      const v1 = document.getElementById('valid-1') as HTMLElement;
      const v2 = document.getElementById('valid-2') as HTMLElement;
      const v3 = document.getElementById('valid-3') as HTMLElement;

      const skippedIds = [
        'skip-disabled-btn',
        'skip-hidden-input',
        'skip-negative-anchor',
        'skip-aria-hidden-btn',
        'skip-disabled-input',
        'skip-negative-div',
        'skip-display-none',
        'skip-visibility-hidden',
        'skip-disabled-select',
        'skip-negative-textarea',
      ];

      // Initial focus is on valid-1
      expect(document.activeElement).toBe(v1);

      // Forward Tab from v1 should skip all 8 non-focusable elements and land directly on v2
      act(() => {
        fireEvent.keyDown(v1, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(v2);

      // Forward Tab from v2 should skip select and textarea and land on v3
      act(() => {
        fireEvent.keyDown(v2, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(v3);

      // Forward Tab from v3 wraps back to v1
      act(() => {
        fireEvent.keyDown(v3, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(v1);

      // Backward Tab from v1 wraps to v3
      act(() => {
        fireEvent.keyDown(v1, { key: 'Tab', shiftKey: true });
      });
      expect(document.activeElement).toBe(v3);

      // Backward Tab from v3 skips non-focusable elements and lands on v2
      act(() => {
        fireEvent.keyDown(v3, { key: 'Tab', shiftKey: true });
      });
      expect(document.activeElement).toBe(v2);

      // Backward Tab from v2 skips all 8 non-focusable elements and lands on v1
      act(() => {
        fireEvent.keyDown(v2, { key: 'Tab', shiftKey: true });
      });
      expect(document.activeElement).toBe(v1);

      // Verify none of the skipped elements were ever focused
      for (const id of skippedIds) {
        const el = document.getElementById(id);
        expect(el).not.toBeNull();
        expect(document.activeElement).not.toBe(el);
      }
    });

    it('dynamically respects mutation when an active element becomes disabled', () => {
      function DynamicHarness() {
        const [disabled, setDisabled] = useState(false);
        return (
          <Modal open={true} onClose={() => {}}>
            <button type="button" id="btn-toggle" onClick={() => setDisabled(true)}>
              Disable Next
            </button>
            <button type="button" id="btn-target" disabled={disabled}>
              Target
            </button>
            <button type="button" id="btn-last">
              Last
            </button>
          </Modal>
        );
      }

      render(<DynamicHarness />);

      const toggle = document.getElementById('btn-toggle') as HTMLElement;
      const target = document.getElementById('btn-target') as HTMLElement;
      const last = document.getElementById('btn-last') as HTMLElement;

      expect(document.activeElement).toBe(toggle);

      // While target is enabled: Tab goes toggle -> target -> last
      act(() => {
        fireEvent.keyDown(toggle, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(target);

      act(() => {
        fireEvent.keyDown(target, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(last);

      // Wrap back to toggle
      act(() => {
        fireEvent.keyDown(last, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(toggle);

      // Click toggle to disable target
      act(() => {
        fireEvent.click(toggle);
      });
      expect(target.hasAttribute('disabled')).toBe(true);

      // Now Tab from toggle should skip disabled target and land directly on last
      act(() => {
        fireEvent.keyDown(toggle, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(last);

      // Shift+Tab from last should skip disabled target and land on toggle
      act(() => {
        fireEvent.keyDown(last, { key: 'Tab', shiftKey: true });
      });
      expect(document.activeElement).toBe(toggle);
    });
  });

  // -------------------------------------------------------------------------
  // Mission 1.4: Forward wrapping: pressing Tab on last element wraps to first
  // -------------------------------------------------------------------------
  describe('Boundary Condition 4: Forward Tab wrapping', () => {
    it('wraps focus from last element back to first element across 5 full cycles', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <input type="text" id="el-1" />
          <select id="el-2"><option>A</option></select>
          <textarea id="el-3" />
          <a href="#test" id="el-4">Link</a>
          <button type="button" id="el-5">Submit</button>
        </Modal>,
      );

      const el1 = document.getElementById('el-1') as HTMLElement;
      const el2 = document.getElementById('el-2') as HTMLElement;
      const el3 = document.getElementById('el-3') as HTMLElement;
      const el4 = document.getElementById('el-4') as HTMLElement;
      const el5 = document.getElementById('el-5') as HTMLElement;

      expect(document.activeElement).toBe(el1);

      // Run 5 full traversal cycles (25 Tab presses)
      for (let cycle = 0; cycle < 5; cycle++) {
        act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); });
        expect(document.activeElement).toBe(el2);

        act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); });
        expect(document.activeElement).toBe(el3);

        act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); });
        expect(document.activeElement).toBe(el4);

        act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); });
        expect(document.activeElement).toBe(el5);

        // Tab on last element (el5) must wrap to first element (el1)
        let dispatched = false;
        act(() => {
          dispatched = fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
        });
        expect(dispatched).toBe(false);
        expect(document.activeElement).toBe(el1);
      }
    });

    it('works cleanly when modal panel contains exactly 2 elements', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="btn-alpha">Alpha</button>
          <button type="button" id="btn-beta">Beta</button>
        </Modal>,
      );

      const alpha = document.getElementById('btn-alpha') as HTMLElement;
      const beta = document.getElementById('btn-beta') as HTMLElement;

      expect(document.activeElement).toBe(alpha);

      // Tab to beta
      act(() => { fireEvent.keyDown(alpha, { key: 'Tab' }); });
      expect(document.activeElement).toBe(beta);

      // Tab on beta wraps to alpha
      act(() => { fireEvent.keyDown(beta, { key: 'Tab' }); });
      expect(document.activeElement).toBe(alpha);
    });
  });

  // -------------------------------------------------------------------------
  // Mission 1.5: Backward wrapping: pressing Shift+Tab on first element wraps to last
  // -------------------------------------------------------------------------
  describe('Boundary Condition 5: Backward Shift+Tab wrapping', () => {
    it('wraps focus from first element back to last element across 5 full cycles', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <input type="text" id="node-1" />
          <select id="node-2"><option>A</option></select>
          <textarea id="node-3" />
          <a href="#test" id="node-4">Link</a>
          <button type="button" id="node-5">Submit</button>
        </Modal>,
      );

      const n1 = document.getElementById('node-1') as HTMLElement;
      const n2 = document.getElementById('node-2') as HTMLElement;
      const n3 = document.getElementById('node-3') as HTMLElement;
      const n4 = document.getElementById('node-4') as HTMLElement;
      const n5 = document.getElementById('node-5') as HTMLElement;

      expect(document.activeElement).toBe(n1);

      // Run 5 full backward cycles
      for (let cycle = 0; cycle < 5; cycle++) {
        // Shift+Tab on first element (n1) must wrap to last element (n5)
        let dispatched = false;
        act(() => {
          dispatched = fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
        });
        expect(dispatched).toBe(false);
        expect(document.activeElement).toBe(n5);

        act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true }); });
        expect(document.activeElement).toBe(n4);

        act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true }); });
        expect(document.activeElement).toBe(n3);

        act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true }); });
        expect(document.activeElement).toBe(n2);

        act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true }); });
        expect(document.activeElement).toBe(n1);
      }
    });

    it('works cleanly in reverse when modal panel contains exactly 2 elements', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="btn-first">First</button>
          <button type="button" id="btn-second">Second</button>
        </Modal>,
      );

      const first = document.getElementById('btn-first') as HTMLElement;
      const second = document.getElementById('btn-second') as HTMLElement;

      expect(document.activeElement).toBe(first);

      // Shift+Tab on first wraps to second
      act(() => { fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); });
      expect(document.activeElement).toBe(second);

      // Shift+Tab on second moves to first
      act(() => { fireEvent.keyDown(second, { key: 'Tab', shiftKey: true }); });
      expect(document.activeElement).toBe(first);
    });
  });

  // -------------------------------------------------------------------------
  // Mission 1.6: Focus recovery when focus accidentally lands outside panel
  // -------------------------------------------------------------------------
  describe('Boundary Condition 6: Focus recovery from outside panel', () => {
    it('pulls focus to first element when Tab is pressed from preceding outside element', () => {
      render(
        <div>
          <button type="button" id="outside-preceding">Preceding Outside</button>
          <Modal open={true} onClose={() => {}}>
            <button type="button" id="modal-first">Modal First</button>
            <button type="button" id="modal-middle">Modal Middle</button>
            <button type="button" id="modal-last">Modal Last</button>
          </Modal>
        </div>,
      );

      const outside = document.getElementById('outside-preceding') as HTMLElement;
      const first = document.getElementById('modal-first') as HTMLElement;

      outside.focus();
      expect(document.activeElement).toBe(outside);

      let dispatched = false;
      act(() => {
        dispatched = fireEvent.keyDown(outside, { key: 'Tab' });
      });

      expect(dispatched).toBe(false);
      expect(document.activeElement).toBe(first);
    });

    it('pulls focus to last element when Shift+Tab is pressed from subsequent outside element', () => {
      render(
        <div>
          <Modal open={true} onClose={() => {}}>
            <button type="button" id="modal-first">Modal First</button>
            <button type="button" id="modal-middle">Modal Middle</button>
            <button type="button" id="modal-last">Modal Last</button>
          </Modal>
          <button type="button" id="outside-subsequent">Subsequent Outside</button>
        </div>,
      );

      const outside = document.getElementById('outside-subsequent') as HTMLElement;
      const last = document.getElementById('modal-last') as HTMLElement;

      outside.focus();
      expect(document.activeElement).toBe(outside);

      let dispatched = false;
      act(() => {
        dispatched = fireEvent.keyDown(outside, { key: 'Tab', shiftKey: true });
      });

      expect(dispatched).toBe(false);
      expect(document.activeElement).toBe(last);
    });

    it('pulls focus to first element on Tab when document.body is active', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="modal-first">Modal First</button>
          <button type="button" id="modal-last">Modal Last</button>
        </Modal>,
      );

      const first = document.getElementById('modal-first') as HTMLElement;

      // Blur to set activeElement to document.body
      first.blur();
      expect(document.activeElement).toBe(document.body);

      let dispatched = false;
      act(() => {
        dispatched = fireEvent.keyDown(document.body, { key: 'Tab' });
      });

      expect(dispatched).toBe(false);
      expect(document.activeElement).toBe(first);
    });

    it('pulls focus to last element on Shift+Tab when document.body is active', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="modal-first">Modal First</button>
          <button type="button" id="modal-last">Modal Last</button>
        </Modal>,
      );

      const last = document.getElementById('modal-last') as HTMLElement;

      (document.activeElement as HTMLElement)?.blur();
      expect(document.activeElement).toBe(document.body);

      let dispatched = false;
      act(() => {
        dispatched = fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
      });

      expect(dispatched).toBe(false);
      expect(document.activeElement).toBe(last);
    });

    it('pulls focus back into panel if user clicks or focuses backdrop and presses Tab or Shift+Tab', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="inside-first">Inside First</button>
          <button type="button" id="inside-last">Inside Last</button>
        </Modal>,
      );

      const backdrop = document.querySelector('[data-pyric-modal-backdrop]') as HTMLElement;
      const first = document.getElementById('inside-first') as HTMLElement;
      const last = document.getElementById('inside-last') as HTMLElement;

      // In some browsers or custom CSS, backdrop might receive focus
      backdrop.tabIndex = 0;
      backdrop.focus();
      expect(document.activeElement).toBe(backdrop);

      // Tab from backdrop snaps to first element
      act(() => {
        fireEvent.keyDown(backdrop, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(first);

      // Shift+Tab from backdrop snaps to last element
      backdrop.focus();
      expect(document.activeElement).toBe(backdrop);

      act(() => {
        fireEvent.keyDown(backdrop, { key: 'Tab', shiftKey: true });
      });
      expect(document.activeElement).toBe(last);
    });

    it('correctly identifies active focus when focused element is nested inside a focusable button', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="btn-compound">
            <span id="nested-span">Click text</span>
            <svg id="nested-svg" width="16" height="16">
              <circle cx="8" cy="8" r="8" />
            </svg>
          </button>
          <button type="button" id="btn-next">Next</button>
        </Modal>,
      );

      const nestedSpan = document.getElementById('nested-span') as HTMLElement;
      const nextBtn = document.getElementById('btn-next') as HTMLElement;

      // Suppose activeElement is reported as the nested span inside the button
      nestedSpan.tabIndex = -1;
      nestedSpan.focus();

      // Press Tab while nested span is active
      act(() => {
        fireEvent.keyDown(nestedSpan, { key: 'Tab' });
      });
      // Should advance from compoundBtn to nextBtn
      expect(document.activeElement).toBe(nextBtn);
    });
  });

  // -------------------------------------------------------------------------
  // Mission 1.7: Dynamic DOM mutations, negative tabIndexes across tag types, and lifecycle
  // -------------------------------------------------------------------------
  describe('Boundary Condition 7: Dynamic DOM mutations & exotic focusables', () => {
    it('adapts immediately when zero-focusable panel dynamically gains a focusable child', () => {
      function DynamicAddHarness() {
        const [hasButton, setHasButton] = useState(false);
        return (
          <div>
            <button type="button" id="btn-add" onClick={() => setHasButton(true)}>
              Add Button
            </button>
            <Modal open={true} onClose={() => {}}>
              <p>Dynamic container</p>
              {hasButton && <button type="button" id="dynamic-btn">I am new</button>}
            </Modal>
          </div>
        );
      }

      render(<DynamicAddHarness />);

      const panel = document.querySelector('[data-pyric-modal-panel]') as HTMLElement;
      expect(document.activeElement).toBe(panel);

      // Initially zero focusables: Tab stays on panel
      act(() => {
        fireEvent.keyDown(panel, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(panel);

      // Dynamically add a button to the panel
      const addBtn = document.getElementById('btn-add') as HTMLElement;
      act(() => {
        fireEvent.click(addBtn);
      });

      const dynamicBtn = document.getElementById('dynamic-btn') as HTMLElement;
      expect(dynamicBtn).not.toBeNull();

      // Press Tab: should now immediately find and focus dynamicBtn
      act(() => {
        fireEvent.keyDown(panel, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(dynamicBtn);
    });

    it('recovers cleanly when the currently focused child is unmounted from DOM', () => {
      function RemovalHarness() {
        const [showFirst, setShowFirst] = useState(true);
        return (
          <Modal open={true} onClose={() => {}}>
            {showFirst ? (
              <button
                type="button"
                id="btn-ephemeral"
                onClick={() => setShowFirst(false)}
              >
                Ephemeral
              </button>
            ) : null}
            <button type="button" id="btn-persistent">
              Persistent
            </button>
          </Modal>
        );
      }

      render(<RemovalHarness />);

      const ephemeral = document.getElementById('btn-ephemeral') as HTMLElement;
      const persistent = document.getElementById('btn-persistent') as HTMLElement;

      expect(document.activeElement).toBe(ephemeral);

      // Click ephemeral button which unmounts itself
      act(() => {
        fireEvent.click(ephemeral);
      });

      // Active element is now detached/body
      expect(document.getElementById('btn-ephemeral')).toBeNull();

      // Press Tab: focus recovery must pull focus to persistent button
      let dispatched = false;
      act(() => {
        dispatched = fireEvent.keyDown(document.body, { key: 'Tab' });
      });

      expect(dispatched).toBe(false);
      expect(document.activeElement).toBe(persistent);
    });

    it('rigorously excludes tabIndex={-1} across all HTML element kinds', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="start-btn">Start</button>
          <input type="text" tabIndex={-1} id="neg-input" />
          <textarea tabIndex={-1} id="neg-textarea" />
          <select tabIndex={-1} id="neg-select"><option>O</option></select>
          <a href="https://example.com" tabIndex={-1} id="neg-a">Neg Link</a>
          <button type="button" tabIndex={-1} id="neg-btn">Neg Button</button>
          <div contentEditable="true" tabIndex={-1} id="neg-editable">Neg Editable</div>
          <button type="button" id="end-btn">End</button>
        </Modal>,
      );

      const start = document.getElementById('start-btn') as HTMLElement;
      const end = document.getElementById('end-btn') as HTMLElement;

      expect(document.activeElement).toBe(start);

      // Tab from start should jump straight to end
      act(() => {
        fireEvent.keyDown(start, { key: 'Tab' });
      });
      expect(document.activeElement).toBe(end);

      // Shift+Tab from end should jump straight back to start
      act(() => {
        fireEvent.keyDown(end, { key: 'Tab', shiftKey: true });
      });
      expect(document.activeElement).toBe(start);
    });

    it('correctly cycles through various non-hidden input types and contenteditable with tabIndex=0', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <input type="password" id="inp-pwd" />
          <input type="checkbox" id="inp-chk" />
          <input type="radio" id="inp-rad" />
          <input type="number" id="inp-num" />
          <input type="hidden" id="inp-hidden-skip" />
          <div contentEditable="true" tabIndex={0} id="div-editable">Editable</div>
        </Modal>,
      );

      const pwd = document.getElementById('inp-pwd') as HTMLElement;
      const chk = document.getElementById('inp-chk') as HTMLElement;
      const rad = document.getElementById('inp-rad') as HTMLElement;
      const num = document.getElementById('inp-num') as HTMLElement;
      const edit = document.getElementById('div-editable') as HTMLElement;

      expect(document.activeElement).toBe(pwd);

      act(() => { fireEvent.keyDown(pwd, { key: 'Tab' }); });
      expect(document.activeElement).toBe(chk);

      act(() => { fireEvent.keyDown(chk, { key: 'Tab' }); });
      expect(document.activeElement).toBe(rad);

      act(() => { fireEvent.keyDown(rad, { key: 'Tab' }); });
      expect(document.activeElement).toBe(num);

      // From num, must skip inp-hidden-skip and jump to div-editable
      act(() => { fireEvent.keyDown(num, { key: 'Tab' }); });
      expect(document.activeElement).toBe(edit);

      // From div-editable, wraps back to inp-pwd
      act(() => { fireEvent.keyDown(edit, { key: 'Tab' }); });
      expect(document.activeElement).toBe(pwd);
    });

    it('empirically reveals that contenteditable div without explicit tabIndex is filtered by tabIndex < 0 check', () => {
      render(
        <Modal open={true} onClose={() => {}}>
          <button type="button" id="btn-start">Start</button>
          <div contentEditable="true" id="div-no-tabindex">No TabIndex</div>
          <button type="button" id="btn-end">End</button>
        </Modal>,
      );

      const start = document.getElementById('btn-start') as HTMLElement;
      const noTabIndex = document.getElementById('div-no-tabindex') as HTMLElement;
      const end = document.getElementById('btn-end') as HTMLElement;

      expect(document.activeElement).toBe(start);

      // In JSDOM and DOM specs, div.tabIndex is -1 by default unless tabindex is declared,
      // so Modal.tsx getFocusableElements filter (el.tabIndex < 0) skips it.
      expect(noTabIndex.tabIndex).toBe(-1);

      act(() => {
        fireEvent.keyDown(start, { key: 'Tab' });
      });
      // Direct jump to end, skipping div-no-tabindex
      expect(document.activeElement).toBe(end);
    });

    it('releases global keydown listener when closed and does not intercept Tab when open=false', () => {
      function OpenCloseHarness() {
        const [open, setOpen] = useState(true);
        return (
          <div>
            <button type="button" id="host-btn" onClick={() => setOpen(false)}>
              Close Modal
            </button>
            <button type="button" id="other-host-btn">
              Other Host
            </button>
            <Modal open={open} onClose={() => setOpen(false)}>
              <button type="button" id="modal-btn">Modal Btn</button>
            </Modal>
          </div>
        );
      }

      render(<OpenCloseHarness />);

      const modalBtn = document.getElementById('modal-btn') as HTMLElement;
      expect(document.activeElement).toBe(modalBtn);

      // Close modal
      act(() => {
        fireEvent.click(document.getElementById('host-btn')!);
      });

      expect(document.querySelector('[data-pyric-ui="modal"]')).toBeNull();

      const hostBtn = document.getElementById('host-btn') as HTMLElement;
      hostBtn.focus();
      expect(document.activeElement).toBe(hostBtn);

      // When modal is closed, keydown event must NOT be intercepted or preventDefault'ed
      let dispatched = true;
      act(() => {
        dispatched = fireEvent.keyDown(hostBtn, { key: 'Tab' });
      });

      // Default is NOT prevented because listener was unmounted
      expect(dispatched).toBe(true);
    });
  });
});
