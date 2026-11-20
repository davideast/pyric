import { row } from './section.ts';

export default row({
  order: 150,
  api: 'Firestore.enableNetwork() / disableNetwork()',
  behavior: 'Toggles client network connectivity to simulate offline and online operation.',
  featureKeys: ['enableNetwork', 'disableNetwork'],
});
