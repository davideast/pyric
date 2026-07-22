/** Public Storage Rules family facade. Backend concepts remain private under sandbox/. */
export { parseStorageRules } from './sandbox/rules.js';
export { evaluateStorageRules } from './sandbox/rules-evaluator.js';
export type {
  StorageRules,
  StorageMethod,
  StorageVerb,
  StorageRequestMethod,
  StorageGrantVerb,
  StorageAuth,
  StorageRequest,
  StorageResource,
  EvaluationInput,
  EvaluationResult,
  FirestoreLookup,
} from './sandbox/rules.js';
