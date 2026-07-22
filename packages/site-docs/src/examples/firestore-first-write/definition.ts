import { definePyricExample } from '../definition';
import { run } from './run';

export default definePyricExample({
  header: 'Write to an isolated Firestore sandbox',
  subLabel: 'Cloud Firestore · Browser sandbox',
  summary: 'Run a Firestore write and read without starting a SharedWorker or touching another example.',
  docsPath: '/docs/build/cloud-firestore/',
  service: 'firestore',
  firestore: {
    rules: `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow read, write: if request.auth.uid == resource.data.ownerId
        || request.auth.uid == request.resource.data.ownerId;
    }
  }
}`,
  },
  run,
});
