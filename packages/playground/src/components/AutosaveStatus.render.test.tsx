/**
 * Render states for the TopBar autosave indicator. Same idiom as the
 * teach-component render tests: no DOM runner, `renderToString`
 * checks that each STATE produces the right markup. The view half is
 * props-driven (the zustand hook resolves to initial state under
 * SSR), so states are injected directly. Popover toggling is client
 * interaction — the closed-by-default assertion covers the initial
 * render contract.
 */
import { describe, test, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { AutosaveStatusView } from './AutosaveStatus';
import { AUTOSAVE_TRUTH_COPY } from '~/lib/store/autosave';

describe('AutosaveStatus render states', () => {
  test('idle renders "Autosave on" with the truth copy as tooltip, popover closed', () => {
    const html = renderToString(
      <AutosaveStatusView state={{ status: 'idle' }} />,
    );
    expect(html).toContain('Autosave on');
    expect(html).toContain('aria-expanded="false"');
    // Tooltip carries the single-source persistence claim.
    expect(html).toContain('sandbox data is not yet saved');
    expect(AUTOSAVE_TRUTH_COPY).toContain('sandbox data is not yet saved');
  });

  test('saving renders the spinner state', () => {
    const html = renderToString(<AutosaveStatusView state={{ status: 'saving' }} />);
    expect(html).toContain('Saving…');
    expect(html).toContain('animate-spin');
  });

  test('saved renders the relative-time label', () => {
    const html = renderToString(
      <AutosaveStatusView state={{ status: 'saved', at: Date.now() }} />,
    );
    expect(html).toContain('Saved · just now');
  });

  test('error renders "Save failed" and folds the message into the tooltip', () => {
    const html = renderToString(
      <AutosaveStatusView state={{ status: 'error', message: 'quota exceeded' }} />,
    );
    expect(html).toContain('Save failed');
    expect(html).toContain('quota exceeded');
  });
});
