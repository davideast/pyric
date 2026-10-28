#!/usr/bin/env bun
/**
 * Capture which forms of rules file text production's rules endpoint accepts
 * beyond strict JSON: a rule string that spans lines, a trailing comma in an
 * object or an array, a raw tab inside a rule string, and comments.
 *
 * Every probe sends its text byte for byte to
 * `PUT /.settings/rules.json?dryRun=true`, the validation request
 * `firebase deploy` makes with the rules file's contents. A dry run installs
 * nothing; the capture reads the active rules before the first probe and
 * after the last one and fails unless they are byte-identical.
 *
 * Output: packages/conformance/observations/rtdb/rtdb-rules-text-dialect.json
 *
 * Credentials: the same contract as `run-rules-rtdb.ts`.
 *   PYRIC_ORACLE_FIREBASE_CONFIG  Web SDK config JSON with databaseURL.
 *   PYRIC_ORACLE_SA_PATH          service-account JSON path for the rules token.
 *
 * Usage:
 *   bun --env-file=.env run packages/conformance/src/capture-rtdb-rules-text-dialect.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RTDB_RULES_SCOPE,
  mintAccessToken,
  rtdbRulesEndpoint,
  type ServiceAccountKey,
} from './oracle-access-token.ts';
import { rejectionMessage } from './capture-rtdb-rules-type-check.ts';
import { resolvedFirebaseVersion } from './package-version.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OBSERVATION_NAME = 'rtdb-rules-text-dialect';
const OUT = join(REPO_ROOT, 'packages', 'conformance', 'observations', 'rtdb', `${OBSERVATION_NAME}.json`);

interface RtdbTextProbe {
  name: string;
  /** The rules file text, sent as the request body unchanged. */
  text: string;
}

const TEXT_PROBES: readonly RtdbTextProbe[] = [
  { name: 'strict-json', text: '{\n  "rules": {\n    "p": { ".read": "true && true" }\n  }\n}\n' },
  { name: 'rule-string-spans-lines-lf', text: '{\n  "rules": {\n    "p": { ".read": "true\n      && true" }\n  }\n}\n' },
  { name: 'rule-string-spans-lines-crlf', text: '{\r\n  "rules": {\r\n    "p": { ".read": "true\r\n      && true" }\r\n  }\r\n}\r\n' },
  { name: 'rule-string-raw-tab', text: '{\n  "rules": {\n    "p": { ".read": "true\t&& true" }\n  }\n}\n' },
  { name: 'rule-string-backslash-line-break', text: '{\n  "rules": {\n    "p": { ".read": "true \\\n      && true" }\n  }\n}\n' },
  { name: 'trailing-comma-in-rule-object', text: '{\n  "rules": {\n    "p": { ".read": "true", }\n  }\n}\n' },
  { name: 'trailing-comma-in-every-object', text: '{\n  "rules": {\n    "p": { ".read": "true", },\n  },\n}\n' },
  { name: 'trailing-comma-in-index-array', text: '{\n  "rules": {\n    "p": { ".indexOn": ["a", "b",] }\n  }\n}\n' },
  { name: 'trailing-comma-before-comment', text: '{\n  "rules": {\n    "p": { ".read": "true", // last\n    }\n  }\n}\n' },
  { name: 'line-and-block-comments', text: '{\n  // line\n  "rules": {\n    /* block */\n    "p": { ".read": "true" }\n  }\n}\n' },
  { name: 'double-comma', text: '{\n  "rules": {\n    "p": { ".read": "true",, }\n  }\n}\n' },
  { name: 'leading-comma', text: '{\n  "rules": {\n    "p": { , ".read": "true" }\n  }\n}\n' },
];

interface RtdbTextProbeRecord extends RtdbTextProbe {
  status: number;
  accepted: boolean;
  /** The rejection text with production's leading `line:column: ` position removed. */
  message?: string;
}

interface FirebaseWebConfig { projectId: string; databaseURL?: string }

async function main(): Promise<void> {
  const rawConfig = process.env.PYRIC_ORACLE_FIREBASE_CONFIG;
  if (!rawConfig) throw new Error('PYRIC_ORACLE_FIREBASE_CONFIG is not set.');
  const config = JSON.parse(rawConfig) as FirebaseWebConfig;
  if (!config.databaseURL) throw new Error('PYRIC_ORACLE_FIREBASE_CONFIG has no databaseURL.');
  const saPath = process.env.PYRIC_ORACLE_SA_PATH
    ? resolve(process.env.PYRIC_ORACLE_SA_PATH)
    : join(REPO_ROOT, 'ignored', 'service-account.json');
  if (!existsSync(saPath)) throw new Error(`service account not found at ${saPath}. Set PYRIC_ORACLE_SA_PATH.`);
  const sa = JSON.parse(readFileSync(saPath, 'utf8')) as ServiceAccountKey & { project_id: string };
  if (sa.project_id !== config.projectId) {
    throw new Error(`service account project ${sa.project_id} does not match config project ${config.projectId}.`);
  }

  const endpoint = rtdbRulesEndpoint(config.databaseURL, await mintAccessToken(sa, RTDB_RULES_SCOPE));
  const before = await endpoint.read();
  const probes: RtdbTextProbeRecord[] = [];
  for (const probe of TEXT_PROBES) {
    const { status, body } = await endpoint.dryRunText(probe.text);
    if (status !== 200 && status !== 400) throw new Error(`probe ${probe.name}: unexpected status ${status}`);
    const record: RtdbTextProbeRecord = { ...probe, status, accepted: status === 200 };
    if (status !== 200) record.message = rejectionMessage(body);
    probes.push(record);
    console.log(`  ${probe.name.padEnd(36)} ${record.accepted ? 'accepted' : 'REJECTED'} ${record.message ?? ''}`);
  }
  if ((await endpoint.read()) !== before) {
    throw new Error('the active rules changed during the dry-run capture; inspect the database rules.');
  }
  console.log('[rtdb-text-dialect] active rules read back byte-identical to the pre-run read.');

  const observation = {
    name: OBSERVATION_NAME,
    matrixRow: 'rtdb-rules#23',
    rowIds: ['rtdb-rules#23'],
    description:
      'Sends rules file text byte for byte to PUT /.settings/rules.json?dryRun=true, the request firebase deploy makes with the rules file, and records whether production accepts it or refuses it with its text: a rule string spanning lines (LF and CRLF), a raw tab and a backslash line break inside a rule string, trailing commas in objects and in an .indexOn array, comments, and a doubled or leading comma. The probes are TEXT_PROBES in packages/conformance/src/capture-rtdb-rules-text-dialect.ts. A dry run installs nothing; the active rules read back byte-identical after the run.',
    observedAt: new Date().toISOString(),
    fbSdkVersion: resolvedFirebaseVersion(),
    projectId: config.projectId,
    behavior: { calls: probes.length, probes },
  };
  writeFileSync(OUT, JSON.stringify(observation, null, 2) + '\n');
  console.log(`[rtdb-text-dialect] ${probes.length} dry-run validations; wrote ${OUT}`);
}

if (import.meta.main) {
  await main();
}
