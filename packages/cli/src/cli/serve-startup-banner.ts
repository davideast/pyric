/**
 * Startup banner formatting for `startServe`.
 */
import { existsSync } from 'node:fs';
import { formatBrowserPersistNoticeLine } from './child-app-origin.js';
import { formatPyricCommand } from './command-hint.js';
import { hostingNoStaticSiteLine } from './firebase-json.js';
import { formatAiStatusLine } from '../serve/ai-status.js';
import { formatStartupFirestoreRulesLines } from '../serve/firestore-project-rules.js';
import type { RemoteAccessOptions } from '../serve/guard-policy.js';
import { formatRemoteAccessStartupLines } from '../serve/remote-access-config.js';
import type { SandboxSession } from '../serve/sandbox-session.js';
import type { resolveViteAiConfig } from '../serve/vite-ai-config.js';

/**
 * The startup line for Storage buckets firebase.json deploys no rules to. A
 * bucket with no rules is locked, as production creates one, or open under
 * permissive mode, as an RTDB instance without rules is (#1313).
 */
export function undeployedStorageLine(hasNoStorageRules: boolean, policy: 'allow' | 'deny'): string {
  const isOpen = policy === 'allow';
  if (hasNoStorageRules) {
    return isOpen
      ? '\u2022 rules    no storage.rules \u2014 storage sandbox allows client operations (permissive mode)'
      : '\u2022 rules    no storage.rules \u2014 storage sandbox denies client operations by default';
  }
  return isOpen
    ? '\u2022 rules    any other Storage bucket allows every client operation (permissive mode) until firebase.json deploys rules to it'
    : '\u2022 rules    any other Storage bucket denies every client operation until firebase.json deploys rules to it';
}

export interface ServeStartupBannerOptions {
  cwd: string;
  publicDir: string | null;
  publicDirLabel: string;
  hasFirebaseJson: boolean;
  hasHosting: boolean;
  url: string;
  usesEmbeddedAssets: boolean;
  bundleCached: boolean;
  bundleMs: number;
  usesHostedSandbox: boolean;
  permissive: boolean;
  session: SandboxSession;
  uiUrl: string | null;
  docsUrl: string | null;
  hasBridge: boolean;
  effectiveRemoteAccess: RemoteAccessOptions | undefined;
  sessionToken: string;
  resolvedAi: ReturnType<typeof resolveViteAiConfig>;
  ignoredGeminiKey: boolean;
  isWatchEnabled: boolean;
  logger: { info(message: string): void; note(message: string): void };
}

