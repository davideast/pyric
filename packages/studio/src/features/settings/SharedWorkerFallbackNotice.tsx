/**
 * Diagnostic signpost shown on Studio's Settings surface when Studio is served
 * by `pyric sandbox` without a live SharedWorker plane (for example, Safari < 16.4
 * or mobile Chrome lacking `SharedWorker`, or a policy-blocked worker).
 */

export interface SharedWorkerFallbackNoticeProps {
  /** True when Studio is served (`/__pyric/init.json` answered) without a live worker plane. */
  readonly workerDown: boolean;
  /** Override for deterministic tests; defaults to `typeof SharedWorker !== 'undefined'`. */
  readonly sharedWorkerSupported?: boolean;
  /** Override for deterministic tests; defaults to `typeof BroadcastChannel !== 'undefined'`. */
  readonly broadcastChannelSupported?: boolean;
}

export function SharedWorkerFallbackNotice({
  workerDown,
  sharedWorkerSupported = typeof SharedWorker !== 'undefined',
  broadcastChannelSupported = typeof BroadcastChannel !== 'undefined',
}: SharedWorkerFallbackNoticeProps) {
  if (!workerDown) {
    return null;
  }

  if (!sharedWorkerSupported) {
    let tabBehavior =
      'Served app tabs run an isolated in-page sandbox per tab (BroadcastChannel is also unavailable)';
    if (broadcastChannelSupported) {
      tabBehavior =
        'Served app tabs run an in-page sandbox with BroadcastChannel cross-tab sync';
    }
    return (
      <p
        className="studio-live-notice"
        role="status"
        data-shared-worker-fallback="unsupported"
      >
        <span className="studio-live-notice__label">No SharedWorker</span>
        <span className="studio-live-notice__text">
          This browser lacks SharedWorker (for example, Safari &lt; 16.4 or mobile Chrome).{' '}
          {tabBehavior}, while live Studio worker controls and worker-backed Storage sharing
          are unavailable here. Restart with{' '}
          <span className="mono">pyric sandbox --hosted</span> (or{' '}
          <span className="mono">{'pyric({ hosted: true })'}</span> in Vite) to share one
          server-hosted backend across tabs and browsers.
        </span>
      </p>
    );
  }

  return (
    <p
      className="studio-live-notice"
      role="status"
      data-shared-worker-fallback="unreachable"
    >
      <span className="studio-live-notice__label">Worker unreachable</span>
      <span className="studio-live-notice__text">
        The shared sandbox worker could not be reached in this browser context, so data views
        may be stale. Reload every tab of this origin, or restart with{' '}
        <span className="mono">pyric sandbox --hosted</span> (or{' '}
        <span className="mono">{'pyric({ hosted: true })'}</span> in Vite) to connect over the
        server-hosted backend.
      </span>
    </p>
  );
}
