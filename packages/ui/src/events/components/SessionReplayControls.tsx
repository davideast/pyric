import type { ReactNode } from 'react';

export interface SessionReplayControlsProps {
  /** Callback triggered when clicking Replay. */
  onReplay: () => void;
  /** Whether replay is currently running. */
  isReplaying?: boolean;
  /** Whether request.time is pinned during replay. */
  pinRequestTime: boolean;
  /** Callback to change pinRequestTime. */
  onPinRequestTimeChange: (pin: boolean) => void;
  /** Number of events to replay. */
  eventCount?: number;
  /** Optional class name. */
  className?: string;
  /** Optional custom action content. */
  children?: ReactNode;
}

/**
 * Headless controls for session replay: triggers replay and toggles
 * `pinRequestTime` so `serverTimestamp` and time-based rules evaluate identically.
 */
export function SessionReplayControls({
  onReplay,
  isReplaying = false,
  pinRequestTime,
  onPinRequestTimeChange,
  eventCount,
  className,
  children,
}: SessionReplayControlsProps) {
  return (
    <div className={className} data-pyric-ui="session-replay-controls">
      <button
        type="button"
        onClick={onReplay}
        disabled={isReplaying}
        data-pyric-replay-run=""
      >
        {isReplaying ? 'Replaying...' : 'Replay Session'}
      </button>

      <label data-pyric-replay-pin-request-time="">
        <input
          type="checkbox"
          checked={pinRequestTime}
          onChange={(e) => onPinRequestTimeChange(e.target.checked)}
          disabled={isReplaying}
        />
        <span>Pin request.time</span>
      </label>

      {eventCount !== undefined && (
        <span data-pyric-replay-event-count="">
          {eventCount} {eventCount === 1 ? 'event' : 'events'}
        </span>
      )}

      {isReplaying && (
        <span data-pyric-replay-status="">replaying</span>
      )}

      {children}
    </div>
  );
}
