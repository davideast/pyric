import { Children, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'bun:test';
import type { DocumentReference } from 'pyric/firestore';
import type { FirestoreApi } from '@pyric/ui/firestore';
import type { RecursiveDeleteImpl } from '@pyric/ui/firestore/hooks';
import type { ConfirmFn, ConfirmOptions } from '@pyric/ui/primitives';
import { confirmDocumentDelete } from '../../../src/features/data/document-delete.js';

const ref = { id: 'parent', path: 'things/parent' } as DocumentReference;

function harness(confirm: ConfirmFn) {
  const calls: string[] = [];
  const api = {
    deleteDoc: async (target: DocumentReference) => {
      calls.push(`plain:${target.path}`);
    },
  } as FirestoreApi;
  const recursiveImpl: RecursiveDeleteImpl = {
    async *start(target) {
      calls.push(`recursive:${target.path}`);
      yield { deletedCount: 1, done: true };
    },
  };
  return {
    calls,
    run: () => confirmDocumentDelete({ confirm, ref, api, recursiveImpl }),
  };
}

describe('confirmDocumentDelete', () => {
  it('opens a modal and preserves subcollections by default', async () => {
    let options: ConfirmOptions | undefined;
    const subject = harness(async (next) => {
      options = next;
      return true;
    });

    expect(await subject.run()).toBe(true);
    expect(options?.title).toBe('Delete document "parent"?');
    expect(options?.body).toBeDefined();
    expect(subject.calls).toEqual(['plain:things/parent']);
  });

  it('recursively deletes only after the modal checkbox is enabled', async () => {
    const subject = harness(async (options) => {
      const label = options.body as ReactElement<{ children: unknown }>;
      const input = Children.toArray(label.props.children as ReactNode)[0] as ReactElement<{
        onChange: (event: { currentTarget: { checked: boolean } }) => void;
      }>;
      input.props.onChange({ currentTarget: { checked: true } });
      return true;
    });

    expect(await subject.run()).toBe(true);
    expect(subject.calls).toEqual(['recursive:things/parent']);
  });

  it('does nothing when the modal is cancelled', async () => {
    const subject = harness(async () => false);
    expect(await subject.run()).toBe(false);
    expect(subject.calls).toEqual([]);
  });
});
