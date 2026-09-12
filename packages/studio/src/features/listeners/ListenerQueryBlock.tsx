/**
 * The query one listener watches, as the call that opened it (feature:
 * Listeners).
 *
 * Shared by the tab's inspector and the listener page, so the query reads the
 * same in both. The text is monospace source: the collection or ref the app
 * named, then one constraint per line in the order the call states them.
 * `listener-query-text.ts` owns the wording; this component owns the block and
 * its copy control.
 *
 * An operand too long to sit on a line is cut short, and the whole call —
 * every operand in full — is what the copy control puts on the clipboard and
 * what the block's `title` carries.
 */

import { useMemo, useState } from 'react';
import type { ActiveListener } from 'pyric/sandbox';
import { listenerQueryText } from './listener-query-text.js';

/** The clipboard the copy control writes to; injectable for a test. */
export type QueryClipboard = Pick<Clipboard, 'writeText'>;

function CopyQuery({ value, clipboard }: { value: string; clipboard?: QueryClipboard }) {
  const [failed, setFailed] = useState(false);
  const target = clipboard ?? globalThis.navigator?.clipboard;
  return (
    <button
      type="button"
      className="traffic__listener-query-copy"
      data-pyric-query-copy=""
      data-pyric-copy-value={value}
      data-pyric-copy-failed={failed ? '' : undefined}
      aria-label={failed ? 'Copy failed' : 'Copy the query'}
      title={failed ? 'Copy failed' : 'Copy the query'}
      disabled={target === undefined}
      onClick={() => {
        if (target === undefined) return;
        void Promise.resolve(target.writeText(value)).then(
          () => setFailed(false),
          () => setFailed(true),
        );
      }}
    >
      <svg
        className="traffic__listener-query-icon"
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <rect x="8" y="8" width="11" height="11" rx="1" />
        <path d="M16 8V5H5v11h3" />
      </svg>
    </button>
  );
}

/** The query block, or nothing when the listener watches one record. */
export function ListenerQueryBlock({
  listener,
  clipboard,
}: {
  listener: Pick<ActiveListener, 'service' | 'target' | 'query'>;
  clipboard?: QueryClipboard;
}) {
  const query = useMemo(
    () => listenerQueryText({
      service: listener.service,
      target: listener.target,
      query: listener.query,
    }),
    [listener.service, listener.target, listener.query],
  );
  if (query === undefined) return null;
  return (
    <div className="traffic__listener-query" data-pyric-query-block="">
      <pre
        className="traffic__listener-query-text"
        data-pyric-query-text=""
        title={query.full === query.text ? undefined : query.full}
      >
        {query.text}
      </pre>
      <CopyQuery value={query.full} clipboard={clipboard} />
    </div>
  );
}
