// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
// The rules editor is CodeMirror, which observes its own DOM.
g.MutationObserver = dom.window.MutationObserver;
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import { getDatabase, get, ref, sandbox as rtdbSandbox } from 'pyric/database';
import { stripJsonComments } from 'pyric/sandbox/database';
import {
  RulesDebug,
  projectRtdbTrace,
  selectRuleEvaluations,
  type Denial,
} from '../../../src/features/rules-debug/index.js';

afterEach(() => cleanup());

// Rule lines are noted at the end of each row. A read of /rooms/alice as alice
// evaluates three rules root first: the root `.read` and `/rooms` `.read` deny,
// `/rooms/$roomId` `.read` grants.
const RULES = [
  '// database.rules.json', // 1
  '{', // 2
  '  "rules": {', // 3
  '    ".read": "false",', // 4
  '    "rooms": {', // 5
  '      ".read": "auth.token.admin === true",', // 6
  '      "$roomId": {', // 7
  '        ".read": "auth.uid === $roomId"', // 8
  '      }', // 9
  '    }', // 10
  '  }', // 11
  '}', // 12
].join('\n');

async function cascadeEvaluation(): Promise<Denial> {
  const sandbox = initializeSandbox();
  rtdbSandbox.setRules(getDatabase(sandbox), JSON.parse(stripJsonComments(RULES)));
  const events: SandboxEvent[] = [];
  sandbox.onEvent((e) => events.push(e));
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  await get(ref(db, '/rooms/alice'));
  const evaluation = selectRuleEvaluations(events).find((d) => d.service === 'rtdb');
  if (!evaluation) throw new Error('the read produced no RTDB rules event');
  return evaluation;
}

describe('RTDB evaluation trace in the rules debugger', () => {
  it('projects one row per evaluated rule with its source line', async () => {
    const denial = await cascadeEvaluation();
    const rows = projectRtdbTrace(denial, RULES);
    expect(
      rows.map((r) => [r.path, r.kind, r.step.source, r.step.outcome, r.line]),
    ).toEqual([
      ['/', 'read', 'false', 'false', 4],
      ['/rooms', 'read', 'auth.token.admin === true', 'false', 6],
      ['/rooms/$roomId', 'read', 'auth.uid === $roomId', 'true', 8],
    ]);
    expect(rows[2].bindings).toEqual({ $roomId: 'alice' });
  });

  it('carries a runtime error and an unsupported rule into the row with their message', () => {
    const denial: Denial = {
      id: 'e1', at: 0, result: 'deny', method: 'get', service: 'rtdb', path: '/rooms/alice',
      auth: null, reasons: [], origin: 'user', unsupported: false,
      rules: {
        engine: 'rtdb',
        rtdbTrace: [
          { path: '/', kind: 'read', conditionText: 'auth.uid.length > 1', verdict: 'ERROR', message: 'null has no property uid', pathVariableBindings: {} },
          { path: '/rooms', kind: 'read', conditionText: 'root.child("x").val()', verdict: 'UNSUPPORTED', message: 'root.child', pathVariableBindings: {} },
        ],
      },
    };
    const rows = projectRtdbTrace(denial, RULES);
    expect(rows.map((r) => [r.step.outcome, r.step.error, r.line])).toEqual([
      ['error', 'null has no property uid', 4],
      ['unsupported', 'root.child', 6],
    ]);
    const { container } = render(<RulesDebug denials={[denial]} rulesSource={RULES} />);
    const text = container.querySelector('[data-pyric-ui="rtdb-trace"]')?.textContent ?? '';
    expect(text).toContain('null has no property uid');
    expect(text).toContain('unsupported: root.child');
  });

  it('has no lines when the rules source is absent', async () => {
    const denial = await cascadeEvaluation();
    expect(projectRtdbTrace(denial, undefined).map((r) => r.line)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('renders a row per rule and highlights the line of the row that is clicked', async () => {
    const denial = await cascadeEvaluation();
    const { container } = render(<RulesDebug denials={[denial]} rulesSource={RULES} />);

    const rows = container.querySelectorAll('[data-pyric-ui="rtdb-trace-row"]');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('/');
    expect(rows[1].textContent).toContain('auth.token.admin === true');
    expect(rows[2].textContent).toContain('$roomId');
    expect(rows[2].textContent).toContain('alice');
    expect(Array.from(rows).map((r) => r.getAttribute('data-line'))).toEqual(['4', '6', '8']);

    const marked = () =>
      container.querySelector('[data-pyric-ui="rtdb-rule-source"]')?.getAttribute('data-marked-line');
    // Before any click the editor marks the rule that decided the operation.
    expect(marked()).toBe('8');

    fireEvent.click(rows[0].querySelector('button')!);
    expect(marked()).toBe('4');
    expect(rows[0].getAttribute('aria-current')).toBe('true');

    fireEvent.click(rows[1].querySelector('button')!);
    expect(marked()).toBe('6');
    expect(rows[0].getAttribute('aria-current')).toBeNull();
    expect(rows[1].getAttribute('aria-current')).toBe('true');
  });
});
