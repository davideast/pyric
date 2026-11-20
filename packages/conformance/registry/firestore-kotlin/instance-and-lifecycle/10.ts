import { row } from './section.ts';

export default row({
  order: 100,
  api: 'FirebaseFirestore.enableNetwork() / disableNetwork()',
  behavior: 'Toggles client network connectivity to simulate offline operation.',
  featureKeys: ['enableNetwork', 'disableNetwork'],
});
