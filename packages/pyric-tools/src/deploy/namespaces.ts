/**
 * Named-object groupings at the @pyric/cli/deploy root entry. Each
 * group bundles the primitives for one Firebase product (hosting,
 * functions, etc.) under a typed namespace.
 *
 * Per F2 + F3, every operation that mutates a project takes
 * `scope: ProjectScope` as its first argument. The namespaces here
 * are thin re-wrappings of the underlying portable primitives —
 * they call `withResolvedScope` to bridge the scope-vs-(token,
 * projectId) shape mismatch with the existing internal functions.
 */

import { walkDir, type WalkedFile } from './hosting/walk.js';
import {
  deployHostingFiles,
  type DeployHostingFilesInput,
} from './hosting/core.js';
import {
  createHostingSite,
  ensureHostingSite,
  type CreateHostingSiteInput,
} from './hosting/sites.js';
import {
  deployFunctions,
  type DeployFunctionsCoreInput,
} from './functions/core.js';
import { bundleFunctionSource } from './functions/bundle.js';
import { pollOperation, type PollOptions } from './functions/operation.js';
import type { FunctionDeployConfig } from './functions/spec.js';
import * as rulesImpl from './firestore/rules.js';
import * as indexesImpl from './firestore/indexes.js';
import * as databasesImpl from './firestore/databases.js';
import * as recipesImpl from './firestore/recipes.js';
import * as rtdbRulesImpl from './rtdb/rules.js';
import { grantPublicInvoker } from './functions/iam.js';
import type { HostingJsonConfig } from './hosting/spec.js';
import type { ProjectScope } from './scope.js';

// ─── hosting namespace ───────────────────────────────────────────────

export interface DeployHostingScopedOptions {
  /** Hosting site id. */
  siteId: string;
  /** Local directory walked recursively (Node-only). */
  localDir?: string;
  /**
   * firebase.json `ignore` globs applied while walking `localDir`
   * (`**`, `*`, `?`, `{a,b}`). Omit for firebase-tools' scaffold
   * defaults (`firebase.json`, `**\/.*`, `**\/node_modules/**`).
   * Not applied to pre-walked `files`.
   */
  ignore?: string[];
  /** Pre-walked file list — supply when the host runs in a browser. */
  files?: WalkedFile[];
  /**
   * firebase.json-shaped hosting block (rewrites / redirects / headers
   * / cleanUrls / trailingSlash / appAssociation / i18n) baked into
   * the version's serving config.
   */
  config?: HostingJsonConfig;
  /** Preview-channel id. Omit (or `'live'`) for a live release. */
  channelId?: string;
  /** Channel TTL (protobuf Duration, e.g. `'604800s'`) — create only. */
  channelTtl?: string;
}

export const hosting = {
  /**
   * Walk a directory (Node) OR accept a pre-walked file list
   * (browser), then deploy each file via content-hash dedup.
   */
  async deployFiles(scope: ProjectScope, options: DeployHostingScopedOptions) {
    const token = await scope.resolveToken();
    let files: WalkedFile[];
    if (options.files) {
      files = options.files;
    } else if (options.localDir) {
      files = walkDir(options.localDir, options.ignore);
    } else {
      throw new Error(
        'hosting.deployFiles: must supply either `files` (pre-walked) or `localDir` (Node only)',
      );
    }
    const input: DeployHostingFilesInput = {
      siteId: options.siteId,
      files,
      accessToken: token,
      ...(options.config ? { config: options.config } : {}),
      ...(options.channelId ? { channelId: options.channelId } : {}),
      ...(options.channelTtl ? { channelTtl: options.channelTtl } : {}),
    };
    return deployHostingFiles(input);
  },
  sites: {
    async create(
      scope: ProjectScope,
      input: Omit<CreateHostingSiteInput, 'projectId' | 'accessToken'>,
    ) {
      const token = await scope.resolveToken();
      return createHostingSite({
        projectId: scope.projectId,
        accessToken: token,
        ...input,
      });
    },
    async ensure(
      scope: ProjectScope,
      input: Omit<CreateHostingSiteInput, 'projectId' | 'accessToken'>,
    ) {
      const token = await scope.resolveToken();
      return ensureHostingSite({
        projectId: scope.projectId,
        accessToken: token,
        ...input,
      });
    },
  },
};

// ─── functions namespace ─────────────────────────────────────────────

export interface DeployFunctionsLocalOptions {
  /** Path to the functions source directory (Node-only). */
  localDir: string;
  /** Functions to deploy from the same source bundle. */
  functions: FunctionDeployConfig[];
}

