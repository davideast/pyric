import { row } from './section.ts';

export default row({
  order: 10,
  api: 'PyricDatabase.instance',
  behavior: 'Returns the default Realtime Database instance bound to the active bridge connection.',
  featureKeys: ['instance'],
});
