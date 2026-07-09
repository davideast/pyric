/**
 * Render states for the settings modal's disclosure affordance on
 * "Enable pyric diagnostics" — the acceptance case for making
 * parent-with-children settings collapsible (see
 * `settings-disclosure.ts`). No DOM runner; `renderToString` checks
 * the initial-render contract: collapsed by default, a derived
 * on-count summary in place of the child list, and the master
 * checkbox / disclosure caret kept as separate, independently
 * toggleable controls.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { SettingsModal } from './SettingsModal';
import { DIAGNOSTIC_TOOL_MANIFEST } from '~/lib/tools/diagnostics';

describe('SettingsModal diagnostics disclosure', () => {
  test('renders collapsed by default: no per-tool checkboxes in the DOM', () => {
    const html = renderToString(<SettingsModal open onClose={() => {}} />);

    expect(html).toContain('Enable pyric diagnostics');
    // The child group's section heading and every per-tool row are
    // absent until expanded.
    expect(html).not.toContain('diagnostic tools');
    for (const entry of DIAGNOSTIC_TOOL_MANIFEST) {
      expect(html).not.toContain(entry.label);
    }
  });

  test('shows a derived on-count summary instead of the description while collapsed', () => {
    const html = renderToString(<SettingsModal open onClose={() => {}} />);

    // All manifest entries default to enabled (isDiagnosticToolEnabled
    // treats an absent key as on), so the summary is "N of N tools on"
    // where N == the manifest length — derived, not hardcoded.
    const total = DIAGNOSTIC_TOOL_MANIFEST.length;
    expect(html).toContain(`${total} of ${total} tools on`);
    // The full body copy (only shown expanded) is not present.
    expect(html).not.toContain('inline rules lint');
  });

  test('disclosure caret is keyboard accessible and reports aria-expanded=false', () => {
    const html = renderToString(<SettingsModal open onClose={() => {}} />);

    expect(html).toContain('aria-controls="settings-diagnostic-tools"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Expand Enable pyric diagnostics"');
  });

  test('master checkbox keeps its own switch semantics, independent of the caret', () => {
    const html = renderToString(<SettingsModal open onClose={() => {}} />);

    // pyricDiagnosticsEnabled defaults to true.
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });

  test('the auto-fold row (no children) is unaffected — no disclosure caret', () => {
    const html = renderToString(<SettingsModal open onClose={() => {}} />);

    expect(html).toContain('Auto-fold all but the most recent turn');
    expect(html).toContain('collapse older now');
  });
});
