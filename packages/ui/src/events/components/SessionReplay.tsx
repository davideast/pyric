import type { ReactNode } from 'react';
import type { SandboxEvent } from 'pyric/sandbox';
import type { AnyActivityEvent } from '../types.js';
import { useSessionReplay } from '../hooks/useSessionReplay.js';
import { useDivergenceInspector } from '../hooks/useDivergenceInspector.js';
import { SessionReplayControls } from './SessionReplayControls.js';
import { DivergenceSummary } from './DivergenceSummary.js';
import { ReplayDivergenceList } from './ReplayDivergenceList.js';
import { DivergenceInspector } from './DivergenceInspector.js';

export interface SessionReplayProps {
  /** Captured events to replay. */
  events: readonly SandboxEvent[] | readonly AnyActivityEvent[];
  /** Rules text to evaluate against. */
  rules: string;
  /** Whether to pin request.time. Default true. */
  pinRequestTime?: boolean;
  /** Optional initial snapshot of document state to diff against. */
  originalState?: Record<string, Record<string, unknown>>;
  /** Automatically run replay on mount/update. Default false. */
  autoReplay?: boolean;
  /** Optional wrapper className. */
  className?: string;
  /** Rendered when no divergences are found after replay. */
  emptyState?: ReactNode;
}

/**
 * Headless composite component providing an end-to-end session replay and
 * state drift inspection interface. Wires `useSessionReplay` with
 * `SessionReplayControls`, `DivergenceSummary`, `ReplayDivergenceList`, and
 * `DivergenceInspector`.
 */
export function SessionReplay({
  events,
  rules,
  pinRequestTime = true,
  originalState,
  autoReplay = false,
  className,
  emptyState = null,
}: SessionReplayProps) {
  const replayState = useSessionReplay({
    events,
    rules,
    pinRequestTime,
    originalState,
    autoReplay,
  });

  const inspectorState = useDivergenceInspector({
    divergences: replayState.divergences,
  });

  return (
    <div className={className} data-pyric-ui="session-replay">
      <SessionReplayControls
        onReplay={() => replayState.replay()}
        isReplaying={replayState.isReplaying}
        pinRequestTime={replayState.pinRequestTime}
        onPinRequestTimeChange={replayState.setPinRequestTime}
        eventCount={events.length}
      />

      {replayState.error && (
        <div data-pyric-replay-error="">
          {replayState.error.message}
        </div>
      )}

      {replayState.result && (
        <>
          <DivergenceSummary
            summary={inspectorState.summary}
            filter={inspectorState.filter}
            onFilterChange={inspectorState.setFilter}
          />

          <div data-pyric-replay-body="">
            <ReplayDivergenceList
              divergences={inspectorState.filteredDivergences}
              selected={inspectorState.selectedDivergence}
              onSelect={inspectorState.selectDivergence}
              emptyState={emptyState}
            />

            <DivergenceInspector
              divergence={inspectorState.selectedDivergence}
              onClose={() => inspectorState.selectDivergence(null)}
            />
          </div>
        </>
      )}
    </div>
  );
}
