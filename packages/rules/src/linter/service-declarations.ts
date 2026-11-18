import type { FirestoreRules } from '../grammar/FirestoreAST.js';
import {
  allServiceBlocks,
  firestoreServiceBlock,
  isRecognizedServiceName,
  storageServiceBlock,
  type LintTargetService,
} from '../grammar/service-blocks.js';
import {
  DUPLICATE_SERVICE_REASON,
  duplicateServiceRejection,
} from '../grammar/source-compile-limits.js';
import type { LintWarning } from './linter.js';

/**
 * Check `service` block declarations in a parsed rules file:
 * - Duplicate declarations of one service are compile blockers (`error`).
 * - Unknown service names emit `INVALID_SERVICE_NAME` (`warning`), matching
 *   production's `WARNING: Invalid service name: <name>.` (#1434).
 * - When linting specifically for `cloud.firestore` on a file that declares no
 *   `service cloud.firestore` block, emit `MISSING_FIRESTORE_SERVICE` (`warning`).
 */
export function checkServiceDeclarations(
  ast: FirestoreRules,
  targetService: LintTargetService | undefined,
): LintWarning[] {
  const warnings: LintWarning[] = [];
  const duplicate = duplicateServiceRejection(ast);
  if (duplicate !== null) {
    warnings.push({
      rule: 'DUPLICATE_SERVICE',
      severity: 'error',
      message: DUPLICATE_SERVICE_REASON,
      location: { line: duplicate.line },
      fix: 'Declare each service block at most once per rules file and place every match block for that service inside it.',
    });
  }
  const services = allServiceBlocks(ast);
  for (const service of services) {
    if (!isRecognizedServiceName(service.name)) {
      let location: LintWarning['location'];
      if (service.loc) {
        location = { line: service.loc.line };
      }
      warnings.push({
        rule: 'INVALID_SERVICE_NAME',
        severity: 'warning',
        message: `Invalid service name: ${service.name}.`,
        location,
        fix: "Use 'service cloud.firestore' for Firestore rules or 'service firebase.storage' for Storage rules.",
      });
    }
  }
  if (targetService === 'cloud.firestore') {
    const first = services[0];
    if (first !== undefined && firestoreServiceBlock(ast) === undefined) {
      let location: LintWarning['location'];
      if (first.loc) {
        location = { line: first.loc.line };
      }
      warnings.push({
        rule: 'MISSING_FIRESTORE_SERVICE',
        severity: 'warning',
        message:
          `Ruleset declares 'service ${first.name}' with no 'service cloud.firestore' block; ` +
          'production compiles it and denies every Firestore request.',
        location,
        fix: "Declare a 'service cloud.firestore' block for Firestore rules.",
      });
    }
  }
  if (targetService === 'firebase.storage') {
    const first = services[0];
    if (first !== undefined && storageServiceBlock(ast) === undefined) {
      let location: LintWarning['location'];
      if (first.loc) {
        location = { line: first.loc.line };
      }
      warnings.push({
        rule: 'MISSING_STORAGE_SERVICE',
        severity: 'warning',
        message:
          `Ruleset declares 'service ${first.name}' with no 'service firebase.storage' block; ` +
          'production compiles it and denies every Storage request.',
        location,
        fix: "Declare a 'service firebase.storage' block for Storage rules.",
      });
    }
  }
  return warnings;
}
