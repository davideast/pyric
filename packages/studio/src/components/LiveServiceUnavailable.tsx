/**
 * Read-only notice rendered when Studio's Auth surface is opened against a live
 * Firebase host.
 */

export type LiveUnavailableServiceView = 'auth';

const LIVE_SERVICE_UNAVAILABLE_COPY: Record<
  LiveUnavailableServiceView,
  { title: string; copy: string }
> = {
  auth: {
    title: 'Auth user listing is unavailable in Live mode',
    copy: 'Live mode observes your app’s client SDK traffic without Admin credentials, so it cannot enumerate production Auth users and never mutates local sandbox users implicitly. Inspect observed Auth operations in Traffic.',
  },
};

export function LiveServiceUnavailable({ view }: { view: LiveUnavailableServiceView }) {
  const { title, copy } = LIVE_SERVICE_UNAVAILABLE_COPY[view];
  return (
    <div
      data-pyric-ui="live-service-unavailable"
      className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line bg-panel py-16 px-6 text-center"
    >
      <span className="rounded-full border border-line px-3 py-1 text-xs uppercase tracking-wide text-muted">
        Live mode · Read-only
      </span>
      <p className="font-medium text-sm text-ink">{title}</p>
      <p className="max-w-md text-sm leading-relaxed text-muted">{copy}</p>
    </div>
  );
}
