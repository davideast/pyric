/**
 * The prompt producer (AI-as-flow, Phase 2): a command-spine prompt runs a real
 * agent whose Firestore write-tools target the staged COPY, so the change lands
 * as an open proposal you review before it applies. This replaces the Phase-1
 * deterministic "Stage a change" button.
 *
 * The agent is the existing `runAssist` harness with a set of Firestore tools
 * bound to the branch's admin handle. Because the tools write to the fork (not
 * live), the whole run is safe; `stage()` holds the result for review.
 */

import { useCallback } from 'react';
import type { ToolHandler, ToolResult } from '@inbrowser/agent';
import {
  collection,
  query,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  type Firestore,
} from 'pyric/firestore';
import { sandbox as authSandbox, getAuth, type CreateUserRequest } from 'pyric/auth';
import { runAssist } from '../../ai/useAssist.js';
import { useLlmClient } from '../../ai/inference.js';
import { useProposals, useGovernanceMode, focusProposal } from './proposals.js';
import type { AuthCreateOp } from '../../shell/studio-data.js';

const AGENT_SYSTEM = [
  'You make a requested change to a Firebase project using the tools provided.',
  '',
  'Firestore is a NoSQL document store, NOT a relational table:',
  '- Change specific documents with update_document (merge fields) or set_document (overwrite),',
  '  add new documents, or delete documents.',
  '- To change many documents, first call list_documents to find the right ones, then update each.',
  '- Do NOT add a field to every document unless the request explicitly asks for exactly that.',
  '',
  'Authentication users are SEPARATE from Firestore documents. Use create_user to create a',
  'sign-in account; it returns the uid. If asked to seed auth users AND store their profile in',
  'Firestore, create each auth user with create_user, then write a corresponding document keyed',
  'by the returned uid (e.g. set_document at "users/<uid>").',
  '',
  'You are operating on a COPY of the project that the user will review before it lands, so make',
  'the concrete changes now (do not just describe them). When finished, state briefly what you changed.',
].join('\n');

/** Does a snapshot exist? `.exists` is a method on one backend, a getter on the other. */
function snapExists(snap: unknown): boolean {
  const e = (snap as { exists: boolean | (() => boolean) }).exists;
  return typeof e === 'function' ? e.call(snap) : e;
}

/** Firestore tools bound to one (branch) handle: the agent reads + writes the copy. */
function makeFirestoreTools(db: Firestore): ToolHandler[] {
  return [
    {
      name: 'list_documents',
      description: 'List the documents in a collection (ids + fields) so you can decide which to change.',
      parameters: {
        type: 'object',
        properties: { collection: { type: 'string', description: 'Collection id, e.g. "notes".' } },
        required: ['collection'],
      },
      async execute(args): Promise<ToolResult> {
        const id = (args as { collection?: string }).collection;
        if (!id) return { ok: false, summary: 'No collection given.' };
        const snap = await getDocs(query(collection(db, id)));
        const documents = snap.docs.map((d) => ({ path: `${id}/${d.id}`, data: d.data() }));
        return { ok: true, summary: `${documents.length} document(s) in ${id}.`, data: { documents } };
      },
    },
    {
      name: 'get_document',
      description: 'Read one document by path ("collection/docId").',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'collection/docId' } },
        required: ['path'],
      },
      async execute(args): Promise<ToolResult> {
        const path = (args as { path?: string }).path;
        if (!path) return { ok: false, summary: 'No path given.' };
        const snap = await getDoc(doc(db, path));
        const exists = snapExists(snap);
        return {
          ok: true,
          summary: exists ? `Read ${path}.` : `${path} does not exist.`,
          data: { path, exists, data: exists ? snap.data() : null },
        };
      },
    },
    {
      name: 'set_document',
      description: 'Create or overwrite a document at path with the given fields.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'collection/docId' },
          data: { type: 'object', description: 'The full document fields.' },
        },
        required: ['path', 'data'],
      },
      async execute(args): Promise<ToolResult> {
        const { path, data } = args as { path?: string; data?: Record<string, unknown> };
        if (!path || data == null || typeof data !== 'object') {
          return { ok: false, summary: 'Need a path and a data object.' };
        }
        await setDoc(doc(db, path), data);
        return { ok: true, summary: `Set ${path}.` };
      },
    },
    {
      name: 'update_document',
      description: 'Merge fields into an existing document (other fields unchanged).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'collection/docId' },
          fields: { type: 'object', description: 'Fields to merge.' },
        },
        required: ['path', 'fields'],
      },
      async execute(args): Promise<ToolResult> {
        const { path, fields } = args as { path?: string; fields?: Record<string, unknown> };
        if (!path || fields == null || typeof fields !== 'object') {
          return { ok: false, summary: 'Need a path and a fields object.' };
        }
        await updateDoc(doc(db, path), fields);
        return { ok: true, summary: `Updated ${path}.` };
      },
    },
    {
      name: 'delete_document',
      description: 'Delete a document by path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'collection/docId' } },
        required: ['path'],
      },
      async execute(args): Promise<ToolResult> {
        const path = (args as { path?: string }).path;
        if (!path) return { ok: false, summary: 'No path given.' };
        await deleteDoc(doc(db, path));
        return { ok: true, summary: `Deleted ${path}.` };
      },
    },
  ];
}

