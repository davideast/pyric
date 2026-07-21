import { definePyricExample } from '../definition';

export default definePyricExample({
  title: 'Chess, with Security Rules as the game engine',
  description: 'Move a piece. The application proposes the document; Pyric decides whether the Rules allow it.',
  docsPath: '/docs/examples/chess/',
  service: 'firestore',
  presentation: 'showcase',
  renderer: 'chess',
});
