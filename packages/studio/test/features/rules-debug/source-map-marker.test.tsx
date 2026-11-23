import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.Window = dom.window.Window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MutationObserver = dom.window.MutationObserver;
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.Range.prototype.getClientRects = () => ([] as unknown as DOMRectList);

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { RequestEvent } from 'pyric/sandbox';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModulesBrowser } from 'pyric/rules/internal';
import { RulesDebug } from '../../../src/features/rules-debug/RulesDebug.js';
import {
  resolveMarkedLine,
  type AuthoredRuleLocation,
} from '../../../src/features/rules-debug/RulesDebugServiceDetails.js';
import {
  queryProofFailure,
  selectDenials,
  selectRuleEvaluations,
} from '../../../src/features/rules-debug/model.js';

const MAIN_COLLISION_MODULE = [
  "rules_version = '2+modules';",
  "import { published } from './policy.rules';",
  'service cloud.firestore {',
  ' match /databases/{db}/documents {',
  '  match /meets/{id} {',
  '   allow list: if published(resource.data);',
  '  }',
  '  match /{doc=**} { allow read: if false; }',
  ' }',
  '}',
].join('\n');

const POLICY_COLLISION_MODULE = [
  '',
  '',
  '',
  '',
  '',
  'export function published(data) {',
  " return data.status in ['scheduled'];",
  '}',
].join('\n');

let restoreAnimationFrames: (() => void) | undefined;

beforeEach(() => {
  const defaultView = document.defaultView;
  const prevGlobalRaf = g.requestAnimationFrame;
  const prevGlobalCaf = g.cancelAnimationFrame;
  const prevViewRaf = defaultView?.requestAnimationFrame;
  const prevViewCaf = defaultView?.cancelAnimationFrame;
  const noopRaf = (): number => 0;
  const noopCaf = (): void => {};
  g.requestAnimationFrame = noopRaf;
  g.cancelAnimationFrame = noopCaf;
  if (defaultView) {
    defaultView.requestAnimationFrame = noopRaf;
    defaultView.cancelAnimationFrame = noopCaf;
  }
  restoreAnimationFrames = () => {
    g.requestAnimationFrame = prevGlobalRaf;
    g.cancelAnimationFrame = prevGlobalCaf;
    if (defaultView && prevViewRaf && prevViewCaf) {
      defaultView.requestAnimationFrame = prevViewRaf;
      defaultView.cancelAnimationFrame = prevViewCaf;
    }
  };
  const rangeProto = Object.getPrototypeOf(document.createRange()) as Range;
  if (typeof rangeProto.getClientRects !== 'function') {
    rangeProto.getClientRects = () => ([] as unknown as DOMRectList);
  }
  if (typeof rangeProto.getBoundingClientRect !== 'function') {
    rangeProto.getBoundingClientRect = () => new dom.window.DOMRect();
  }
});

afterEach(() => {
  cleanup();
  restoreAnimationFrames?.();
  restoreAnimationFrames = undefined;
});

function compileCollisionFixture(): string {
  const resolved = resolveModulesBrowser(MAIN_COLLISION_MODULE, {
    modules: { './policy.rules': POLICY_COLLISION_MODULE },
  });
  if (!resolved.success) {
    throw new Error(`Expected collision fixture to resolve: ${resolved.error.message}`);
  }
  return resolved.data.resolved;
}

