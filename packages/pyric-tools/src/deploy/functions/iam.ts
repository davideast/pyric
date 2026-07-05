/**
 * Cloud Run IAM helper. Cloud Functions Gen 2 deploys an underlying
 * Cloud Run service whose service name matches the function id —
 * granting public invoke means binding `roles/run.invoker` to
 * `allUsers` on that service.
 *
 * SET semantics over GET-modify-SET on purpose: a fresh function
 * deploy starts with the default policy, and an SDK-deployed
 * function isn't expected to have other bindings the caller would
 * mind being replaced. If that changes, switch to GET-then-PATCH
 * with the etag.
 */
const RUN_API = 'https://run.googleapis.com/v2';

export type IamGrantResult =
  | { kind: 'ok' }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'network_error'; message: string };

export async function grantPublicInvoker(input: {
  projectId: string;
  region: string;
  serviceId: string;
  accessToken: string;
}): Promise<IamGrantResult> {
  const url = `${RUN_API}/projects/${input.projectId}/locations/${input.region}/services/${encodeURIComponent(input.serviceId)}:setIamPolicy`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        policy: {
          bindings: [
            { role: 'roles/run.invoker', members: ['allUsers'] },
          ],
        },
      }),
    });
    if (res.ok) return { kind: 'ok' };
    const body = await res.text().catch(() => '');
    return { kind: 'http_error', status: res.status, body };
  } catch (e) {
    return { kind: 'network_error', message: e instanceof Error ? e.message : String(e) };
  }
}
