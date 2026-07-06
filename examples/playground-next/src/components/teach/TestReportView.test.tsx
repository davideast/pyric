/**
 * Render-state tests for the `run_workspace_tests` teach renderer —
 * same renderToString pattern as teach-components.render.test.tsx
 * (no DOM runner; assert that each render STATE produces or
 * suppresses the right markup), plus pure-model tests for the
 * defensive parser and the fix-prompt wording regimes.
 */
import { describe, test, expect } from 'bun:test';
import { renderToString as reactRenderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { TestRunReport } from '~/lib/workspace-tests/runner';
import {
  buildTestFixPrompt,
  formatIdentity,
  parseRunWorkspaceTestsResult,
  TestReportView,
} from './TestReportView';
import { ToolDetailView } from '../ToolDetailView';
import type { ToolCall } from '~/lib/store/chat';

/** Strip React's text-node separator comments so assertions can match
 *  across adjacent expressions like `{passed}/{total}`. */
function renderToString(el: ReactElement): string {
  return reactRenderToString(el).replaceAll('<!-- -->', '');
}

const allGreen: TestRunReport = {
  files: [
    { file: 'owners.test.json', total: 3, passed: 3, failures: [] },
    { file: 'floor.test.json', total: 2, passed: 2, failures: [] },
  ],
  total: 5,
  passed: 5,
  failed: 0,
  ok: true,
};

const mixed: TestRunReport = {
  files: [
    {
      file: 'owners.test.json',
      total: 4,
      passed: 1,
      failures: [
        {
          name: 'strangers cannot read orders',
          method: 'get',
          path: 'orders/ord1',
          as: { uid: 'bob' },
          expect: 'DENY',
          got: 'ALLOW',
          source: 'authored',
        },
        {
          method: 'update',
          path: 'orders/missing',
          as: { uid: 'alice', token: { admin: true } },
          expect: 'ALLOW',
          got: 'ERROR',
          source: 'authored',
          detail: 'no document to update: orders/missing',
        },
        {
          method: 'list',
          path: 'orders',
          as: null,
          expect: 'DENY',
          got: 'ALLOW',
          source: 'floor',
        },
      ],
    },
  ],
  total: 4,
  passed: 1,
  failed: 3,
  ok: false,
};

const fileError: TestRunReport = {
  files: [
    {
      file: 'broken.test.json',
      total: 0,
      passed: 0,
      failures: [],
      error: 'rules deploy failed: unexpected token at line 3',
    },
  ],
  total: 0,
  passed: 0,
  failed: 0,
  ok: false,
};

describe('parseRunWorkspaceTestsResult', () => {
  test('absent / unparseable / wrong-shape json → null (generic panel)', () => {
    expect(parseRunWorkspaceTestsResult(undefined)).toBeNull();
    expect(parseRunWorkspaceTestsResult('')).toBeNull();
    expect(parseRunWorkspaceTestsResult('not json {')).toBeNull();
    expect(parseRunWorkspaceTestsResult('"a string"')).toBeNull();
    expect(parseRunWorkspaceTestsResult(JSON.stringify({ some: 'thing' }))).toBeNull();
  });

  test('refusal payload parses as refusal', () => {
    const parsed = parseRunWorkspaceTestsResult(JSON.stringify({ reason: 'no ruleset' }));
    expect(parsed).toEqual({ kind: 'refusal', reason: 'no ruleset' });
  });

  test('report payload parses as report', () => {
    const parsed = parseRunWorkspaceTestsResult(JSON.stringify(allGreen));
    expect(parsed?.kind).toBe('report');
    if (parsed?.kind === 'report') expect(parsed.report.passed).toBe(5);
  });
});

describe('formatIdentity', () => {
  test('null → anon; uid; uid + claims', () => {
    expect(formatIdentity(null)).toBe('anon');
    expect(formatIdentity({ uid: 'alice' })).toBe('alice');
    expect(formatIdentity({ uid: 'alice', token: { admin: true } })).toBe('alice {"admin":true}');
    expect(formatIdentity({ uid: 'alice', token: {} })).toBe('alice');
  });
});

describe('buildTestFixPrompt wording regimes', () => {
  test('authored mismatch allows "the test expectation is wrong"', () => {
    const p = buildTestFixPrompt('owners.test.json', mixed.files[0]!.failures[0]!);
    expect(p).toContain('/workspace/tests/owners.test.json');
    expect(p).toContain('- operation: get orders/ord1');
    expect(p).toContain('- expected: DENY');
    expect(p).toContain('- got: ALLOW');
    expect(p).toContain('(a) the rules');
    expect(p).toContain('(b) the test expectation');
    expect(p).toContain('run_workspace_tests');
  });

  test('ERROR failure directs to the test/seed and forbids rules edits', () => {
    const p = buildTestFixPrompt('owners.test.json', mixed.files[0]!.failures[1]!);
    expect(p).toContain('- detail: no document to update: orders/missing');
    expect(p).toContain('the TEST or its SEED is wrong, not the rules');
    expect(p).toContain('Do NOT edit /workspace/firestore.rules');
    expect(p).not.toContain('(b) the test expectation');
  });

  test('floor failure fixes the rules and forbids test edits', () => {
    const p = buildTestFixPrompt('owners.test.json', mixed.files[0]!.failures[2]!);
    expect(p).toContain('- identity: unauthenticated (anon)');
    expect(p).toContain('host-authored floor invariant');
    expect(p).toContain('MINIMAL edit to /workspace/firestore.rules');
    expect(p).toContain('Do NOT change the test');
  });
});

describe('TestReportView render states', () => {
  test('all-green report: verdict header, per-file passes, no failure rows', () => {
    const html = renderToString(<TestReportView parsed={{ kind: 'report', report: allGreen }} />);
    expect(html).toContain('data-teach="test-report"');
    expect(html).toContain('5/5 passed');
    expect(html).toContain('across 2 files');
    expect(html).toContain('owners.test.json');
    expect(html).toContain('floor.test.json');
    expect(html).toContain('All cases passed.');
    expect(html).not.toContain('Send to agent');
    expect(html).not.toContain('file error');
  });

  test('mixed failures: rows with identity, expected vs got, ERROR note, floor badge, send', () => {
    const html = renderToString(<TestReportView parsed={{ kind: 'report', report: mixed }} />);
    expect(html).toContain('1/4 passed');
    expect(html).toContain('3 failing cases');
    // Authored mismatch row.
    expect(html).toContain('strangers cannot read orders');
    expect(html).toContain('orders/ord1');
    expect(html).toContain('bob');
    // ERROR row: detail + teaching note, amber-distinct.
    expect(html).toContain('no document to update: orders/missing');
    expect(html).toContain('the test or its seed is wrong');
    expect(html).toContain('alice {&quot;admin&quot;:true}');
    // Floor row: badge + anon identity.
    expect(html).toContain('floor');
    expect(html).toContain('Host-authored floor invariant');
    expect(html).toContain('anon');
    // Hand-off per failure.
    expect(html.split('Send to agent').length - 1).toBe(3);
  });

  test('file-level error is called out distinctly', () => {
    const html = renderToString(<TestReportView parsed={{ kind: 'report', report: fileError }} />);
    expect(html).toContain('file error');
    expect(html).toContain('did not run');
    expect(html).toContain('rules deploy failed: unexpected token at line 3');
    expect(html).toContain('No cases in this file ran');
  });

  test('tool refusal payloads explain themselves', () => {
    const html = renderToString(
      <TestReportView parsed={{ kind: 'refusal', reason: 'no test files' }} />,
    );
    expect(html).toContain('no /workspace/tests/*.test.json files exist yet');
  });
});

describe('ToolDetailView dispatch for run_workspace_tests', () => {
  function call(resultJson?: string): ToolCall {
    return {
      id: 'c1',
      name: 'run_workspace_tests',
      argsJson: '{}',
      ...(resultJson !== undefined ? { resultJson, ok: true } : {}),
    };
  }
  const noop = () => {};

  test('parseable report renders the teach panel', () => {
    const html = renderToString(
      <ToolDetailView
        call={call(JSON.stringify(mixed))}
        messageId="m"
        time="12:00"
        onBack={noop}
      />,
    );
    expect(html).toContain('data-teach="test-report"');
    expect(html).toContain('1/4 passed');
  });

  test('unparseable / empty result falls back to the generic panel', () => {
    for (const c of [call('not json {'), call()]) {
      const html = renderToString(
        <ToolDetailView call={c} messageId="m" time="12:00" onBack={noop} />,
      );
      expect(html).not.toContain('data-teach="test-report"');
      // Generic always-shown sections still render.
      expect(html).toContain('Args');
    }
  });
});
