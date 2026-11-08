import { describe, expect, test } from 'bun:test';
import { alternatives, literalText, type AVal } from '../../../src/assurance-surface/code/values.js';
import { harness } from './harness.js';

const strings = (v: AVal): (string | null)[] => alternatives(v).map(literalText);

describe('AssignmentResolver', () => {
  test('resolves ||= and ??= top-level parameter defaults without keeping eliminated nullish/falsy arms', () => {
    const h = harness({
      'a.ts': `
        function normalize(mode?: string, label?: string | null) {
          mode ||= 'standard';
          label ??= 'untitled';
          return { mode, label };
        }
        export const out = normalize('', null);
      `,
    });
    const outVal = h.ev.force(h.ev.eval(h.ident('a.ts', 'out', 0)));
    expect(outVal.k).toBe('obj');
    if (outVal.k === 'obj') {
      expect(strings(h.ev.force(outVal.props.get('mode')!))).toEqual(['standard']);
      expect(strings(h.ev.force(outVal.props.get('label')!))).toEqual(['untitled']);
    }
  });

  test('tracks post-declaration property and bracketed element mutations on local objects', () => {
    const h = harness({
      'a.ts': `
        const key = 'role';
        const payload: Record<string, string> = { kind: 'member' };
        payload.status = 'active';
        payload[key] = 'editor';
        export const result = payload;
      `,
    });
    const outVal = h.ev.force(h.ev.eval(h.ident('a.ts', 'result', 0)));
    expect(outVal.k).toBe('obj');
    if (outVal.k === 'obj') {
      expect(literalText(h.ev.force(outVal.props.get('kind')!))).toBe('member');
      expect(literalText(h.ev.force(outVal.props.get('status')!))).toBe('active');
      expect(literalText(h.ev.force(outVal.props.get('role')!))).toBe('editor');
    }
  });

  test('resolves nested object/array destructuring with defaults and React useState updates', () => {
    const h = harness({
      'comp.tsx': `
        import { useState } from 'react';
        export function Widget() {
          const [tab, setTab] = useState(() => 'overview');
          const { meta: { slug = 'home' } } = { meta: {} as { slug?: string } };
          const switchTab = () => setTab('settings');
          return [tab, slug, switchTab];
        }
      `,
    });
    expect(strings(h.ev.force(h.ev.eval(h.ident('comp.tsx', 'tab', 1))))).toEqual(['overview', 'settings']);
    const slugStrings = strings(h.ev.force(h.ev.eval(h.ident('comp.tsx', 'slug', 2)))).filter((s): s is string => s !== null);
    expect(slugStrings).toEqual(['home']);
  });
});
