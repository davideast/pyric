// Run as `pyric sandbox -- node probe.mjs`. The only credential on the machine
// is the placeholder authorized_user file that GOOGLE_APPLICATION_CREDENTIALS
// names, the kind gcloud's application-default login writes. Each call asks
// for a server-side Google access token, or for a host that must still pass.
import { GoogleAuth } from 'google-auth-library';
import * as gcpMetadata from 'gcp-metadata';
import { outcomeOf, report } from './outcome.mjs';

const results = {};

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
results.getAccessToken = await auth.getAccessToken().then(() => 'token', outcomeOf);

results.isAvailable = await gcpMetadata.isAvailable();
results.instance = await gcpMetadata.instance().then(() => 'answered', outcomeOf);

const fontsUrl = new URL('https://fonts.googleapis.com/css2?family=Roboto');
results.fonts = await fetch(fontsUrl, { signal: AbortSignal.timeout(10_000) }).then(() => 'answered', outcomeOf);

report('credentials', results);
