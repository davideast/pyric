import { row } from './section.ts';

export default row({
  order: 60,
  api: 'QuerySnapshot.documents / documentChanges',
  behavior: 'Provides ordered List<DocumentSnapshot> and List<DocumentChange> detailing change types.',
  featureKeys: ['documents', 'documentChanges'],
  flipped: 'unit-backed',
});
