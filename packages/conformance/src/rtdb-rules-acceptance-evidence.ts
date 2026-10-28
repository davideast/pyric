import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageConstruct, LanguageSnapshot } from '../rules-language/types.ts';
import { probeEngine } from './rules-language-capability.ts';
import { loadSnapshot } from '../rules-language/load.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  rtdbObservationName,
  type RtdbDeployVerdict,
} from '../rules-corpus/rtdb/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RTDB_ACCEPTANCE_EVIDENCE_PATH = join(
  HERE,
  '..',
  'rules-language',
  'rtdb-acceptance-evidence.json',
);
export const RTDB_ACCEPTANCE_EVIDENCE_NOTE =
  'Committed production acceptance evidence for Realtime Database rules derived from live-database deploy-observe-restore captures.';

export interface RtdbAcceptanceEvidenceConstruct {
  id: string;
  kind: string;
  status: LanguageConstruct['status'];
  probeNote?: string;
  evidenceSource?: 'rules-test-api' | 'live-database';
  /** The observation that records production's deploy verdict, for a
   *  construct a deploy scenario isolates. */
  observation?: string;
}

export interface RtdbDeployStatus {
  status: 'accepted' | 'rejected';
  /** Production's error texts, for a rejected construct. */
  probeNote?: string;
  observation: string;
}

const RTDB_OBSERVATION_DIR = join(HERE, '..', 'observations', 'rtdb-rules');

/**
 * Production's deploy verdict for each construct a deploy scenario isolates,
 * read from the scenario's captured observation. Every case of one construct
 * must agree: a construct production accepts in one ruleset and rejects in
 * another names two behaviors and is an authoring error.
 */
export function rtdbDeployStatuses(): Map<string, RtdbDeployStatus> {
  const out = new Map<string, RtdbDeployStatus>();
  for (const scenario of ALL_RULES_RTDB_DEPLOY_SCENARIOS) {
    const observation = rtdbObservationName(scenario);
    const path = join(RTDB_OBSERVATION_DIR, `${observation}.json`);
    if (!existsSync(path)) continue;
    const behavior = (JSON.parse(readFileSync(path, 'utf8')) as { behavior: Record<string, RtdbDeployVerdict> }).behavior;
    const byConstruct = new Map<string, RtdbDeployVerdict[]>();
    for (const deployCase of scenario.deployCases) {
      const verdict = behavior[deployCase.description];
      if (!verdict) throw new Error(`${observation} has no verdict for '${deployCase.description}'`);
      byConstruct.set(deployCase.construct, [...(byConstruct.get(deployCase.construct) ?? []), verdict]);
    }
    for (const [construct, verdicts] of byConstruct) {
      const kinds = new Set(verdicts.map((verdict) => verdict.verdict));
      if (kinds.size > 1) throw new Error(`${observation}: production both accepts and rejects ${construct}`);
      if (out.has(construct)) throw new Error(`${construct} is isolated by more than one deploy scenario`);
      const errors = [...new Set(verdicts.flatMap((verdict) => verdict.verdict === 'REJECTED' ? [verdict.error] : []))];
      out.set(construct, errors.length > 0
        ? { status: 'rejected', probeNote: `production rejects the deploy: ${errors.join(' | ')}`, observation }
        : { status: 'accepted', observation });
    }
  }
  return out;
}

export interface RtdbAcceptanceEvidence {
  schema: 'pyric.conformance.rtdb-rules-acceptance-evidence.v1';
  generatedNote: string;
  capturedAt: string;
  projectId: string;
  engine: 'rtdb';
  total: number;
  accepted: number;
  rejected: number;
  unprobeable: number;
  constructs: RtdbAcceptanceEvidenceConstruct[];
}

