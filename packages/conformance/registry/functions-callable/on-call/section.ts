import { defineRowSection, type AuthoredRowRecord } from '../../section-rows.ts';

type EvidenceKind = 'observed' | 'upstream' | 'pyric';

interface CallableRowSeed {
  order?: number;
  kind: EvidenceKind;
  api: string;
  behavior: string;
  evidence: string;
  rowRef?: never;
  id?: never;
}

const RISK_BY_KIND: Record<EvidenceKind, { risk: string; riskScore: number; reason: string }> = {
  observed: {
    risk: 'unobserved',
    riskScore: 2,
    reason: 'Production behavior is not captured yet; the functions-callable capture owns the observation.',
  },
  upstream: {
    risk: 'unobserved',
    riskScore: 1,
    reason:
      'Behavior stated from the firebase-functions 7.2.5, firebase-admin 13.10.0, and @firebase/functions 0.14.0 source; no production capture backs it.',
  },
  pyric: {
    risk: 'pyric-owned',
    riskScore: 1,
    reason: 'Pyric-owned development behavior with no production counterpart; a unit or integration assertion backs it at flip.',
  },
};

export const CLIENT = '@firebase/functions 0.14.0 `dist/esm/index.esm.js`';

export const section = defineRowSection({
  surface: 'functions-callable',
  order: 10,
  prefix: '## `onCall` protocol, tokens, and `firebase/functions` client contract\n',
  defaults: {
    section: '`firebase-functions/v2/https.onCall`',
    featureKeys: ['onCall'],
    oracleObservations: [],
    status: 'unverified',
    automation: 'unverified',
  },
});

export function row(seed: CallableRowSeed): AuthoredRowRecord {
  const raw = seed as unknown as Record<string, unknown>;
  if ('rowRef' in raw && raw.rowRef !== undefined) {
    throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
  }
  if ('id' in raw && raw.id !== undefined) {
    throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
  }
  const { kind, ...rest } = seed;
  const risk = RISK_BY_KIND[kind];
  return section.row({
    ...rest,
    risk: [risk.risk],
    riskScore: risk.riskScore,
    riskReasons: [risk.reason],
  });
}
