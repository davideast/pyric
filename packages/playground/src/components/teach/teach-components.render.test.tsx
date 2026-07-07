/**
 * Component-level render states for the teach surfaces (D5). The
 * playground has no DOM test runner; `renderToString` covers what
 * matters here — does each render STATE produce (or suppress) the
 * right markup — without a browser. Interaction paths (button
 * clicks, streaming) are exercised by the pure-model tests next to
 * each component.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { renderToString as reactRenderToString } from 'react-dom/server';
import type { ReactElement } from 'react';

/** renderToString with React's text-node separator comments
 *  (`<!-- -->`) stripped, so assertions can match across adjacent
 *  expressions like `+{count}`. */
function renderToString(el: ReactElement): string {
  return reactRenderToString(el).replaceAll('<!-- -->', '');
}
import { DiffView } from './DiffView';
import { StrategyStepper } from './StrategyStepper';
import { TurnAttribution } from './TurnAttribution';
import { DenialWalkthrough } from './DenialWalkthrough';
import { useChatStore, type ChatMessage, type ToolCall } from '~/lib/store/chat';
import { useRuntimeStore } from '~/lib/store/runtime';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: 'm', role: 'assistant', text: '', createdAt: 0, ...overrides };
}

beforeEach(() => {
  useChatStore.getState().clear();
  useRuntimeStore.getState().clear();
});

describe('DiffView render states', () => {
  test('changed content renders add/del rows, counts, and skip separators', () => {
    const mid = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const html = renderToString(
      <DiffView before={`old\n${mid}`} after={`new\n${mid}`} path="/workspace/src/App.tsx" />,
    );
    expect(html).toContain('data-teach="diff-view"');
    expect(html).toContain('+1');
    expect(html).toContain('−1');
    expect(html).toContain('old');
    expect(html).toContain('new');
    expect(html).toContain('unchanged lines');
    expect(html).toContain('/workspace/src/App.tsx');
  });

  test('identical content renders the quiet no-changes note', () => {
    const html = renderToString(<DiffView before="same" after="same" />);
    expect(html).toContain('No changes');
    expect(html).not.toContain('data-teach="diff-view"');
  });

  test('oversize content falls back to full source with a note', () => {
    // Fully-different 2000-line files → 2000×2000 = 4M cells, past
    // the production 2M budget → tooLarge fallback.
    const big = Array.from({ length: 2000 }, (_, i) => `x-${i}`).join('\n');
    const big2 = Array.from({ length: 2000 }, (_, i) => `y-${i}`).join('\n');
    const html = renderToString(<DiffView before={big} after={big2} path="/workspace/big.ts" />);
    expect(html).toContain('too large to diff');
    expect(html).not.toContain('data-teach="diff-view"');
  });
});

describe('StrategyStepper render states', () => {
  test('plain ReAct turn (no milestones) renders nothing', () => {
    const html = renderToString(<StrategyStepper phaseEvents={[]} critiques={[]} />);
    expect(html).toBe('');
  });

  test('draft-validate turn renders ordered chips', () => {
    const html = renderToString(
      <StrategyStepper
        phaseEvents={[
          { name: 'draft_started', data: { attempt: 0 } },
          { name: 'validation_result', data: { passed: 2, total: 4 } },
          { name: 'repair_started', data: { failures: 2 } },
          { name: 'validation_result', data: { passed: 4, total: 4 } },
        ]}
      />,
    );
    expect(html).toContain('data-teach="strategy-stepper"');
    expect(html.indexOf('draft')).toBeLessThan(html.indexOf('validate 2/4'));
    expect(html.indexOf('validate 2/4')).toBeLessThan(html.indexOf('repair · 2 failing'));
    expect(html).toContain('validate 4/4');
  });

  test('warn critique renders its feedback as a detail line', () => {
    const html = renderToString(
      <StrategyStepper critiques={[{ verdict: 'retry', feedback: 'cover the anon case' }]} />,
    );
    expect(html).toContain('critique → retry');
    expect(html).toContain('cover the anon case');
  });
});

describe('TurnAttribution render states', () => {
  test('no tool calls → renders nothing', () => {
    const html = renderToString(<TurnAttribution message={msg({})} currentCallId="x" />);
    expect(html).toBe('');
  });

  test('rows + share bar + provider-reported footer', () => {
    const m = msg({
      toolCalls: [
        { id: 'a', name: 'write_file', argsJson: 'x'.repeat(4000), resultJson: 'y'.repeat(400) },
        { id: 'b', name: 'read_file', argsJson: 'x'.repeat(100), resultJson: 'y'.repeat(300) },
      ],
      metrics: { tokensIn: 9000, tokensOut: 1000, tokensTotal: 10000, costUsd: 0.01, costEstimated: true },
    });
    const html = renderToString(<TurnAttribution message={m} currentCallId="a" />);
    expect(html).toContain('data-teach="turn-attribution"');
    expect(html).toContain('write_file');
    expect(html).toContain('read_file');
    expect(html).toContain('▸'); // current-call marker
    expect(html).toContain('in 9k');
    expect(html).toContain('≈$0.01');
    expect(html).toContain('payload-size estimates');
  });
});

describe('DenialWalkthrough render states', () => {
  const fullResult = {
    denial: {
      at: 1718000000000,
      op: 'create pyric_sessions/test',
      path: 'pyric_sessions/test',
      method: 'create',
      auth: '{"uid":"alice"}',
      message: 'Missing or insufficient permissions',
      classification: 'unexpected',
      classificationReason: 'no error handling found',
    },
  };

  function denialCall(resultJson?: string): ToolCall {
    return {
      id: 'c1',
      name: 'inspect_denial',
      argsJson: '{}',
      ...(resultJson !== undefined ? { resultJson, ok: true } : {}),
    };
  }

  test('in-flight call renders the awaiting note', () => {
    const html = renderToString(
      <DenialWalkthrough call={denialCall()} messageId="m" />,
    );
    expect(html).toContain('Awaiting result');
  });

  test('failure payload (no_denials) explains itself', () => {
    const html = renderToString(
      <DenialWalkthrough
        call={denialCall(JSON.stringify({ reason: 'no_denials' }))}
        messageId="m"
      />,
    );
    expect(html).toContain('No denials in the runtime store');
  });

  test('full result renders both panels + send-to-agent', () => {
    const html = renderToString(
      <DenialWalkthrough call={denialCall(JSON.stringify(fullResult))} messageId="m" />,
    );
    expect(html).toContain('data-teach="denial-walkthrough"');
    // Panel 1 — facts.
    expect(html).toContain('Why this request failed');
    expect(html).toContain('create pyric_sessions/test');
    expect(html).toContain('unexpected');
    // Panel 2 — opt-in LLM + deterministic hand-off.
    expect(html).toContain('Explain the fix');
    expect(html).toContain('Send to agent');
  });
});
