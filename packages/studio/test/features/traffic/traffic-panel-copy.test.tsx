import { describe, expect, it } from 'bun:test';
import {
  BILLABLE_OPERATION_COPY,
  LIVE_RTDB_TRANSFER_COPY,
  RULES_PANEL_COPY,
  rulesDecisionSeriesForMode,
} from '../../../src/features/traffic/traffic-panel-copy.js';

describe('traffic-panel-copy', () => {
  it('separates sandbox vs live copy and relabels live Rules series as advisory', () => {
    expect(BILLABLE_OPERATION_COPY.sandbox.eyebrow).toBe('Billable activity');
    expect(BILLABLE_OPERATION_COPY.live.eyebrow).toBe('Operation-metered');
    expect(LIVE_RTDB_TRANSFER_COPY.eyebrow).toBe('Bandwidth-metered');
    expect(RULES_PANEL_COPY.sandbox.eyebrow).toBe('Rules decisions');
    expect(RULES_PANEL_COPY.live.eyebrow).toBe('Advisory local rules');

    const base = [
      { key: 'allows', label: 'Allows', values: [], total: 2 },
      { key: 'denies', label: 'Denies', values: [], total: 1 },
      { key: 'errors', label: 'Errors', values: [], total: 0 },
    ];
    expect(rulesDecisionSeriesForMode(base, 'sandbox').map((s) => s.label)).toEqual([
      'Allows',
      'Denies',
    ]);
    expect(rulesDecisionSeriesForMode(base, 'live').map((s) => s.label)).toEqual([
      'Would allow',
      'Would deny',
    ]);
  });
});
