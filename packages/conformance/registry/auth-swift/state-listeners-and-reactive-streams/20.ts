import { row } from './section.ts';

export default row({
  order: 70,
  flipped: 'unit-backed',
  api: 'Auth.idTokenDidChangeStream',
  behavior: 'Provides an AsyncStream of User? updates emitted on ID token changes or refreshes.',
  featureKeys: ['idTokenStream'],
});
