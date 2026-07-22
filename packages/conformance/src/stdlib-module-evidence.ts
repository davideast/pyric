interface EvidenceRow {
  id: string;
  status: string;
  automation: string;
  oracleObservations: readonly string[];
}

interface EvidenceObservation {
  name: string;
  rowIds: readonly string[];
}

/**
 * Joins runtime-published stdlib evidence to the canonical conformance graph.
 * Public assurance may cite only an existing conforming, oracle-backed row
 * whose observations link back to that row.
 */
export function validateStdlibModuleEvidence(
  moduleEvidence: Readonly<Record<string, readonly string[]>>,
  rows: readonly EvidenceRow[],
  observations: readonly EvidenceObservation[],
): string[] {
  const problems: string[] = [];
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const observationsByName = new Map(observations.map((observation) => [
    observation.name,
    observation,
  ]));

  for (const [moduleName, evidenceIds] of Object.entries(moduleEvidence)) {
    for (const evidenceId of evidenceIds) {
      const row = rowsById.get(evidenceId);
      if (!row) {
        problems.push(`${moduleName}: evidence '${evidenceId}' is not a canonical registry row`);
        continue;
      }
      if (row.status !== 'conforms' || row.automation !== 'oracle-backed') {
        problems.push(`${moduleName}: evidence '${evidenceId}' must be conforms + oracle-backed`);
      }
      for (const observationName of row.oracleObservations) {
        const observation = observationsByName.get(observationName);
        if (!observation) {
          problems.push(`${moduleName}: observation '${observationName}' does not exist`);
        } else if (!observation.rowIds.includes(evidenceId)) {
          problems.push(
            `${moduleName}: observation '${observationName}' does not link back to '${evidenceId}'`,
          );
        }
      }
    }
  }
  return problems;
}
