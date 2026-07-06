/**
 * The coffee-shop worked example from plans/app-spec.md §3 — the
 * hardest fixture (crossDoc price-match) — as a full AppSpecV1, plus a
 * known-good and a deliberately over-permissive ruleset for the
 * round-trip pin (derive.roundtrip.test.ts).
 *
 * Test fixture module: imported by spec tests only.
 */
import type { AppSpecV1 } from './schema';

export const COFFEE_SHOP_SPEC: AppSpecV1 = {
  meta: {
    title: 'Coffee shop ordering',
    assumptions: [
      'Anyone can browse the menu without signing in.',
      'Only staff with the admin claim manage menu items.',
      'Customers create their own orders; the price must match the menu.',
      'Order status moves placed → ready → pickedUp; nobody deletes orders.',
    ],
  },
  identities: [
    { uid: 'alice', description: 'a signed-in customer' },
    { uid: 'bob', description: 'another signed-in customer' },
    { uid: 'cara', description: 'a barista', claims: { admin: true } },
  ],
  collections: [
    {
      path: 'menuItems/{itemId}',
      description: 'The menu',
      fields: [
        { name: 'name', type: 'string', required: true },
        { name: 'price', type: 'double', required: true },
      ],
    },
    {
      path: 'orders/{orderId}',
      description: 'Customer orders',
      ownerField: 'userId',
      fields: [
        { name: 'userId', type: 'string', required: true },
        { name: 'itemId', type: 'string', required: true },
        { name: 'price', type: 'double', required: true },
        { name: 'qty', type: 'integer', required: true },
        {
          name: 'status',
          type: 'string',
          enum: ['placed', 'ready', 'pickedUp'],
          transitions: { placed: ['ready'], ready: ['pickedUp'] },
        },
      ],
    },
  ],
  access: [
    { collection: 'menuItems/{itemId}', op: 'get', grant: [] },
    { collection: 'menuItems/{itemId}', op: 'list', grant: [] },
    {
      collection: 'menuItems/{itemId}',
      op: 'create',
      grant: [
        { kind: 'authenticated' },
        { kind: 'claim', name: 'admin', equals: true },
        { kind: 'requiredFields', fields: ['name', 'price'] },
      ],
    },
    {
      collection: 'menuItems/{itemId}',
      op: 'update',
      grant: [{ kind: 'authenticated' }, { kind: 'claim', name: 'admin', equals: true }],
    },
    {
      collection: 'menuItems/{itemId}',
      op: 'delete',
      grant: [{ kind: 'authenticated' }, { kind: 'claim', name: 'admin', equals: true }],
    },
    // The plan's worked example, verbatim shape:
    {
      collection: 'orders/{orderId}',
      op: 'create',
      grant: [
        { kind: 'authenticated' },
        { kind: 'owner' },
        { kind: 'requiredFields', fields: ['userId', 'itemId', 'price', 'qty'] },
        {
          kind: 'crossDoc',
          collection: 'menuItems',
          docIdFrom: 'itemId',
          remoteField: 'price',
          localField: 'price',
        },
      ],
    },
    {
      collection: 'orders/{orderId}',
      op: 'get',
      grant: [{ kind: 'authenticated' }, { kind: 'owner' }],
    },
    {
      collection: 'orders/{orderId}',
      op: 'list',
      grant: [{ kind: 'authenticated' }, { kind: 'owner' }], // owner degrades to authenticated on list
    },
    {
      collection: 'orders/{orderId}',
      op: 'update',
      grant: [
        { kind: 'authenticated' },
        { kind: 'owner' },
        { kind: 'fieldImmutable', field: 'itemId' },
        { kind: 'enumTransition', field: 'status' },
      ],
    },
    { collection: 'orders/{orderId}', op: 'delete', grant: 'deny' },
  ],
};

/** A ruleset that faithfully implements the matrix — every derived case
 *  must hold against it. */
export const COFFEE_SHOP_GOOD_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /menuItems/{itemId} {
      allow get, list: if true;
      allow create: if request.auth != null
        && request.auth.token.admin == true
        && request.resource.data.keys().hasAll(['name', 'price']);
      allow update, delete: if request.auth != null
        && request.auth.token.admin == true;
    }
    match /orders/{orderId} {
      allow get: if request.auth != null
        && request.auth.uid == resource.data.userId;
      allow list: if request.auth != null;
      allow create: if request.auth != null
        && request.auth.uid == request.resource.data.userId
        && request.resource.data.keys().hasAll(['userId', 'itemId', 'price', 'qty'])
        && request.resource.data.price
           == get(/databases/$(database)/documents/menuItems/$(request.resource.data.itemId)).data.price;
      allow update: if request.auth != null
        && request.auth.uid == resource.data.userId
        && request.resource.data.itemId == resource.data.itemId
        && (request.resource.data.status == resource.data.status
            || (resource.data.status == 'placed' && request.resource.data.status == 'ready')
            || (resource.data.status == 'ready' && request.resource.data.status == 'pickedUp'));
    }
  }
}`;

/** Deliberately over-permissive: public reads, any signed-in user can
 *  write anything. Model-style ALLOW tests still pass — only the derived
 *  deny-by-default and violation cases expose it. */
export const COFFEE_SHOP_OVERPERMISSIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`;
