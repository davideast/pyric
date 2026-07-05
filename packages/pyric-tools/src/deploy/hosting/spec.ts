/**
 * Public types for `HostingDeployHandler`. The five Hosting REST
 * calls (create-version → populate-files → upload-each → finalize →
 * release) collapse to one outcome — any non-recoverable failure
 * aborts the rest.
 */

export type DeployHostingResult =
  | { success: true; data: DeployHostingSuccess }
  | { success: false; error: DeployHostingError };

export interface DeployHostingSuccess {
  siteId: string;
  /** Full resource name: `sites/{siteId}/versions/{versionId}` */
  versionName: string;
  /** Full resource name: `sites/{siteId}/releases/{releaseId}` */
  releaseName: string;
  /** Number of files declared in the manifest. */
  fileCount: number;
  /**
   * Number of files actually uploaded to GCS. Less than `fileCount`
   * when Hosting already had matching content hashes from a prior
   * version (server-side dedup via `uploadRequiredHashes`).
   */
  uploadedCount: number;
  /** Public URL the release will be reachable at once propagation completes. */
  hostingUrl: string;
  /** Preview-channel id, present only when this was a channel deploy. */
  channelId?: string;
  /**
   * Preview URL (`https://<site>--<channelId>-<hash>.web.app`), read
   * from the channel resource's `url` — the hash is server-assigned
   * and never synthesized locally.
   */
  channelUrl?: string;
  /** RFC3339 timestamp the channel auto-deletes at (channel deploys only). */
  channelExpireTime?: string;
  /**
   * Non-fatal config translation warnings (unknown hosting keys,
   * keys handled by other inputs). Never silently dropped — the
   * "warn loudly" contract from the parity plan.
   */
  configWarnings?: string[];
}

export interface DeployHostingError {
  code: HostingErrorCode;
  message: string;
  recoverable: boolean;
}

export type HostingErrorCode =
  | 'INVALID_INPUT'
  | 'PERMISSION_DENIED'
  | 'SITE_NOT_FOUND'
  | 'CREATE_VERSION_FAILED'
  | 'POPULATE_FAILED'
  | 'UPLOAD_FAILED'
  | 'FINALIZE_FAILED'
  | 'RELEASE_FAILED'
  /**
   * Hosting only validates rewrite targets (functions / Cloud Run
   * services) at FINALIZE time, not on `versions.create`. A 400 at
   * finalize that names a missing function maps to this code so the
   * caller can distinguish "I deployed before the function existed"
   * from generic finalize failures.
   */
  | 'REWRITE_TARGET_NOT_FOUND'
  /**
   * Provisioning the preview channel failed before any version was
   * created (the channel is ensured first so a bad channel id fails
   * fast, with nothing uploaded). 403/network keep their generic
   * codes; this covers invalid ids and other channel-API failures.
   */
  | 'CHANNEL_FAILED'
  | 'NETWORK_ERROR';

// ─── firebase.json hosting shapes ────────────────────────────────────
//
// These mirror the firebase.json hosting block exactly
// (clones/firebase-tools/src/firebaseConfig.ts:59-135) so a hosting
// entry can be passed through unmodified. Translation to the REST
// `versions.create` shape lives in `config.ts` (the convertConfig.ts
// mirror).

/**
 * Pattern selector shared by rewrites / redirects / headers. `source`
 * and `glob` are interchangeable spellings of a Hosting glob
 * (firebaseConfig.ts:59); `regex` is RE2.
 */
export type HostingSource = { glob: string } | { source: string } | { regex: string };

/**
 * One firebase.json rewrite (firebaseConfig.ts:65-88). Exactly one
 * target: static `destination`, `function` (legacy string or object
 * form), or Cloud Run. `dynamicLinks` is rejected at build time
 * (product sunset) and `pinTag` is deferred (Track C) — both kept in
 * the type so configs naming them produce a CLEAR error instead of a
 * type-level mystery.
 */
export type HostingRewriteJson = HostingSource &
  (
    | { destination: string }
    | { function: string; region?: string }
    | { function: { functionId: string; region?: string; pinTag?: boolean } }
    | { run: { serviceId: string; region?: string; pinTag?: boolean } }
    | { dynamicLinks: boolean }
  );

/** One firebase.json redirect (firebaseConfig.ts:61-64). */
export type HostingRedirectJson = HostingSource & {
  destination: string;
  /** HTTP status code. Omitted → Hosting serves 301. */
  type?: number;
};

/** One firebase.json headers entry (firebaseConfig.ts:90-95). */
export type HostingHeaderJson = HostingSource & {
  headers: { key: string; value: string }[];
};

/**
 * The serving-config subset of a firebase.json hosting entry
 * (firebaseConfig.ts:120-135 `HostingBase`). `public` / `site` /
 * `target` / `ignore` are deploy-mechanics keys consumed by other
 * inputs (`localDir`/`files`, `siteId`, `ignore`) — passing them here
 * yields a warning, never a silent drop. Unknown keys also warn.
 */
export interface HostingJsonConfig {
  rewrites?: HostingRewriteJson[];
  redirects?: HostingRedirectJson[];
  headers?: HostingHeaderJson[];
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  appAssociation?: 'AUTO' | 'NONE';
  i18n?: { root: string };
  [key: string]: unknown;
}
