// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ContextWindowSnapshot } from '@inbrowser/agent/usage';
import {
  ContextWindowMeter,
  ContextWindowPanel,
  RequestUsageTimeline,
} from '../../src/agents/index.js';

afterEach(() => cleanup());

const snapshot: ContextWindowSnapshot = {
  basis: 'estimated-next-send',
  usedTokens: 50,
  limitTokens: 100,
  percentFull: 0.5,
  status: 'medium',
  breakdown: [
    { id: 'system', label: 'System prompt', tokens: 10, color: '#a4d4a8', estimated: true },
    { id: 'history', label: 'Conversation', tokens: 30, color: '#8bb7ff', estimated: true },
    { id: 'draft', label: 'Current draft', tokens: 10, color: '#f08a8a', estimated: true },
  ],
  compaction: {
    compacted: false,
    originalChars: 0,
    compactedChars: 0,
    bytesSaved: 0,
    turnsCompacted: 0,
    messagesCompacted: 0,
  },
  compactionPreview: {
    rawTokens: 50,
    currentTokens: 50,
    compactedTokens: 40,
    automaticSavedTokens: 0,
    manualSavedTokens: 10,
    savedTokens: 10,
    stats: {
      compacted: true,
      originalChars: 100,
      compactedChars: 80,
      bytesSaved: 20,
      turnsCompacted: 1,
      messagesCompacted: 2,
    },
    retains: [],
    loses: [],
  },
  pricing: { current: null, compacted: null, savedCostUsd: null },
  toolCount: 2,
  sessionUsage: {
    turns: 1,
    requests: 1,
    tokensTotal: 80,
    inputTokens: 50,
    outputTokens: 30,
    cachedInputTokens: 10,
    reasoningTokens: 5,
    turnRows: [],
    requestRows: [
      {
        id: 'r1',
        requestId: 'r1',
        turnId: 't1',
        iteration: 0,
        inputTokens: 50,
        outputTokens: 30,
        cachedInputTokens: 10,
        reasoningTokens: 5,
        freshInputTokens: 40,
        visibleOutputTokens: 25,
        tokensTotal: 80,
        usageSource: 'provider',
        composition: {
          system: 10,
          history: 20,
          resentToolResults: 0,
          currentPrompt: 5,
          toolSchemas: 15,
        },
        messageCount: 3,
        toolResultMessageCount: 0,
        toolNames: ['read_file'],
        toolSchemaNames: ['read_file'],
        emittedToolCalls: [{ name: 'read_file', callId: 'c1', messageId: 'm1' }],
        resentToolResults: [],
      },
    ],
    categoryDetails: {},
    teachingNotes: {
      providerUsage: '',
      estimatedComposition: '',
      contextVsSpend: '',
    },
  },
};

describe('context/token usage agent components', () => {
  it('renders the context meter with stable markers', () => {
    const { container } = render(<ContextWindowMeter snapshot={snapshot} />);
    expect(container.querySelector('[data-pyric-ui="context-window-meter"]')).not.toBeNull();
    expect(container.querySelector('[data-pyric-ui="context-window-ring"]')).not.toBeNull();
    expect(container.textContent).toContain('50% full');
  });

  it('renders the panel breakdown and session summary', () => {
    const { container } = render(<ContextWindowPanel snapshot={snapshot} />);
    expect(container.querySelector('[data-pyric-ui="context-window-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-segment="system"]')).not.toBeNull();
    expect(container.querySelector('[data-pyric-ui="session-spend-summary"]')).not.toBeNull();
  });

  it('renders request rows and calls onOpenTool for linked tool refs', () => {
    const opened: string[] = [];
    const { container } = render(
      <RequestUsageTimeline
        requests={snapshot.sessionUsage?.requestRows ?? []}
        onOpenTool={(messageId, callId) => opened.push(`${messageId}:${callId}`)}
      />,
    );

    expect(container.querySelector('[data-pyric-ui="request-usage-row"]')).not.toBeNull();
    fireEvent.click(container.querySelector('[data-pyric-ui="request-usage-tool"]')!);
    expect(opened).toEqual(['m1:c1']);
  });
});
