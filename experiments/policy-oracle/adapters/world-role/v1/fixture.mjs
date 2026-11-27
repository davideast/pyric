export const revision = 'b3bed5e36acaa7bfc47a600e86e015fb84b1ac70';
export const hashes = {
  app: '7caa3834574676c501f781e15705eb95dfc3be14a6f9c8791a4177817303df2d',
  mirror: '98118bd941acfb67b2e58bb0b5ff4cc9a640ff3ba31e329fc48759dbc9a9189d',
};
export const roles = ['absent', 'unlisted', 'listed'];
export const operations = ['event-delete', 'combat-update'];
export const configFor = (role, actor, owner) => role === 'absent' ? null : {admins: [role === 'listed' ? actor : owner]};
export const event = {kind: 'oracle-event', cycle: 1};
export const profile = {name: 'Oracle target', rep: 7, combat: {hp: 10}};
export const patch = {combat: {hp: 9}};
