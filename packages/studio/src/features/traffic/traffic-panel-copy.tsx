/**
 * Mode-keyed copy and label definitions for Traffic's Billable and Rules
 * journal panels (`sandbox` vs `live`).
 */
import type { ReactNode } from 'react';
import type { MetricSeries } from '@pyric/ui/traffic';

export type TrafficHostMode = 'sandbox' | 'live';

export interface JournalPanelCopy {
  readonly eyebrow: string;
  readonly emptyLabel: string;
  readonly evidenceTitle: string;
  readonly source: string;
  readonly methodology: ReactNode;
}

export const BILLABLE_OPERATION_COPY: Record<TrafficHostMode, JournalPanelCopy> = {
  sandbox: {
    eyebrow: 'Billable activity',
    emptyLabel: 'No reads, writes, or deletes in this session yet.',
    evidenceTitle: 'When the activity happened',
    source: 'Source: Pyric Firestore sandbox events · Operation counts, not a Firebase invoice',
    methodology: (
      <>
        <p>
          Counts successful Firestore sandbox <code>get</code>/<code>list</code>,{' '}
          <code>create</code>/<code>update</code>/<code>set</code>, and <code>delete</code>/
          <code>remove</code> operations in the displayed window. Rules-bypassed admin operations
          are included because they still execute.
        </p>
        <p>
          <strong>Read ops are a proxy, not billed document reads.</strong> Each <code>list</code>{' '}
          is counted once because the event does not report how many documents the query returned.
          This is observed sandbox activity, not a Firebase invoice.
        </p>
      </>
    ),
  },
  live: {
    eyebrow: 'Operation-metered',
    emptyLabel: 'No Firestore or Storage operations in this window.',
    evidenceTitle: 'When the operations happened',
    source:
      'Source: observed live requests · Firestore documents and Storage operations, not a Firebase invoice',
    methodology: (
      <>
        <p>
          Counts successful observed Firestore and Cloud Storage requests in the displayed window:
          measured Firestore document reads (including snapshot listener deliveries), document
          writes and deletes, plus Storage Class B read and Class A write/list or delete
          operations. Cache-only Firestore reads and denied or failed production calls are
          excluded.
        </p>
        <p>
          <strong>Operation-metered activity only, not a Firebase invoice.</strong> Realtime
          Database bills by downloaded bytes and stored data rather than per-read operations, so
          its transfer activity is reported separately below.
        </p>
      </>
    ),
  },
};

export const LIVE_RTDB_TRANSFER_COPY: JournalPanelCopy = {
  eyebrow: 'Bandwidth-metered',
  emptyLabel: 'No Realtime Database transfers in this window.',
  evidenceTitle: 'When the transfers happened',
  source:
    'Source: observed live Realtime Database requests · Callback deliveries and mutations, not byte totals',
  methodology: (
    <>
      <p>
        Counts successful observed Realtime Database <code>onValue</code>/<code>onChild*</code>{' '}
        deliveries, one-shot <code>get</code>/<code>once</code> reads, writes (<code>set</code>,{' '}
        <code>update</code>, <code>push</code>, <code>runTransaction</code>), and{' '}
        <code>remove</code> calls in the displayed window. Denied or failed calls are excluded.
      </p>
      <p>
        <strong>Transfer events, not billed gigabytes.</strong> Firebase Realtime Database bills by
        downloaded bandwidth and stored bytes rather than per-operation document SKUs, so these
        counts are kept separate from Firestore and Storage operation totals.
      </p>
    </>
  ),
};

export const RULES_PANEL_COPY: Record<TrafficHostMode, JournalPanelCopy> = {
  sandbox: {
    eyebrow: 'Rules decisions',
    emptyLabel: 'No allow or deny decisions in this session yet.',
    evidenceTitle: 'When Rules evaluated requests',
    source: 'Source: Pyric sandbox events · Evaluated Rules dispositions only',
    methodology: (
      <>
        <p>
          Counts only operations whose canonical Rules disposition is <code>evaluated</code>,
          grouped by its <code>allow</code> or <code>deny</code> verdict. Query-proof limitations
          are counted separately, not as ordinary denials.
        </p>
        <p>
          <strong>Bypasses and runtime failures are not Rules decisions.</strong> Admin bypasses,
          services without Rules, unsupported operations, and runtime errors are excluded because
          Rules did not produce a verdict.
        </p>
      </>
    ),
  },
  live: {
    eyebrow: 'Advisory local rules',
    emptyLabel: 'No decided local Rules evaluations in this window.',
    evidenceTitle: 'When local rules evaluated requests',
    source:
      'Source: observed live requests · Local rules evaluated against observed traffic (advisory)',
    methodology: (
      <>
        <p>
          Evaluates your local Firestore, Realtime Database, and Storage rules against observed
          live client requests — what local rules <strong>would allow</strong> or{' '}
          <strong>would deny</strong>, not what production enforced. Recurring deliveries on an
          attached Realtime Database listener count once per distinct verdict on that subscription;
          Firestore snapshot listeners and client transactions are not locally simulated because
          observed frames lack full query-proof and uncaptured stored-document state.
        </p>
        <p>
          <strong>Drift and unevaluated calls stay distinct.</strong> Drift counts requests where
          local rules and production disagreed; unevaluated counts requests whose local rule needed
          uncaptured state or payloads; Admin SDK calls bypass client rules and are excluded.
        </p>
      </>
    ),
  },
};

const LIVE_RULES_SERIES_LABELS: Readonly<Record<string, string>> = {
  allows: 'Would allow',
  denies: 'Would deny',
};

export function rulesDecisionSeriesForMode(
  series: readonly MetricSeries[],
  mode: TrafficHostMode,
): MetricSeries[] {
  const projected: MetricSeries[] = [];
  for (const entry of series) {
    if (entry.key !== 'allows' && entry.key !== 'denies') continue;
    if (mode === 'sandbox') {
      projected.push(entry);
    } else {
      projected.push({
        ...entry,
        label: LIVE_RULES_SERIES_LABELS[entry.key] ?? entry.label,
      });
    }
  }
  return projected;
}
