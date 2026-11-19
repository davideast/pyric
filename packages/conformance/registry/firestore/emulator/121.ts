import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "The sandbox mirror accepts Firebase's `mockUserToken` option shape as an inert compatibility argument; production uses Firebase's untouched implementation",
  evidence: "type-only smoke",
  automation: "type-backed",
  exceptionReason: "structural / type shape — verified without a prod observation",
});
