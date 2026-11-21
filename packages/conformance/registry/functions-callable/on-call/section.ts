import { defineRowSection, type AuthoredRowRecord } from '../../section-rows.ts';

type EvidenceKind = 'observed' | 'upstream' | 'pyric';

/** Set only when the row's assertion set passes unweakened. */
export type CallableFlip =
  | { status: 'conforms'; tests: string[] }
  | { status: 'unsupported'; reason: string; tests: string[] };

interface CallableRowSeed {
  order?: number;
  kind: EvidenceKind;
  api: string;
  behavior: string;
  evidence: string;
  observations?: string[];
  flip?: CallableFlip;
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

const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited, but pyric has not replayed the functions-callable observation yet.';

export const CLIENT = '@firebase/functions 0.14.0 `dist/esm/index.esm.js`';
export const SUITE = 'packages/cli/test/functions-callable/oracle-conformance.test.ts';
export const VITE_PLANE = 'packages/cli/test/functions-callable/vite-plane.test.ts';
export const WIRE_SERVING = 'packages/cli/test/functions-callable/wire-serving.test.ts';
export const CLIENT_UNIT = 'packages/pyric/test/functions/client.test.ts';

export const section = defineRowSection({
  surface: 'functions-callable',
  order: 10,
  prefix: '## `onCall` protocol, tokens, and `firebase/functions` client contract\n',
  defaults: {
    section: '`firebase-functions/v2/https.onCall`',
    featureKeys: ['onCall'],
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
  const observations = seed.observations ?? [];
  const flip = seed.flip;

  return section.rowFromRef(seed.order, (rowRef) => {
    if (flip !== undefined) {
      const evidence = `${seed.evidence} Local assertion: \`${SUITE}\` assertion set \`functions-callable#${rowRef}\`.`;
      const shared = {
        api: seed.api,
        behavior: seed.behavior,
        evidence,
        oracleObservations: observations,
        conformanceTests: flip.tests,
      };
      if (flip.status === 'unsupported') {
        return {
          ...shared,
          status: 'unsupported',
          automation: 'unsupported',
          exceptionReason: flip.reason,
        };
      }
      return {
        ...shared,
        status: 'conforms',
        automation: 'unit-backed',
        hostConformanceTests: flip.tests,
      };
    }

    if (observations.length > 0) {
      return {
        api: seed.api,
        behavior: seed.behavior,
        evidence: seed.evidence,
        oracleObservations: observations,
        status: 'unverified',
        automation: 'unverified',
        risk: ['cited-not-replayed'],
        riskScore: 1,
        riskReasons: [CITED_NOT_REPLAYED_REASON],
      };
    }

    const risk = RISK_BY_KIND[seed.kind];
    return {
      api: seed.api,
      behavior: seed.behavior,
      evidence: seed.evidence,
      oracleObservations: observations,
      status: 'unverified',
      automation: 'unverified',
      risk: [risk.risk],
      riskScore: risk.riskScore,
      riskReasons: [risk.reason],
    };
  });
}
