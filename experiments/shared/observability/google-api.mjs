import { readFile } from 'node:fs/promises';
import { applicationDefault, cert } from 'firebase-admin/app';

// Credentials stay at this boundary. Reports never contain tokens or key files.
export async function googleApi({ project, credentials, fetchImpl = fetch }) {
    let identity = 'application-default-credentials';
    let credential;
    if (credentials) {
        const key = JSON.parse(await readFile(credentials, 'utf8'));
        if (key.type !== 'service_account') throw new Error('Expected a service-account credential file');
        identity = `serviceAccount:${key.client_email}`;
        credential = cert(key);
    } else {
        credential = applicationDefault();
        const { access_token: token } = await credential.getAccessToken();
        identity = await identifyAccessToken(token, fetchImpl);
    }
    return {
        identity,
        async request(method, url, body, { timeoutMs = 20000 } = {}) {
            const { access_token: token } = await credential.getAccessToken();
            const response = await fetchImpl(url, {
                method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-goog-user-project': project },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const text = await response.text();
            if (!response.ok) {
                // Do not serialise SDK errors: they can contain request credentials.
                const error = Object.assign(new Error(`Google API returned HTTP ${response.status} for ${method} ${new URL(url).pathname}`), { status: response.status });
                throw error;
            }
            return text ? JSON.parse(text) : {};
        },
    };
}

// Match Google's OAuth client: the token is sent in a header, never in a URL.
export async function identifyAccessToken(token, fetchImpl = fetch) {
    try {
        const response = await fetchImpl('https://oauth2.googleapis.com/tokeninfo', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        });
        if (!response.ok) return 'unresolved-application-default-credentials';
        const { email } = await response.json();
        if (typeof email !== 'string' || !/^[^\s/:]+@[^\s/:]+$/.test(email)) return 'unresolved-application-default-credentials';
        const kind = email.endsWith('.gserviceaccount.com') ? 'serviceAccount' : 'user';
        return `${kind}:${email}`;
    } catch {
        return 'unresolved-application-default-credentials';
    }
}