export function logServeStartupBanner(
  opts: ServeStartupBannerOptions,
): { restoredDocs: number; restoredUsers: number } | null {
  const {
    cwd,
    publicDir,
    publicDirLabel,
    hasFirebaseJson,
    hasHosting,
    url,
    usesEmbeddedAssets,
    bundleCached,
    bundleMs,
    usesHostedSandbox,
    permissive,
    session,
    uiUrl,
    docsUrl,
    hasBridge,
    effectiveRemoteAccess,
    sessionToken,
    resolvedAi,
    ignoredGeminiKey,
    isWatchEnabled,
    logger,
  } = opts;

  logger.info(`=== Serving from '${cwd}'...`);
  logger.info('');
  if (publicDir === null) {
    logger.info(hostingNoStaticSiteLine(hasFirebaseJson, hasHosting));
  } else {
    logger.info(`\u2714 hosting  Serving files from: ${publicDirLabel}`);
  }
  logger.info(`\u2714 hosting  Local server: ${url}`);
  if (usesEmbeddedAssets) {
    logger.info('\u2714 sandbox  pyric SDK bundles ready (embedded)');
  } else if (bundleCached) {
    logger.info('\u2714 sandbox  pyric SDK bundles ready (cache)');
  } else {
    logger.info(`\u2714 sandbox  pyric SDK bundles built in ${bundleMs}ms`);
  }
  const rulesTarget = usesHostedSandbox ? 'Node sandbox' : 'in-page sandbox';
  for (const line of formatStartupFirestoreRulesLines({
    hasDefaultRules: Boolean(session.payload().rules),
    defaultSourcePath: session.summary.rules.firestore.sourcePath,
    defaultHash: session.summary.rules.firestore.hash,
    rulesTarget,
    namedDatabases: session.summary.rules.firestoreDatabases,
    permissive,
  })) {
    logger.info(line);
  }
  const loadedDatabaseRules = session.summary.rules.database;
  if (loadedDatabaseRules.length > 0) {
    for (const loaded of loadedDatabaseRules) {
      logger.info(`\u2714 rules    ${loaded.sourcePath} \u2192 deployed to RTDB instance ${loaded.instance} (hash ${loaded.hash})`);
    }
  } else {
    logger.info('\u2022 rules    no database.rules \u2014 RTDB sandbox runs with default rules');
  }
  const hasStorageRules = Boolean(session.payload().storageRules);
  const storageBuckets = session.summary.rules.storageBuckets;
  if (hasStorageRules) {
    logger.info(`\u2714 rules    ${session.summary.rules.storage.sourcePath} \u2192 deployed to the default Storage bucket (hash ${session.summary.rules.storage.hash})`);
  }
  for (const loaded of storageBuckets) {
    logger.info(`\u2714 rules    ${loaded.sourcePath} \u2192 deployed to Storage bucket ${loaded.bucket} (hash ${loaded.hash})`);
  }
  const hasNoStorageRules = !hasStorageRules && storageBuckets.length === 0;
  logger.info(undeployedStorageLine(hasNoStorageRules, permissive ? 'allow' : 'deny'));
  if (uiUrl !== null) {
    logger.info(`\u2714 studio   Pyric Studio: ${uiUrl}`);
  }
  if (docsUrl !== null) {
    logger.info(`\u2714 docs     Pyric docs: ${docsUrl}`);
  }
  if (hasBridge) {
    logger.info(`\u2714 bridge   MCP endpoint: ${url}/__pyric/mcp (sandbox peers over ws at /__pyric/sandbox)`);
  }
  if (effectiveRemoteAccess !== undefined) {
    const startupLines = formatRemoteAccessStartupLines({
      remoteAccess: effectiveRemoteAccess,
      sessionToken,
      https: url.startsWith('https://'),
      prefix: '  ',
    });
    for (const line of startupLines) {
      logger.info(line);
    }
  }
  // AI is a mounted service like the bridge: `/__pyric/ai-proxy` answers from
  // the first request on, whether or not anything is configured. Report the
  // engine and proxy upstream resolved from `pyric.json` (`ai`) and env.
  logger.info(
    formatAiStatusLine({
      hosted: usesHostedSandbox,
      mode: resolvedAi.mode,
      engine: resolvedAi.engineWire,
      proxyUpstream: resolvedAi.proxyUpstream,
      ignoredGeminiKey,
    }),
  );
  let persistSummary: { restoredDocs: number; restoredUsers: number } | null = null;
  const persistence = session.summary.persistence;
  if (persistence !== null) {
    const fsDocs = persistence.restoredDocs;
    const users = persistence.restoredUsers;
    persistSummary = { restoredDocs: fsDocs, restoredUsers: users };
    const appliedHostedSeed = usesHostedSandbox && persistence.seedApplied;
    if (appliedHostedSeed) {
      logger.info(`\u2714 persist  ${persistence.path} (${fsDocs} doc(s), ${users} user(s); --seed applied)`);
    } else if (persistence.restored) {
      logger.info(`\u2714 persist  ${persistence.path} (${fsDocs} doc(s), ${users} user(s) restored; --seed skipped)`);
    } else {
      logger.info(`\u2714 persist  new state file at ${persistence.path} (first run \u2014 seed applies)`);
    }
    if (existsSync(persistence.backupPath)) {
      const recoveryInstructions = usesHostedSandbox
        ? 'Restore: stop the host, move the current .pyric/state/hosted directory aside, then rename this archive to .pyric/state/hosted.'
        : '(prior non-empty state was replaced by an empty one \u2014 e.g. a reset). Restore: mv it back over state.json.';
      logger.note(`  \u24d8 a recovery backup exists at ${persistence.backupPath} ${recoveryInstructions}`);
    }
  } else if (usesHostedSandbox) {
    logger.note('  \u24d8 persist  data is held in Node memory and is lost when this process stops.');
  } else {
    logger.note(formatBrowserPersistNoticeLine());
  }
  // (A fixture that primed the persist store is reported by the persist
  // line; a fixture ignored because lived state exists is intentionally
  // silent about staging.)
  if (session.summary.seedStaged) {
    logger.info(`\u2714 seed     ${session.summary.seedLabel} staged for page init`);
  }
  if (Boolean(session.summary.capturePath)) {
    const verifyCmd = formatPyricCommand('verify');
    logger.info(`\u2714 capture  session \u2192 ${session.summary.capturePath} (run \`${verifyCmd}\` to replay it)`);
  }
  if (isWatchEnabled) {
    const [firestoreRulesFile] = session.firestoreRulesFiles();
    logger.info(`\u2714 watch    hot-reloading ${firestoreRulesFile} over /__pyric/events`);
    for (const databaseRulesFile of session.databaseRulesFiles()) {
      logger.info(`\u2714 watch    hot-reloading ${databaseRulesFile} over /__pyric/events`);
    }
    for (const storageRulesFile of session.storageRulesFiles()) {
      logger.info(`\u2714 watch    hot-reloading ${storageRulesFile} over /__pyric/events`);
    }
  }
  // Browser-honesty: the sandbox is browser-resident -- firestore/auth and
  // persistence run IN the served page. With no page open, data ops silently
  // no-op. This warning (paired with auto-open in runServe) is the fix for the
  // "I ran serve and nothing happened" surprise. Always printed.
  logger.note('');
  if (usesHostedSandbox) {
    logger.note('  \u24d8 the pyric sandbox executes in this Node process.');
  } else {
    logger.note('  \u26a0 the pyric sandbox runs IN the served page \u2014 keep the browser tab open.');
    logger.note('    Firestore/auth data and persistence stop when no page is open.');
  }
  return persistSummary;
}