export const functions = {
  /**
   * Bundle a local source directory (Node-only) and deploy. The
   * one-call convenience the previous `FunctionsDeployHandler`
   * exposed, reshaped onto ProjectScope.
   */
  async deployLocal(scope: ProjectScope, options: DeployFunctionsLocalOptions) {
    if (!options || typeof options.localDir !== 'string' || !options.localDir) {
      return {
        success: false as const,
        error: { code: 'INVALID_INPUT' as const, message: 'localDir must be a non-empty string', recoverable: true },
      };
    }
    if (!Array.isArray(options.functions) || options.functions.length === 0) {
      return {
        success: false as const,
        error: { code: 'INVALID_INPUT' as const, message: 'functions must be a non-empty array', recoverable: true },
      };
    }
    let bundle;
    try {
      bundle = bundleFunctionSource(options.localDir);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        success: false as const,
        error: { code: 'SOURCE_BUNDLE_FAILED' as const, message, recoverable: true },
      };
    }
    const token = await scope.resolveToken();
    return deployFunctions({
      projectId: scope.projectId,
      sourceZip: bundle.zip,
      defaultRuntime: bundle.runtime,
      functions: options.functions,
      accessToken: token,
    });
  },
  /**
   * Deploy a pre-built bundle. Use when the caller manages bundling
   * separately (e.g. a browser host shipping a zip from any source).
   */
  async deploy(
    scope: ProjectScope,
    input: Omit<DeployFunctionsCoreInput, 'accessToken' | 'projectId'>,
  ) {
    const token = await scope.resolveToken();
    return deployFunctions({
      ...input,
      accessToken: token,
      projectId: scope.projectId,
    });
  },
  /** Bundle source for a Cloud Function. Pure-Node (esbuild). */
  bundle(localDir: string) {
    return bundleFunctionSource(localDir);
  },
  /** Poll a long-running Cloud Functions operation. */
  async pollOperation(scope: ProjectScope, operationName: string, opts?: PollOptions) {
    const token = await scope.resolveToken();
    return pollOperation(operationName, token, opts ?? {});
  },
  /** Grant the all-users public-invoker IAM binding to a function. */
  async grantPublicInvoker(
    scope: ProjectScope,
    input: { region: string; serviceId: string },
  ) {
    const token = await scope.resolveToken();
    return grantPublicInvoker({
      ...input,
      projectId: scope.projectId,
      accessToken: token,
    });
  },
};

// ─── firestore namespace ─────────────────────────────────────────────
//
// Per F-convention: primitives throw `AdminApiError` on non-2xx;
// orchestrators return `Outcome`. Same shape across all sub-
// namespaces (`rules`, `indexes`, `databases`). Method-level JSDoc
// on each implementation marks its kind explicitly. Summary:
//
//   firestore.rules.fetch       primitive (throws)
//   firestore.rules.deploy      primitive (throws)
//   firestore.rules.inject      pure utility
//   firestore.rules.check       orchestrator (returns outcome)
//   firestore.rules.ensure      orchestrator (returns outcome)
//
//   firestore.indexes.create    primitive (throws)
//   firestore.indexes.deployAll orchestrator (returns outcome)
//   firestore.indexes.getStatus orchestrator (returns outcome)
//
//   firestore.databases.provision orchestrator (returns outcome)
//
// Consumers that want a single shape everywhere use the
// orchestrators; consumers reaching for finer-grained error
// handling use the primitives + a try/catch.

export const firestore = {
  rules: {
    fetch: rulesImpl.fetchCurrentRules,
    deploy: rulesImpl.deploy,
    inject: rulesImpl.inject,
    check: rulesImpl.check,
    ensure: rulesImpl.ensure,
  },
  indexes: {
    create: indexesImpl.create,
    deployAll: indexesImpl.deployAll,
    getStatus: indexesImpl.getStatus,
  },
  databases: {
    provision: databasesImpl.provision,
  },
};

// ─── realtime database namespace ────────────────────────────────────

export const rtdb = {
  rules: {
    fetch: rtdbRulesImpl.fetchRules,
    deploy: rtdbRulesImpl.deployRules,
    discoverDefaultDatabaseUrl: rtdbRulesImpl.discoverDefaultDatabaseUrl,
    resolveDatabaseUrl: rtdbRulesImpl.resolveDatabaseUrl,
  },
};

// ─── recipes namespace ───────────────────────────────────────────────

export const recipes = {
  pyricSessions: recipesImpl.pyricSessions,
};
