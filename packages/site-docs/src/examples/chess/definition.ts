import { definePyricExample } from '../definition';

export default definePyricExample({
  header: 'Play chess against Security Rules',
  subLabel: 'Firestore Security Rules · Isolated browser sandbox',
  summary: 'Move a piece; Pyric commits the new board or denies the write.',
  docsPath: '/docs/examples/chess/',
  service: 'firestore',
  presentation: 'showcase',
  renderer: 'chess',
});
