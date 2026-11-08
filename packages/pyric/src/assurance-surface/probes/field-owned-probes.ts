/**
 * Probes for records owned through a field (`foreign-update`, `owner-transfer`,
 * `foreign-delete`, `owner-forge-create`).
 */
import type { AccessSite, PayloadShape } from '../code/types.js';
import { covers, parseTemplate } from '../rules/templates.js';
import { attributionFields, concretePath, concretePayload } from './fixtures.js';
import type { PlanInput } from './plan.js';
import { fieldOf, recordsAt, type StateRecord } from './state.js';
import { isCleanup, probeable, recordPath, same, sep, type MakeStep } from './step-builder.js';
import type { Probe, ProbeActor, ProbeStep } from './types.js';

export function planFieldOwned(
  site: AccessSite,
  fields: string[],
  status: 'proven' | 'flagged',
  input: PlanInput,
  actors: { owner: ProbeActor; peer: ProbeActor },
  step: MakeStep,
  seeds: (s: AccessSite, concrete: string) => ProbeStep[],
  add: (p: Omit<Probe, 'id'>) => void,
  byName = false,
): void {
  const { owner, peer } = actors;
  const seedBoth = [
    ...seeds(site, concretePath(site, owner, { state: input.state, otherUid: peer.uid })),
    ...seeds(site, concretePath(site, peer, { state: input.state, otherUid: owner.uid })),
  ];
  const ownerMark = byName ? owner.displayName : owner.uid;
  const keepOwner = Object.fromEntries(fields.map((f) => [f, ownerMark]));
  // Prefer the owner's real record from the seed (for a name-signed record: one not signed by the peer);
  // otherwise the owner creates one with the client's own write.
  const records = recordsAt(site.service, site.path, input.state);
  let existing: StateRecord | undefined;
  if (byName) {
    existing = records.find((r) =>
      fields.every((f) => typeof fieldOf(r.data, f, sep(site)) === 'string' && fieldOf(r.data, f, sep(site)) !== peer.displayName),
    );
  } else {
    existing = records.find((r) => fields.some((f) => fieldOf(r.data, f, sep(site)) === owner.uid));
  }
  const created = step(site, 'owner');
  const path = existing?.path ?? recordPath(created);
  const create: ProbeStep[] = existing ? [] : [created];
  const contentField = editableField(site.payload, fields);
  // An edit the client really makes: an update at this record that writes content, not just a counter.
  const updateSite = input.sites.find(
    (s) => probeable(s) && same(s, site) && (s.op === 'update' || s.op === 'updateDoc') && s !== site && editsContent(s.payload, fields),
  );
  // Without one, edit a written field only where the rules themselves guard updates by owner.
  const rulesGuardUpdate = input.bindings.some(
    (b) => b.service === site.service && covers(parseTemplate(b.path), parseTemplate(site.path), false) && (b.ops ?? []).some((o) => o === 'update' || o === 'write'),
  );
  let editData: Record<string, unknown> | undefined;
  let ownerEdit: Record<string, unknown> | undefined;
  // Counters an update must carry along (`reactions + 1` with any other change).
  const rideAlong = Object.fromEntries(
    input.sites
      .filter((s) => probeable(s) && same(s, site))
      .flatMap((s) => (s.payload?.fields ?? []).filter((f) => f.kind === 'increment').map((f) => [f.name, { __sentinel: 'increment', by: 1 }])),
  );
  if (updateSite?.payload) {
    const keepInUpdate = Object.fromEntries(
      Object.entries(keepOwner).filter(([k]) => updateSite.payload!.fields.some((x) => x.name === k)),
    );
    editData = concretePayload(contentOnly(updateSite.payload), peer, sep(site), keepInUpdate) as Record<string, unknown>;
    ownerEdit = concretePayload(contentOnly(updateSite.payload), owner, sep(site), keepInUpdate) as Record<string, unknown>;
  } else if (contentField) {
    editData = { [contentField]: 'tampered', ...rideAlong };
    if (rulesGuardUpdate) ownerEdit = { [contentField]: 'edited' };
  }
  const fieldList = fields.join(', ');

  // The owner's own edit runs first when the client makes one; it is a control, not a precondition for the record.
  const ownerControl: ProbeStep[] = [];
  if (ownerEdit) {
    ownerControl.push({ actor: 'owner', service: site.service, method: 'update', path, data: ownerEdit });
  }
  if (editData && typeof editData === 'object') {
    add({
      kind: 'foreign-update',
      op: 'update',
      service: site.service,
      template: site.path,
      status,
      seed: seedBoth,
      setup: [...create, ...ownerControl],
      attack: { actor: 'peer', service: site.service, method: 'update', path, data: editData },
      expect: 'deny',
      evidence: `${peer.uid} edited ${owner.uid}'s record (owned through ${fieldList}; client write ${site.source})`,
      sources: [site.source],
    });
  }
  const topLevelOwnerFields = fields.filter((f) => !f.includes('/') && !f.includes('.'));
  if (!byName && topLevelOwnerFields.length > 0 && (updateSite || ownerEdit)) {
    const transfer = Object.fromEntries(topLevelOwnerFields.map((f) => [f, peer.uid]));
    add({
      kind: 'owner-transfer',
      op: 'update',
      service: site.service,
      template: site.path,
      status,
      seed: seedBoth,
      setup: [...create, ...ownerControl],
      attack: { actor: 'owner', service: site.service, method: 'update', path, data: transfer },
      expect: 'deny',
      evidence: `${owner.uid} set ${topLevelOwnerFields.join(', ')} to ${peer.uid} on their record (client write ${site.source})`,
      sources: [site.source],
    });
  }

  const deleteSite = input.sites.find((s) => probeable(s) && same(s, site) && isCleanup(s));
  const rulesGuardDelete = input.bindings.some(
    (b) => b.service === site.service && covers(parseTemplate(b.path), parseTemplate(site.path), false) && (b.ops ?? []).some((o) => o === 'delete' || o === 'write'),
  );
  const isCollectionItem = parseTemplate(site.path).at(-1)?.kind === 'var';
  if (deleteSite || rulesGuardDelete || byName || (!byName && fields.length > 0 && isCollectionItem)) {
    const own2 = step(site, 'owner', { variant: '-own' });
    const deleteMethod = site.service === 'firestore' ? 'delete' : 'remove';
    const del = (actor: 'owner' | 'peer', p: string): ProbeStep => ({ actor, service: site.service, method: deleteMethod, path: p });
    // The owner deleting a second record of their own is the control; a template with one record has no second.
    const hasVars = parseTemplate(site.path).some((x) => x.kind !== 'lit');
    const control: ProbeStep[] = [];
    if (deleteSite && hasVars) {
      control.push(own2, del('owner', recordPath(own2)));
    }
    const deleteSources = [site.source];
    if (deleteSite) deleteSources.push(deleteSite.source);
    add({
      kind: 'foreign-delete',
      op: 'delete',
      service: site.service,
      template: site.path,
      status,
      seed: seedBoth,
      setup: [...create, ...control],
      attack: del('peer', path),
      expect: 'deny',
      evidence: `${peer.uid} deleted ${owner.uid}'s record (owned through ${fieldList}; client write ${site.source})`,
      sources: deleteSources,
    });
  }

  if (byName) return;
  const peerOwn = step(site, 'peer', { variant: '-peer' });
  const forged = step(site, 'peer', { variant: '-forged', overrides: keepOwner });
  add({
    kind: 'owner-forge-create',
    op: 'create',
    service: site.service,
    template: site.path,
    status,
    seed: seedBoth,
    setup: [peerOwn],
    attack: forged,
    expect: 'deny',
    evidence: `${peer.uid} created a record with ${fieldList} = ${owner.uid} (client write ${site.source})`,
    sources: [site.source],
  });
}

/** True when an update writes something other than owner fields and counters. */
export function editsContent(shape: PayloadShape | undefined, ownerFields: string[]): boolean {
  return (shape?.fields ?? []).some((f) => !f.optional && f.kind !== 'increment' && !ownerFields.includes(f.name) && !f.auth?.length);
}

/** An update shape without its counter fields (those are probed by counter-integrity). */
export function contentOnly(shape: PayloadShape): PayloadShape {
  return { ...shape, fields: shape.fields.filter((f) => f.kind !== 'increment') };
}

/** A field the owner might edit: a written string that is not an owner, attribution, or counter field. */
export function editableField(shape: PayloadShape | undefined, ownerFields: string[]): string | undefined {
  const attribution = new Set(attributionFields(shape));
  return shape?.fields.find(
    (f) =>
      !f.optional &&
      f.kind === 'string' &&
      !ownerFields.includes(f.name) &&
      !attribution.has(f.name) &&
      !f.auth?.length &&
      f.literal === undefined &&
      !/[/.]/.test(f.name),
  )?.name;
}
