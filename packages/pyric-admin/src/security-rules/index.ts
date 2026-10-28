/**
 * `pyric-admin/security-rules`: deferred service handle for `firebase-admin/security-rules`.
 */
import type { PyricAdminApp } from '../app/index.js';
import {
  deferredAdminEntry,
  guardDeferredServiceApp,
  wireDeferredService,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class SecurityRules {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('security-rules', 'SecurityRules', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare createRulesFileFromSource: (...args: unknown[]) => never;
  declare createRuleset: (...args: unknown[]) => Promise<never>;
  declare deleteRuleset: (...args: unknown[]) => Promise<never>;
  declare getFirestoreRuleset: (...args: unknown[]) => Promise<never>;
  declare getRuleset: (...args: unknown[]) => Promise<never>;
  declare getStorageRuleset: (...args: unknown[]) => Promise<never>;
  declare listRulesetMetadata: (...args: unknown[]) => Promise<never>;
  declare releaseFirestoreRuleset: (...args: unknown[]) => Promise<never>;
  declare releaseFirestoreRulesetFromSource: (...args: unknown[]) => Promise<never>;
  declare releaseStorageRuleset: (...args: unknown[]) => Promise<never>;
  declare releaseStorageRulesetFromSource: (...args: unknown[]) => Promise<never>;
}

export const getSecurityRules: (app?: PyricAdminApp) => SecurityRules = wireDeferredService(
  SecurityRules,
  'security-rules',
  'SecurityRules',
  {
    sync: ['createRulesFileFromSource'],
    async: [
      'createRuleset',
      'deleteRuleset',
      'getRuleset',
      'getFirestoreRuleset',
      'getStorageRuleset',
      'listRulesetMetadata',
      'releaseFirestoreRuleset',
      'releaseFirestoreRulesetFromSource',
      'releaseStorageRuleset',
      'releaseStorageRulesetFromSource',
    ],
  },
);

export const { Ruleset, RulesetMetadataList } = deferredAdminEntry('security-rules');
