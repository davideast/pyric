import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Database.database()',
  behavior: 'Returns the default Database instance bound to the active bridge connection.',
  featureKeys: ['database'],
});
