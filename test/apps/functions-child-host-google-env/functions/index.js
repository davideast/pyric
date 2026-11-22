// Records the Google variables and ADC file reachability the Functions child
// loads this module with, the way a Google client library other than
// firebase-admin would read them.
const fs = require('node:fs');
const path = require('node:path');

const names = [
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'GCP_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'google_application_credentials',
  'FIREBASE_SA_BASE64',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'HOME',
  'CLOUDSDK_CONFIG',
];
const seen = {};
for (const name of names) seen[name] = process.env[name] ?? null;

const homeAdcPath = process.env.HOME
  ? path.join(process.env.HOME, '.config', 'gcloud', 'application_default_credentials.json')
  : null;
const cloudsdkAdcPath = process.env.CLOUDSDK_CONFIG
  ? path.join(process.env.CLOUDSDK_CONFIG, 'application_default_credentials.json')
  : null;
seen.homeAdcExists = homeAdcPath ? fs.existsSync(homeAdcPath) : false;
seen.cloudsdkAdcExists = cloudsdkAdcPath ? fs.existsSync(cloudsdkAdcPath) : false;

fs.writeFileSync(path.join(__dirname, '..', 'child-env.json'), JSON.stringify(seen, null, 2));

module.exports = {};
