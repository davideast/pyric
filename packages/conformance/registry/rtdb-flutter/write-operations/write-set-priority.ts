import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DatabaseReference.setPriority(priority)',
  behavior: 'Updates the ordering priority metadata of the node without altering its value.',
  featureKeys: ['setPriority'],
});
