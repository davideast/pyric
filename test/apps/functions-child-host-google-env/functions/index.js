// Records the Google variables the Functions child loads this module with, the
// way a Google client library other than firebase-admin would read them.
const fs = require('node:fs');
const path = require('node:path');

const names = ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS'];
const seen = {};
for (const name of names) seen[name] = process.env[name] ?? null;
fs.writeFileSync(path.join(__dirname, '..', 'child-env.json'), JSON.stringify(seen, null, 2));

module.exports = {};