export function validateRtdbAcceptanceEvidence(
  snapshot: readonly LanguageConstruct[],
  evidence: RtdbAcceptanceEvidence,
): void {
  if (
    evidence.schema !== 'pyric.conformance.rtdb-rules-acceptance-evidence.v1' ||
    evidence.generatedNote !== RTDB_ACCEPTANCE_EVIDENCE_NOTE ||
    evidence.engine !== 'rtdb' ||
    !evidence.projectId ||
    Number.isNaN(Date.parse(evidence.capturedAt))
  ) {
    throw new Error('RTDB acceptance evidence metadata is invalid');
  }
  if (evidence.total !== snapshot.length || evidence.constructs.length !== snapshot.length) {
    throw new Error(
      `RTDB acceptance evidence universe mismatch: expected ${snapshot.length}, got ` +
        `${evidence.total}/${evidence.constructs.length}`,
    );
  }
  const byId = new Map<string, RtdbAcceptanceEvidenceConstruct>();
  for (const row of evidence.constructs) {
    if (byId.has(row.id)) throw new Error(`RTDB acceptance evidence duplicates ${row.id}`);
    byId.set(row.id, row);
  }
  for (const construct of snapshot) {
    const row = byId.get(construct.id);
    if (!row) throw new Error(`RTDB acceptance evidence is missing ${construct.id}`);
    if (row.kind !== construct.kind || row.status !== construct.status) {
      throw new Error(`RTDB acceptance evidence status/kind mismatch for ${construct.id}`);
    }
    if (row.probeNote !== construct.probeNote) {
      throw new Error(`RTDB acceptance evidence probe note mismatch for ${construct.id}`);
    }
    if (row.status === 'rejected' && !row.observation) {
      throw new Error(`RTDB acceptance evidence names no observation for rejected construct ${construct.id}`);
    }
    if (row.status === 'accepted' && row.evidenceSource !== 'live-database') {
      throw new Error(`RTDB acceptance evidence requires live-database source for accepted construct ${construct.id}`);
    }
  }
}

export function loadAndValidateRtdbAcceptanceEvidence(
  snapshot: readonly LanguageConstruct[],
): RtdbAcceptanceEvidence {
  const evidence = JSON.parse(readFileSync(RTDB_ACCEPTANCE_EVIDENCE_PATH, 'utf8')) as RtdbAcceptanceEvidence;
  validateRtdbAcceptanceEvidence(snapshot, evidence);
  return evidence;
}

export function generateRtdbAcceptanceEvidence(projectId: string): RtdbAcceptanceEvidence {
  const snapshot = loadSnapshot('rtdb');
  const capabilities = probeEngine('rtdb');
  const capById = new Map(capabilities.map((c) => [c.id, c]));
  const deployStatuses = rtdbDeployStatuses();

  const updatedConstructs: LanguageConstruct[] = [];
  const evidenceConstructs: RtdbAcceptanceEvidenceConstruct[] = [];
  let accepted = 0;
  let rejected = 0;
  let unprobeable = 0;

  for (const c of snapshot.constructs) {
    const cap = capById.get(c.id);
    // A construct a deploy scenario isolates takes production's deploy verdict.
    const deploy = deployStatuses.get(c.id);
    const isUnprobeable = !deploy && cap?.classification === 'unprobeable';
    const status: LanguageConstruct['status'] = deploy?.status ?? (isUnprobeable ? 'unprobeable' : 'accepted');
    const probeNote = deploy ? deploy.probeNote : isUnprobeable ? cap?.detail : undefined;

    if (status === 'accepted') accepted++;
    else if (status === 'rejected') rejected++;
    else if (status === 'unprobeable') unprobeable++;

    const updatedC: LanguageConstruct = {
      ...c,
      status,
      ...(probeNote ? { probeNote } : {}),
    };
    if (!probeNote && 'probeNote' in updatedC) delete (updatedC as any).probeNote;
    updatedConstructs.push(updatedC);

    evidenceConstructs.push({
      id: c.id,
      kind: c.kind,
      status,
      ...(probeNote ? { probeNote } : {}),
      ...(status === 'accepted' ? { evidenceSource: 'live-database' } : {}),
      ...(deploy ? { observation: deploy.observation } : {}),
    });
  }

  const rtdbJsonPath = join(HERE, '..', 'rules-language', 'rtdb.json');
  const rawSnapshot = JSON.parse(readFileSync(rtdbJsonPath, 'utf8')) as LanguageSnapshot;
  writeFileSync(
    rtdbJsonPath,
    JSON.stringify({ ...rawSnapshot, constructs: updatedConstructs }, null, 2) + '\n',
    'utf8',
  );

  const evidence: RtdbAcceptanceEvidence = {
    schema: 'pyric.conformance.rtdb-rules-acceptance-evidence.v1',
    generatedNote: RTDB_ACCEPTANCE_EVIDENCE_NOTE,
    capturedAt: new Date().toISOString(),
    projectId,
    engine: 'rtdb',
    total: snapshot.constructs.length,
    accepted,
    rejected,
    unprobeable,
    constructs: evidenceConstructs,
  };

  writeFileSync(RTDB_ACCEPTANCE_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  return evidence;
}
