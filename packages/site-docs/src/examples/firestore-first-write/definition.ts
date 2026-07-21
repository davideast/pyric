import { definePyricExample } from '../definition';
import { run } from './run';

export default definePyricExample({
  title: 'Write to an isolated Firestore sandbox',
  description: 'Run a Firestore write and read without starting a SharedWorker or touching another example.',
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