/** Auth tools bound to one (branch) auth handle: create users on the fork and
 *  record each op so the proposal can replay it onto live at apply. */
function makeAuthTools(
  branchAuth: ReturnType<typeof getAuth>,
  record: (op: AuthCreateOp) => void,
): ToolHandler[] {
  return [
    {
      name: 'create_user',
      description:
        'Create a Firebase Authentication user (a sign-in account), separate from Firestore documents. Returns the uid.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email (required if a password is set).' },
          password: { type: 'string' },
          uid: { type: 'string', description: 'Optional; auto-assigned if omitted.' },
          displayName: { type: 'string' },
          photoUrl: { type: 'string' },
          emailVerified: { type: 'boolean' },
        },
      },
      async execute(args): Promise<ToolResult> {
        const request = args as CreateUserRequest;
        try {
          const rec = authSandbox.createUser(branchAuth, request);
          // Record with the RESOLVED uid so apply recreates the same user (and any
          // Firestore docs keyed by that uid line up).
          record({ request: { ...request, uid: rec.uid } });
          return {
            ok: true,
            summary: `Created auth user ${rec.uid}${request.email ? ` (${request.email})` : ''}.`,
            data: { uid: rec.uid },
          };
        } catch (e) {
          return { ok: false, summary: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}

export interface PromptStaging {
  /** Run a prompt: the agent stages its writes on a copy, then it goes to review
   *  (or applies directly, per the governance mode). Throws if no model key. */
  run: (prompt: string) => Promise<void>;
  /** True when the active provider has no API key (the run can't start). */
  missingKey: boolean;
}

export function usePromptStaging(): PromptStaging {
  const { client, missingKey } = useLlmClient();
  const { stage, apply } = useProposals();
  const { mode } = useGovernanceMode();

  const run = useCallback(
    async (prompt: string) => {
      if (!client) {
        throw new Error('No model key set. Add one in Settings (the gear) to make AI changes.');
      }
      const proposal = await stage({
        title: prompt,
        actor: 'agent:studio',
        plan: async (db, _base, branch) => {
          const authOps: AuthCreateOp[] = [];
          const tools = [
            ...makeFirestoreTools(db),
            ...makeAuthTools(getAuth(branch.sandbox), (op) => authOps.push(op)),
          ];
          const result = await runAssist(
            { llm: client, tools, systemPrompt: AGENT_SYSTEM },
            prompt,
            () => {},
          ).done;
          if (result.status === 'error') {
            throw new Error(result.error ?? 'The agent could not complete the change.');
          }
          return { authOps };
        },
      });
      if (mode === 'direct') {
        await apply(proposal.id);
        if (typeof window !== 'undefined') window.location.hash = 'session';
      } else {
        focusProposal(proposal.id);
        if (typeof window !== 'undefined') window.location.hash = 'review';
      }
    },
    [client, stage, apply, mode],
  );

  return { run, missingKey };
}
