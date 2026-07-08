import { describe, expect, test } from 'bun:test';
import { renderToString as reactRenderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { AgentPanel } from './AgentPanel';
import { ComposeBar } from './ComposeBar';
import { ContextTab, excerpt } from './ContextTab';
import type {
  ContextWindowSessionRequest,
  ContextWindowSnapshot,
} from '~/lib/agent/context-window';

function renderToString(el: ReactElement): string {
  return reactRenderToString(el).replaceAll('<!-- -->', '');
}

const requestToolSchemas = [
  'read_file',
  'write_file',
  'edit_file',
  'search_file',
  'list_files',
  'bash',
  'run_workspace_tests',
  'debug_firestore_rules',
  'firestore_lint_rules',
  'firestore_resolve_modules',
];

function makeRequest(
  overrides: Partial<ContextWindowSessionRequest> = {},
): ContextWindowSessionRequest {
  return {
    id: 'turn-1#0',
    requestId: 'turn-1#0',
    turnId: 'turn-1',
    iteration: 0,
    providerId: 'gemini',
    providerLabel: 'Gemini',
    modelLabel: 'Flash',
    inputTokens: 2_100_000,
    outputTokens: 904_949,
    cachedInputTokens: 400_000,
    reasoningTokens: 300_000,
    freshInputTokens: 1_700_000,
    visibleOutputTokens: 604_949,
    tokensTotal: 3_004_949,
    usageSource: 'provider' as const,
    composition: {
      system: 200_000,
      history: 1_000_000,
      resentToolResults: 500_000,
      currentPrompt: 150_000,
      toolSchemas: 250_000,
    },
    messageCount: 14,
    toolResultMessageCount: 4,
    toolNames: ['read_file', 'write_file'],
    toolSchemaNames: requestToolSchemas,
    emittedToolCalls: [
      { name: 'write_file', callId: 'call-write', messageId: 'assistant-1', tokensEstimated: 24 },
    ],
    resentToolResults: [
      { name: 'read_file', callId: 'call-read', messageId: 'assistant-1', tokensEstimated: 96 },
      { name: 'read_file', callId: 'call-read-2', messageId: 'assistant-1', tokensEstimated: 96 },
      { name: 'bash', callId: 'call-bash', messageId: 'assistant-1', tokensEstimated: 30 },
    ],
    ...overrides,
  };
}

const snapshot: ContextWindowSnapshot = {
  basis: 'estimated-next-send',
  usedTokens: 210_000,
  limitTokens: 258_000,
  percentFull: 210_000 / 258_000,
  status: 'high',
  toolCount: 12,
  compaction: {
    compacted: true,
    originalChars: 1_200_000,
    compactedChars: 840_000,
    bytesSaved: 360_000,
    turnsCompacted: 0,
    messagesCompacted: 9,
  },
  compactionPreview: {
    rawTokens: 289_412,
    currentTokens: 210_000,
    compactedTokens: 210_000,
    automaticSavedTokens: 79_412,
    manualSavedTokens: 0,
    savedTokens: 79_412,
    stats: {
      compacted: true,
      originalChars: 1_200_000,
      compactedChars: 840_000,
      bytesSaved: 360_000,
      turnsCompacted: 0,
      messagesCompacted: 9,
    },
    retains: [],
    loses: [],
  },
  sessionUsage: {
    turns: 2,
    requests: 16,
    tokensTotal: 14_586_103,
    inputTokens: 14_100_000,
    outputTokens: 486_103,
    cachedInputTokens: 11_900_000,
    reasoningTokens: 61_000,
    costUsdTotal: 4.14,
    workMultiplier: 14_586_103 / 210_000,
    averageRequestTokens: 14_586_103 / 16,
    turnRows: [
      {
        id: 'assistant-1',
        label: 'Turn 1',
        requestCount: 6,
        inputTokens: 4_100_000,
        outputTokens: 104_949,
        cachedInputTokens: 3_600_000,
        reasoningTokens: 30_000,
        freshInputTokens: 500_000,
        visibleOutputTokens: 74_949,
        tokensTotal: 4_204_949,
      },
      {
        id: 'assistant-2',
        label: 'Turn 2',
        requestCount: 10,
        inputTokens: 10_000_000,
        outputTokens: 381_154,
        cachedInputTokens: 8_300_000,
        reasoningTokens: 31_000,
        freshInputTokens: 1_700_000,
        visibleOutputTokens: 350_154,
        tokensTotal: 10_381_154,
      },
    ],
    requestRows: [
      makeRequest(),
      makeRequest({ id: 'turn-2#0', requestId: 'turn-2#0', turnId: 'turn-2', iteration: 0 }),
      makeRequest({
        id: 'turn-2#1',
        requestId: 'turn-2#1',
        turnId: 'turn-2',
        iteration: 1,
        modelLabel: 'Pro',
        toolSchemaNames: [...requestToolSchemas, 'build_game_rules'],
      }),
    ],
    categoryDetails: {},
    teachingNotes: {
      providerUsage: '',
      estimatedComposition: '',
      contextVsSpend: '',
    },
  },
  pricing: {
    current: {
      costUsd: 0.315,
      estimated: true,
      source: 'gemini-pricing-table',
      inputPricePerMillion: 1.5,
      cacheReadPricePerMillion: 0.15,
    },
    compacted: null,
    savedCostUsd: null,
  },
  breakdown: [
    { id: 'system', label: 'System prompt', tokens: 20_000, color: '#a4d4a8', estimated: true },
    { id: 'history', label: 'Conversation', tokens: 120_000, color: '#8bb7ff', estimated: true },
    { id: 'tool-results', label: 'Tool results', tokens: 50_000, color: '#f0c36a', estimated: true },
    { id: 'tool-schemas', label: 'Tool schemas', tokens: 20_000, color: '#c9a7ff', estimated: true },
  ],
};

describe('context window UI render states', () => {
  test('ComposeBar renders the context meter beside Send', () => {
    const html = renderToString(
      <ComposeBar
        onSubmit={() => {}}
        contextWindow={snapshot}
        onOpenContext={() => {}}
      />,
    );

    expect(html).toContain('data-context-window-meter');
    expect(html).toContain('Context window:');
    expect(html).toContain('81% full');
    expect(html).toContain('210k / 258k tokens used');
    expect(html).toContain('Send');
  });

  test('ComposeBar keeps the meter visible in Stop state', () => {
    const html = renderToString(
      <ComposeBar
        onSubmit={() => {}}
        sending
        onStop={() => {}}
        contextWindow={snapshot}
      />,
    );

    expect(html).toContain('data-context-window-meter');
    expect(html).toContain('Stop');
  });

  test('ContextTab layer 1 renders the transcript → sent receipt with formatting', () => {
    const html = renderToString(
      <ContextTab snapshot={snapshot} onCompactNow={() => {}} onOpenTool={() => {}} />,
    );

    expect(html).toContain('data-context-next-request');
    expect(html).toContain('Next request');
    expect(html).toContain('Transcript');
    expect(html).toContain('Sent to model');
    // 289,412 → whole-k tier; 210,000 → whole-k tier; savings pill.
    expect(html).toContain('289k');
    expect(html).toContain('210k');
    expect(html).toContain('−79.4k');
    // Exact counts ride tooltips.
    expect(html).toContain('289,412 tokens');
    expect(html).toContain('exact: 210,000');
    // Compact now survives, demoted from hero to a small action.
    expect(html).toContain('data-context-compact-now="true"');
    expect(html).toContain('Compact now');
    // Composition legend from breakdown rows.
    expect(html).toContain('data-context-breakdown-row="system"');
    expect(html).toContain('data-context-breakdown-row="tool-schemas"');
    // Cost estimate marked as an estimate.
    expect(html).toContain('≈');
    expect(html).toContain('$0.315');
    // The always-zero forced-savings triptych is gone.
    expect(html).not.toContain('after forced');
    expect(html).not.toContain('manual compaction');
  });

  test('ContextTab layer 2 renders the session ledger with cached/fresh split and turn bars', () => {
    const html = renderToString(
      <ContextTab snapshot={snapshot} onCompactNow={() => {}} onOpenTool={() => {}} />,
    );

    expect(html).toContain('data-context-ledger');
    expect(html).toContain('Session ledger');
    expect(html).toContain('$4.14');
    expect(html).toContain('provider-reported');
    // Millions tier, never "14586k".
    expect(html).toContain('14.59M');
    expect(html).not.toContain('14586k');
    expect(html).toContain('11.90M cached');
    expect(html).toContain('2.20M fresh');
    expect(html).toContain('reasoning');
    expect(html).toContain('data-context-turn-bars');
    expect(html).toContain('turn 1');
    expect(html).toContain('turn 2');
    // Exact value tooltips on turn totals.
    expect(html).toContain('10,381,154');
  });

  test('ContextTab layer 3 groups requests by turn and renders no request rows until expanded', () => {
    const html = renderToString(
      <ContextTab snapshot={snapshot} onCompactNow={() => {}} onOpenTool={() => {}} />,
    );

    expect(html).toContain('data-context-requests');
    expect(html).toContain('data-turn-group="turn-1"');
    expect(html).toContain('data-turn-group="turn-2"');
    expect(html).toContain('2 req');
    // Collapsed by default: request rows and drills are NOT in the DOM.
    expect(html).not.toContain('data-request-row');
    expect(html).not.toContain('data-request-drill');
    // The schema chip wall is dead: one standard-toolset chip + exceptions.
    expect(html).toContain('standard toolset ×10 · all requests');
    expect(html).toContain('1 skill tool');
    expect(html).not.toContain('data-request-filter="tool-schema:read_file"');
    // Provider/model chips with counts survive as the only filters.
    expect(html).toContain('data-request-filter-chip="Gemini"');
    expect(html).toContain('data-request-filter-chip="Flash"');
    expect(html).toContain('data-request-filter-chip="Pro"');
  });

  // Turn descriptions come from the chat store at runtime; renderToString
  // serves zustand's initial state, so the join is covered via the helper.
  test('excerpt collapses whitespace and truncates long prompts with an ellipsis', () => {
    expect(excerpt(undefined)).toBeNull();
    expect(excerpt('   ')).toBeNull();
    expect(excerpt('short  prompt\nwith newline')).toBe('short prompt with newline');
    const long = 'Add capture rules and tests for the jump chain in checkers please today';
    expect(excerpt(long)).toBe(`${long.slice(0, 64)}…`);
  });

  test('ContextTab renders an honest empty state without traces', () => {
    const html = renderToString(
      <ContextTab
        snapshot={{
          ...snapshot,
          sessionUsage: {
            ...snapshot.sessionUsage!,
            requests: null,
            requestRows: [],
          },
        }}
        onCompactNow={() => {}}
        onOpenTool={() => {}}
      />,
    );

    expect(html).toContain('No per-request detail yet');
    expect(html).toContain('not saved or restored');
    // Ledger still shows high-level totals with request count unknown.
    expect(html).toContain('unknown');
  });

  test('ContextTab shows pricing-unavailable state without a spend figure', () => {
    const html = renderToString(
      <ContextTab
        snapshot={{
          ...snapshot,
          pricing: { current: null, compacted: null, savedCostUsd: null },
          sessionUsage: { ...snapshot.sessionUsage!, costUsdTotal: undefined },
        }}
        onCompactNow={() => {}}
        onOpenTool={() => {}}
      />,
    );

    expect(html).toContain('pricing unavailable');
    expect(html).not.toContain('$4.14');
  });

  test('AgentPanel renders merged Chat and Context sub-tabs only', () => {
    const html = renderToString(
      <AgentPanel
        activeSubTab="context"
        onSubTabChange={() => {}}
        contextWindow={snapshot}
        onCompactContext={() => {}}
      />,
    );

    expect(html).toContain('Chat');
    expect(html).toContain('Context');
    expect(html).not.toContain('>Requests</button>');
    expect(html).toContain('data-context-tab');
  });
});
