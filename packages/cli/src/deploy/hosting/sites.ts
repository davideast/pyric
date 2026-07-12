/**
 * Hosting site provisioning. The Hosting REST API exposes
 *   POST /v1beta1/projects/{projectId}/sites?siteId={id}
 * to create a new site within a project. Multi-site projects use
 * this — the default site (matching the project id) is auto-
 * provisioned, but additional named sites must be created
 * explicitly. Without a site, `versions.create` returns 404.
 *
 * Site id rules (per Hosting docs):
 *   - 3 to 30 characters
 *   - lowercase letters, digits, hyphens
 *   - must start and end with a letter or digit
 *   - **globally unique** across all Firebase projects (because the
 *     id maps to `<siteId>.web.app`)
 *
 * We don't pre-validate the id locally — let Hosting reject
 * malformed ids with its own error so we don't drift from the
 * server's evolving rule set.
 */

const HOSTING_API = 'https://firebasehosting.googleapis.com/v1beta1';

export type CreateSiteResult =
  | { kind: 'ok'; site: HostingSiteResource }
  | { kind: 'already_exists'; siteId: string }
  | { kind: 'invalid_id'; siteId: string; message: string }
  | { kind: 'permission_denied'; message: string }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'network_error'; message: string };

export interface HostingSiteResource {
  /** `projects/{projectNumber}/sites/{siteId}` */
  name: string;
  /** Default URL Hosting will serve on (e.g. `https://my-site.web.app`). */
  defaultUrl?: string;
  type?: 'DEFAULT_SITE' | 'USER_SITE' | 'TYPE_UNSPECIFIED';
  appId?: string;
}

export interface CreateHostingSiteInput {
  projectId: string;
  /** Globally-unique site id. Becomes `<siteId>.web.app`. */
  siteId: string;
  /** Optional Firebase web app id to associate with the site. */
  appId?: string;
  accessToken: string;
}

export async function createHostingSite(
  input: CreateHostingSiteInput,
): Promise<CreateSiteResult> {
  const url = `${HOSTING_API}/projects/${encodeURIComponent(input.projectId)}/sites?siteId=${encodeURIComponent(input.siteId)}`;
  const body = input.appId ? JSON.stringify({ appId: input.appId }) : '{}';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  } catch (e) {
    return { kind: 'network_error', message: e instanceof Error ? e.message : String(e) };
  }
  if (res.ok) {
    const site = (await res.json()) as HostingSiteResource;
    return { kind: 'ok', site };
  }
  const text = await res.text().catch(() => '');
  if (res.status === 409) {
    return { kind: 'already_exists', siteId: input.siteId };
  }
  if (res.status === 400) {
    return { kind: 'invalid_id', siteId: input.siteId, message: text || 'invalid site id' };
  }
  if (res.status === 403) {
    return {
      kind: 'permission_denied',
      message: `Hosting denied site creation — service account needs roles/firebasehosting.admin: ${text}`,
    };
  }
  return { kind: 'http_error', status: res.status, body: text };
}

/**
 * Convenience wrapper: create-or-get-existing. Treats `already_exists`
 * as success, returning the existing site's name. Useful for
 * idempotent deploy scripts that want "ensure this site is
 * provisioned" rather than "create exactly once".
 */
export async function ensureHostingSite(
  input: CreateHostingSiteInput,
): Promise<EnsureSiteResult> {
  const result = await createHostingSite(input);
  if (result.kind === 'ok') {
    return { kind: 'created', siteId: input.siteId, site: result.site };
  }
  if (result.kind === 'already_exists') {
    return { kind: 'existed', siteId: input.siteId };
  }
  return result;
}

export type EnsureSiteResult =
  | { kind: 'created'; siteId: string; site: HostingSiteResource }
  | { kind: 'existed'; siteId: string }
  | Exclude<CreateSiteResult, { kind: 'ok' } | { kind: 'already_exists' }>;
