/** Internal types mirroring the Firebase Hosting REST API responses. */

export interface VersionResource {
  /** Full resource name: `sites/{siteId}/versions/{versionId}`. */
  name: string;
  status?: 'CREATED' | 'FINALIZED' | 'DELETED' | 'EXPIRED';
}

export interface PopulateFilesResponse {
  /**
   * Hashes the server still needs uploaded. Hashes already present
   * from a prior version are absent — the inter-version dedup we
   * benefit from for free.
   */
  uploadRequiredHashes?: string[];
  uploadUrl: string;
}

export interface ReleaseResource {
  /** Full resource name: `sites/{siteId}/releases/{releaseId}`. */
  name: string;
}

/**
 * `config` body shape for `POST /sites/{siteId}/versions` — the REST
 * `ServingConfig` (clones/firebase-tools/src/hosting/api.ts:154-162).
 * Every supported firebase.json hosting key translates into exactly
 * one field here; the translation lives in `config.ts`.
 */
export interface VersionConfig {
  rewrites?: VersionRewriteEntry[];
  redirects?: VersionRedirectEntry[];
  headers?: VersionHeaderEntry[];
  cleanUrls?: boolean;
  /** REST spells firebase.json's boolean `trailingSlash` as ADD/REMOVE (api.ts:159). */
  trailingSlashBehavior?: 'ADD' | 'REMOVE';
  appAssociation?: 'AUTO' | 'NONE';
  i18n?: { root: string };
}

/** REST pattern selector (api.ts:128) — exactly one of glob | regex. */
export type VersionHasPattern = { glob: string } | { regex: string };

/**
 * REST rewrite (api.ts:145-152). Hosting v1beta1 takes the function
 * as a SCALAR (function id) with the optional region as a sibling
 * `functionRegion` field — not as a nested object. Run rewrites take
 * `{ serviceId, region }` (region required — defaulted client-side,
 * convertConfig.ts:252).
 */
export type VersionRewriteEntry = VersionHasPattern &
  (
    | { path: string }
    | { function: string; functionRegion?: string }
    | { run: { serviceId: string; region: string } }
  );

/** REST redirect (api.ts:135-138). `statusCode` omitted → server serves 301. */
export type VersionRedirectEntry = VersionHasPattern & {
  location: string;
  statusCode?: number;
};

/** REST headers entry (api.ts:130-133) — a MAP, not the firebase.json array. */
export type VersionHeaderEntry = VersionHasPattern & {
  headers: Record<string, string>;
};
