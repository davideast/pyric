// Runs firestore_discover_paths from the published @pyric/cli/discover entry
// over a sandbox whose documents have fields named like Object.prototype
// members, and prints the result as JSON.
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { createFirestoreDiscoverTools, LocalEnvironmentCrawlerAdapter } from '@pyric/cli/discover';

const env = new LocalEnvironment();
env.seed({
  rules: "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }",
  documents: {
    'classes/a': { name: 'Point', constructor: 'new Point(x, y)', profile: { title: 'a' } },
    'classes/b': { name: 'Line', toString: 'line', profile: { hasOwnProperty: 'yes', valueOf: 2 } },
  },
});

const tools = createFirestoreDiscoverTools({ resolveDb: () => new LocalEnvironmentCrawlerAdapter(env) });
const discover = tools.find((tool) => tool.name === 'firestore_discover_paths');
const result = await discover.execute({}, { signal: new AbortController().signal });
// One collection, so one template path.
const schema = result.ok ? Object.values(result.data.schemas)[0]?.schema : undefined;
const profile = schema?.fields.profile?.types.find((type) => type.kind === 'map');
console.log(JSON.stringify({
  ok: result.ok,
  summary: result.summary,
  topLevel: schema ? Object.keys(schema.fields).sort() : null,
  profile: profile ? Object.keys(profile.fields).sort() : null,
}));
