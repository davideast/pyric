/**
 * SpecCard render states + the pure extractor. Same conventions as
 * teach-components.render.test.tsx: `renderToString`, no DOM runner —
 * does each STATE produce (or suppress) the right markup.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString as reactRenderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { extractSpecCardData, SpecCard } from './SpecCard';
import type { StrategyPhaseEvent } from '~/lib/store/chat';

function renderToString(el: ReactElement): string {
  return reactRenderToString(el).replaceAll('<!-- -->', '');
}

const SPEC_PAYLOAD = {
  title: 'Coffee shop ordering',
  assumptions: ['Anyone can browse the menu.'],
  matrix: [
    { collection: 'menuItems', op: 'get', grant: ['public'] },
    { collection: 'menuItems', op: 'create', grant: ['signed in', 'claim admin = true'] },
    { collection: 'orders', op: 'create', grant: ['owner only', 'price must match menuItems.price'] },
    { collection: 'orders', op: 'delete', grant: 'deny' as const },
  ],
  customConditions: 0,
  derivedCases: 38,
};

function vr(spec?: unknown): StrategyPhaseEvent {
  return { name: 'validation_result', data: { attempt: 0, ...(spec ? { spec } : {}) } };
}

describe('extractSpecCardData', () => {
  test('reads the LAST validation_result carrying a spec', () => {
    const events: StrategyPhaseEvent[] = [
      { name: 'draft_started', data: { attempt: 0 } },
      vr({ ...SPEC_PAYLOAD, title: 'old attempt' }),
      vr(SPEC_PAYLOAD),
    ];
    expect(extractSpecCardData(events)?.title).toBe('Coffee shop ordering');
  });

  test('no events / no spec payload / malformed payload → null (no chrome)', () => {
    expect(extractSpecCardData(undefined)).toBeNull();
    expect(extractSpecCardData([])).toBeNull();
    expect(extractSpecCardData([vr()])).toBeNull(); // fallback turn: no spec key
    expect(extractSpecCardData([vr({ title: 42, matrix: 'nope' })])).toBeNull();
    expect(extractSpecCardData([{ name: 'repair_started', data: {} }])).toBeNull();
  });
});

describe('SpecCard render states', () => {
  test('renders the matrix table, grant summaries, deny cells, and assumption callouts', () => {
    const html = renderToString(<SpecCard phaseEvents={[vr(SPEC_PAYLOAD)]} />);
    expect(html).toContain('data-teach="spec-card"');
    expect(html).toContain('Coffee shop ordering');
    expect(html).toContain('menuItems');
    expect(html).toContain('claim admin = true');
    expect(html).toContain('owner only · price must match menuItems.price');
    expect(html).toContain('deny');
    expect(html).toContain('Anyone can browse the menu.');
    expect(html).toContain('38 derived checks');
    expect(html).not.toContain('custom condition');
  });

  test('surfaces the custom-condition residue when present', () => {
    const html = renderToString(
      <SpecCard phaseEvents={[vr({ ...SPEC_PAYLOAD, customConditions: 2 })]} />,
    );
    expect(html).toContain('2 custom conditions');
    expect(html).toContain('not');
    expect(html).toContain('host-verified');
  });

  test('renders NOTHING without a spec payload (ReAct / fallback turns)', () => {
    expect(renderToString(<SpecCard phaseEvents={[vr()]} />)).toBe('');
    expect(renderToString(<SpecCard />)).toBe('');
  });
});
