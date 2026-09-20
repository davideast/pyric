/** Compare semantics first. Local elapsed times are deliberately not compared. */
export function compareEvidence(left, right, expectedAssertions) {
  const coverage = [...coverageIssues(left, expectedAssertions), ...coverageIssues(right, expectedAssertions)];
  const mismatches = ['schemaVersion'].filter(key => left[key] !== right[key]);
  for (const key of ['workloadHash', 'rulesHash', 'implementationHash']) if (left.run[key] !== right.run[key]) mismatches.push(key);
  const keys = run => run.assertions.map(a => `${a.caseId}:${a.name}`).sort();
  if (coverage.length) mismatches.push('required coverage');
  if (JSON.stringify(keys(left)) !== JSON.stringify(keys(right))) mismatches.push('assertion coverage');
  if ([...left.cases, ...right.cases].some(c => c.status !== 'complete')) mismatches.push('incomplete case');
  return { compatible: mismatches.length === 0, mismatches, decisions: mismatches.length ? [] : left.assertions.map(a => ({ caseId: a.caseId, name: a.name, left: a.passed, right: right.assertions.find(b => b.caseId === a.caseId && b.name === a.name).passed })), performanceComparable: false };
}

export function coverageIssues(result, expectedAssertions) {
  const issues = [];
  for (const [caseId, names] of Object.entries(expectedAssertions)) {
    if (result.cases.filter(c => c.id === caseId && c.status === 'complete').length !== 1) issues.push(`${caseId}: incomplete or duplicate case`);
    for (const name of names) {
      if (result.assertions.filter(a => a.caseId === caseId && a.name === name).length !== 1) issues.push(`${caseId}: missing or duplicate ${name}`);
    }
  }
  return issues;
}
