import type { MetricSeries } from '@pyric/ui/traffic';

const numberFormatter = new Intl.NumberFormat();

const billableLabels: Record<string, string> = {
  reads: 'read operations',
  writes: 'writes',
  deletes: 'deletes',
};

const rtdbTransferLabels: Record<string, string> = {
  deliveries: 'deliveries',
  writes: 'writes',
  removes: 'removes',
};

const rulesLabels: Record<string, string> = {
  allows: 'allowed requests',
  denies: 'denied requests',
};

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function sentenceCase(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

export interface MetricStory {
  total: number;
  headline: string;
  finding: string;
}

interface StoryOptions {
  labels: Record<string, string>;
  singular: string;
  plural: string;
  subject: string;
  evenSplitPrefix: string;
  emptyHeadline: string;
  emptyFinding: string;
}

/** Turn metric totals into a factual summary without inventing a comparison. */
function metricStory(series: readonly MetricSeries[], options: StoryOptions): MetricStory {
  const total = series.reduce((sum, item) => sum + item.total, 0);
  if (total === 0) {
    return {
      total,
      headline: options.emptyHeadline,
      finding: options.emptyFinding,
    };
  }

  const largest = Math.max(...series.map((item) => item.total));
  const leaders = series.filter((item) => item.total === largest);
  const headline = `${numberFormatter.format(total)} observed ${
    total === 1 ? options.singular : options.plural
  }`;
  const labelFor = (item: MetricSeries) => options.labels[item.key] ?? item.label.toLowerCase();

  if (leaders.length > 1) {
    const names = leaders.map(labelFor);
    return {
      total,
      headline,
      finding:
        leaders.length === series.length
          ? `${options.evenSplitPrefix} ${joinLabels(names)}.`
          : `${sentenceCase(joinLabels(names))} tied for the largest share of ${options.subject} in this window.`,
    };
  }

  const leader = leaders[0]!;
  const share = Math.round((leader.total / total) * 100);
  return {
    total,
    headline,
    finding: `${sentenceCase(labelFor(leader))} accounted for ${share}% of ${options.subject} in this window.`,
  };
}

export function billableStory(series: readonly MetricSeries[]): MetricStory {
  return metricStory(series, {
    labels: billableLabels,
    singular: 'billable operation',
    plural: 'billable operations',
    subject: 'activity',
    evenSplitPrefix: 'Activity was split evenly across',
    emptyHeadline: 'No billable activity observed',
    emptyFinding: 'Successful reads, writes, and deletes will appear here as they happen.',
  });
}

export function rtdbTransferStory(series: readonly MetricSeries[]): MetricStory {
  return metricStory(series, {
    labels: rtdbTransferLabels,
    singular: 'Realtime Database transfer',
    plural: 'Realtime Database transfers',
    subject: 'transfer activity',
    evenSplitPrefix: 'Transfer activity was split evenly across',
    emptyHeadline: 'No Realtime Database transfers observed',
    emptyFinding:
      'Successful listener deliveries, one-shot reads, writes, and removes will appear here as they happen.',
  });
}

export function rulesStory(series: readonly MetricSeries[]): MetricStory {
  return metricStory(series, {
    labels: rulesLabels,
    singular: 'Rules evaluation',
    plural: 'Rules evaluations',
    subject: 'evaluations',
    evenSplitPrefix: 'Evaluations were split evenly between',
    emptyHeadline: 'No Rules evaluations observed',
    emptyFinding: 'Allow and deny decisions will appear here as Rules evaluate requests.',
  });
}

export function liveRulesStory(
  series: readonly MetricSeries[],
  counts: { driftCount: number; unevaluatedCount: number },
): MetricStory {
  const allows = series.find((item) => item.key === 'allows')?.total ?? 0;
  const denies = series.find((item) => item.key === 'denies')?.total ?? 0;
  const total = allows + denies;
  const { driftCount, unevaluatedCount } = counts;

  if (total === 0) {
    if (unevaluatedCount > 0) {
      const unevaluatedNoun = unevaluatedCount === 1 ? 'request' : 'requests';
      return {
        total,
        headline: 'No decided local Rules evaluations',
        finding: `${numberFormatter.format(unevaluatedCount)} observed ${unevaluatedNoun} could not be evaluated locally in this window.`,
      };
    }
    return {
      total,
      headline: 'No local Rules evaluations observed',
      finding:
        'What your local rules would allow or would deny will appear here as live requests arrive.',
    };
  }

  const evaluationNoun = total === 1 ? 'evaluation' : 'evaluations';
  const requestNoun = total === 1 ? 'request' : 'requests';
  const headline = `${numberFormatter.format(total)} advisory local Rules ${evaluationNoun}`;
  let driftSuffix = '';
  if (driftCount > 0) {
    driftSuffix = ` · ${numberFormatter.format(driftCount)} disagreed with production`;
  }

  if (allows === denies) {
    return {
      total,
      headline,
      finding: `Evaluations were split evenly between local would-allow and would-deny verdicts${driftSuffix}.`,
    };
  }

  if (allows > denies) {
    if (denies === 0) {
      return {
        total,
        headline,
        finding: `Local rules would allow all ${numberFormatter.format(total)} evaluated ${requestNoun} in this window${driftSuffix}.`,
      };
    }
    const share = Math.round((allows / total) * 100);
    return {
      total,
      headline,
      finding: `Local rules would allow ${share}% of evaluated requests in this window${driftSuffix}.`,
    };
  }

  const share = Math.round((denies / total) * 100);
  return {
    total,
    headline,
    finding: `Local rules would deny ${share}% of evaluated requests in this window${driftSuffix}.`,
  };
}