describe('RulesDebug source-map line disambiguation (#586)', () => {
  it('marks the relevant allow statement (generated line 8) rather than the imported helper (generated line 3) on a cross-file line collision', async () => {
    const resolvedSource = compileCollisionFixture();
    const env = new LocalEnvironment();
    const events: RequestEvent[] = [];
    try {
      env.seed({ rules: resolvedSource, documents: {} });
      env.onRequest((event) => events.push(event));

      const unfilteredResult = env.runQuery({
        scope: { kind: 'collection', path: 'meets' },
        auth: null,
        execution: { filters: [], orders: [], limitFromEnd: false },
      });
      expect(unfilteredResult.allowed).toBe(false);

      // Query authorization behavior remains unchanged for filtered queries too.
      const allowedResult = env.runQuery({
        scope: { kind: 'collection', path: 'meets' },
        auth: null,
        execution: {
          filters: [{ kind: 'where', field: 'status', op: '==', value: 'scheduled' }],
          orders: [],
          limitFromEnd: false,
        },
      });
      expect(allowedResult).toEqual({ allowed: true, docs: [] });

      const mismatchedResult = env.runQuery({
        scope: { kind: 'collection', path: 'meets' },
        auth: null,
        execution: {
          filters: [{ kind: 'where', field: 'status', op: '==', value: 'draft' }],
          orders: [],
          limitFromEnd: false,
        },
      });
      expect(mismatchedResult.allowed).toBe(false);
    } finally {
      env.dispose();
    }

    const serializedEvents = JSON.parse(JSON.stringify(events)) as RequestEvent[];
    const denials = selectDenials(serializedEvents);
    const proofDenial = denials.find((entry) => entry.queryProof?.kind === 'unsupported-predicate');
    expect(proofDenial).toBeDefined();
    if (!proofDenial) {
      throw new Error('Expected unsupported-predicate query-proof denial');
    }

    const failure = queryProofFailure(proofDenial);
    expect(failure?.predicate?.citation).toBe('./policy.rules:6:8');
    expect(failure?.rule?.citation).toBe('firestore.modules.rules:6:4');
    expect(resolveMarkedLine(resolvedSource, failure?.rule)).toBe(8);

    // Exercise Studio's real RulesDebug component and verify both the marked line
    // attribute and the rendered CodeMirror .cm-denyLine DOM text.
    const view = render(<RulesDebug denials={[proofDenial]} rulesSource={resolvedSource} />);
    const sourceHost = view.container.querySelector('[data-pyric-ui="firestore-rule-source"]');
    expect(sourceHost?.getAttribute('data-marked-line')).toBe('8');

    await waitFor(() => {
      const denyLine = view.container.querySelector('.cm-denyLine');
      expect(denyLine).not.toBeNull();
      expect(denyLine?.textContent).toContain('allow list: if published(resource.data);');
      expect(denyLine?.textContent).not.toContain('function published(data)');
    });

    // Also verify evaluatedRule allow-path disambiguation on the same collision source map.
    cleanup();
    const evaluations = selectRuleEvaluations(serializedEvents);
    const allowedEval = evaluations.find((entry) => entry.result === 'allow');
    expect(allowedEval).toBeDefined();
    if (!allowedEval) {
      throw new Error('Expected allowed query evaluation');
    }
    expect(resolveMarkedLine(resolvedSource, allowedEval.evaluatedRule)).toBe(8);
    const allowView = render(<RulesDebug denials={[allowedEval]} rulesSource={resolvedSource} />);
    expect(
      allowView.container
        .querySelector('[data-pyric-ui="firestore-rule-source"]')
        ?.getAttribute('data-marked-line'),
    ).toBe('8');

    // When a query-proof failure omits `failure.rule`, fallback to `denial.evaluatedRule` is preserved.
    cleanup();
    const firstFailure = proofDenial.queryProof?.failures[0];
    if (!firstFailure || !proofDenial.queryProof) {
      throw new Error('Expected queryProof failure fixture');
    }
    const withoutFailureRule = {
      ...proofDenial,
      queryProof: {
        ...proofDenial.queryProof,
        failures: [{ ...firstFailure, rule: undefined }],
      },
    };
    const fallbackView = render(
      <RulesDebug denials={[withoutFailureRule]} rulesSource={resolvedSource} />,
    );
    expect(
      fallbackView.container
        .querySelector('[data-pyric-ui="firestore-rule-source"]')
        ?.getAttribute('data-marked-line'),
    ).toBe('11');
  });

  it('disambiguates col vs column and citation fields, and refuses missing or ambiguous mappings', () => {
    const resolvedSource = compileCollisionFixture();

    // `col` vs `column` vs `citation`-only representations all select the exact entry.
    const byCol: AuthoredRuleLocation = {
      file: 'firestore.modules.rules',
      line: 6,
      col: 4,
    };
    const byColumn: AuthoredRuleLocation = {
      file: './policy.rules',
      line: 6,
      column: 8,
    };
    const byCitationOnly: AuthoredRuleLocation = {
      citation: 'firestore.modules.rules:6:4',
    };
    expect(resolveMarkedLine(resolvedSource, byCol)).toBe(8);
    expect(resolveMarkedLine(resolvedSource, byColumn)).toBe(3);
    expect(resolveMarkedLine(resolvedSource, byCitationOnly)).toBe(8);

    // Ambiguous bare line 6 (matches both generated line 3 and generated line 8) returns undefined.
    expect(resolveMarkedLine(resolvedSource, 6)).toBeUndefined();
    expect(resolveMarkedLine(resolvedSource, { line: 6 })).toBeUndefined();

    // Missing file, missing line, or mismatched column on modular source returns undefined
    // rather than falling back to an unrelated generated line.
    expect(
      resolveMarkedLine(resolvedSource, { file: './unknown.rules', line: 6, col: 4 }),
    ).toBeUndefined();
    expect(
      resolveMarkedLine(resolvedSource, { file: 'firestore.modules.rules', line: 99, col: 1 }),
    ).toBeUndefined();
    expect(
      resolveMarkedLine(resolvedSource, { file: 'firestore.modules.rules', line: 6, col: 99 }),
    ).toBeUndefined();
    expect(
      resolveMarkedLine("rules_version = '2';\n// @pyric-source-map: not-json\n", { line: 1 }),
    ).toBeUndefined();
  });

  it('preserves sensible lookup behavior for plain rules and incomplete older diagnostics', () => {
    const plainRules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    match /meets/{id} {',
      '      allow list: if request.auth != null;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(resolveMarkedLine(plainRules, 5)).toBe(5);
    expect(
      resolveMarkedLine(plainRules, {
        line: 5,
        citation: 'firestore.rules:5:7',
      }),
    ).toBe(5);
    expect(resolveMarkedLine(undefined, 5)).toBe(5);
    expect(resolveMarkedLine(plainRules, undefined)).toBeUndefined();

    const resolvedSource = compileCollisionFixture();
    // Unambiguous bare line in modular source (authored line 5 exists only in firestore.modules.rules -> generated line 7).
    expect(resolveMarkedLine(resolvedSource, 5)).toBe(7);
    expect(resolveMarkedLine(resolvedSource, { line: 5 })).toBe(7);

    // Incomplete diagnostic with line + expression (no file or column) still disambiguates line 6 -> generated line 8.
    expect(
      resolveMarkedLine(resolvedSource, {
        line: 6,
        expression: 'published(resource.data)',
      }),
    ).toBe(8);
  });
});
