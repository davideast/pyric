/** Public RTDB data operations observed by the modular adapters. */
export const databaseActivityCoverage = {
  service: 'rtdb',
  read: ['get'],
  write: ['set', 'update', 'remove', 'push', 'setPriority', 'setWithPriority', 'runTransaction'],
  listener: ['onValue', 'onChildAdded', 'onChildChanged', 'onChildRemoved', 'onChildMoved'],
  // Scheduling server work is a distinct surface; neither scheduling nor its
  // later server execution may be silently reported as an observed client write.
  untrackedMethods: ['onDisconnect'],
} as const;
