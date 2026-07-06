/**
 * Server-side equivalent of the "Fetch from project" button in the
 * Deploy tab. Hits the Firebase Management REST API with the SA
 * bearer to retrieve the project's default web app config — what
 * gets pasted into the template's `generated/firebase-config.ts`
 * at deploy time.
 *
 * Two-step: list web apps for the project, then fetch the config
 * for the first one. If no web apps exist yet, throws — the user
 * needs to create one in the Firebase Console (Project Settings →
 * Your apps → Add app → Web).
 */

export interface WebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
}

export async function fetchWebConfig(projectId: string, token: string): Promise<WebConfig> {
  const listUrl = `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    const body = await listRes.text();
    throw new Error(
      `Failed to list web apps for ${projectId} (${listRes.status}): ${body}`,
    );
  }
  const list = (await listRes.json()) as { apps?: Array<{ appId: string; name: string }> };
  const apps = list.apps ?? [];
  if (apps.length === 0) {
    throw new Error(
      `Project ${projectId} has no web apps. Create one: Firebase Console → ` +
        `Project Settings → Your apps → Add app → Web.`,
    );
  }
  const appId = apps[0].appId;
  const configUrl = `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps/${appId}/config`;
  const configRes = await fetch(configUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!configRes.ok) {
    const body = await configRes.text();
    throw new Error(
      `Failed to fetch config for web app ${appId} (${configRes.status}): ${body}`,
    );
  }
  return (await configRes.json()) as WebConfig;
}
