import { defineRowSection } from '../../section-rows.ts';

/**
 * firebase-admin App Check rows backed by the App Check and AI Logic hunt's
 * production captures (`app-check-admin-options-`, from
 * src/app-check-admin-option-probes.ts) and replayed against `pyric-admin` in
 * `packages/pyric-admin/test/app-check/hunt-captures.test.ts`.
 *
 * These rows are kept in their own table block so their witness is the shared
 * hunt-capture replay rather than `oracle-conformance.test.ts`'s one-assertion-
 * set-per-row partition over `appCheckRows`.
 */
export const REPLAY = 'packages/pyric-admin/test/app-check/hunt-captures.test.ts';
export const CREATE = 'app-check-admin-options-create-token';
export const CONSUME = 'app-check-admin-options-same-jti-consume';
const CREATE_EVIDENCE = `\`oracle:${CREATE}\` + replay: \`${REPLAY}\`.`;

const SEC_ADMIN_OPTIONS = 'firebase-admin `createToken` options, checked against production captures';

export const section = defineRowSection({
  surface: 'app-check-admin',
  order: 60,
  prefix: `## ${SEC_ADMIN_OPTIONS}\n\nEach row cites a production capture from \`app-check-admin-options\` and is replayed against \`pyric-admin/app-check\` in \`hunt-captures.test.ts\`.\n`,
  defaults: {
    section: SEC_ADMIN_OPTIONS,
    status: 'conforms',
    automation: 'oracle-backed',
    conformanceTests: [REPLAY],
    evidence: CREATE_EVIDENCE,
    oracleObservations: [CREATE],
  },
});

export const row = section.row;
