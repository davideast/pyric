/**
 * Display-side prior-content capture — the chat store stamps
 * `priorContent` onto in-flight write_file/edit_file/delete_file calls the
 * moment they land (the UI-side tool_started boundary), sourced from
 * a session-local shadow fed by completed calls + the workspace
 * store's mirrored files.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { useChatStore, type ChatMessage, type ToolCall } from './chat';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { RULES_PATH } from '~/lib/store/files';

function asst(id: string): ChatMessage {
  return { id, role: 'assistant', text: '', createdAt: Date.now(), streaming: true };
}

function inflightWrite(id: string, path: string, content: string): ToolCall {
  return {
    id,
    name: 'write_file',
    argsJson: JSON.stringify({ path, content }),
    summary: 'write_file · running…',
  };
}

function inflightEdit(
  id: string,
  path: string,
  edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>,
): ToolCall {
  return {
    id,
    name: 'edit_file',
    argsJson: JSON.stringify({ path, edits }),
    summary: 'edit_file · running…',
  };
}

/** Mimic the session host: append the in-flight call via patchMessage. */
function startCall(messageId: string, call: ToolCall) {
  const s = useChatStore.getState();
  const msg = s.messages.find((m) => m.id === messageId)!;
  s.patchMessage(messageId, { toolCalls: [...(msg.toolCalls ?? []), call] });
}

function finishCall(
  messageId: string,
  callId: string,
  data: unknown,
  ok = true,
) {
  useChatStore.getState().patchToolCall(messageId, callId, {
    ok,
    resultJson: JSON.stringify(data),
  });
}

function getCall(messageId: string, callId: string): ToolCall {
  const msg = useChatStore.getState().messages.find((m) => m.id === messageId)!;
  return msg.toolCalls!.find((c) => c.id === callId)!;
}

beforeEach(() => {
  useChatStore.getState().clear(); // also clears the file shadow
  useWorkspaceStore.getState().setRules('');
  useWorkspaceStore.getState().setAppSource('');
});

describe('priorContent capture', () => {
  test('first write to an unknown path → no priorContent (full-source fallback)', () => {
    useChatStore.getState().appendMessage(asst('m1'));
    startCall('m1', inflightWrite('c1', '/workspace/src/util.ts', 'export {}'));
    expect(getCall('m1', 'c1').priorContent).toBeUndefined();
  });

  test('first write to the rules path falls back to the workspace store mirror', () => {
    useWorkspaceStore.getState().setRules('rules_version = "2"; // prior');
    useChatStore.getState().appendMessage(asst('m1'));
    startCall('m1', inflightWrite('c1', RULES_PATH, 'rules_version = "2"; // next'));
    expect(getCall('m1', 'c1').priorContent).toBe('rules_version = "2"; // prior');
  });

  test('second write to a path sees the first write as prior', () => {
    useChatStore.getState().appendMessage(asst('m1'));
    startCall('m1', inflightWrite('c1', '/workspace/src/A.tsx', 'v1'));
    finishCall('m1', 'c1', { path: '/workspace/src/A.tsx', replaced: false });

    startCall('m1', inflightWrite('c2', '/workspace/src/A.tsx', 'v2'));
    expect(getCall('m1', 'c2').priorContent).toBe('v1');
  });

  test('a failed write (broken modular rules) still updates the shadow — the VFS kept the broken source', () => {
    useChatStore.getState().appendMessage(asst('m1'));
    startCall('m1', inflightWrite('c1', RULES_PATH, 'broken-source'));
    finishCall('m1', 'c1', { path: RULES_PATH, replaced: true }, /* ok */ false);

    startCall('m1', inflightWrite('c2', RULES_PATH, 'fixed-source'));
    expect(getCall('m1', 'c2').priorContent).toBe('broken-source');
  });

  test('delete then re-create: prior is empty string after a confirmed delete', () => {
    useChatStore.getState().appendMessage(asst('m1'));
    startCall('m1', inflightWrite('c1', '/workspace/src/B.tsx', 'gone soon'));
    finishCall('m1', 'c1', { path: '/workspace/src/B.tsx', replaced: false });

    const del: ToolCall = {
      id: 'c2',
      name: 'delete_file',
      argsJson: JSON.stringify({ path: '/workspace/src/B.tsx' }),
    };
    startCall('m1', del);
    // The in-flight delete captured the current content as its prior.
    expect(getCall('m1', 'c2').priorContent).toBe('gone soon');
    finishCall('m1', 'c2', { path: '/workspace/src/B.tsx', deleted: true });

    startCall('m1', inflightWrite('c3', '/workspace/src/B.tsx', 'recreated'));
    expect(getCall('m1', 'c3').priorContent).toBe('');
  });

  test('successful edit_file updates the shadow; preflight failures do not', () => {
    useChatStore.getState().appendMessage(asst('m1'));
    startCall('m1', inflightWrite('c1', '/workspace/src/F.tsx', 'hello world'));
    finishCall('m1', 'c1', { path: '/workspace/src/F.tsx', replaced: false });

    startCall('m1', inflightEdit('c2', '/workspace/src/F.tsx', [{ oldText: 'world', newText: 'there' }]));
    expect(getCall('m1', 'c2').priorContent).toBe('hello world');
    finishCall('m1', 'c2', { path: '/workspace/src/F.tsx', diff: { added: 1, removed: 1 } });

    startCall('m1', inflightEdit('c3', '/workspace/src/F.tsx', [{ oldText: 'missing', newText: 'x' }]));
    expect(getCall('m1', 'c3').priorContent).toBe('hello there');
    finishCall('m1', 'c3', { path: '/workspace/src/F.tsx', editsApplied: 0, failedEdit: 0 }, false);

    startCall('m1', inflightWrite('c4', '/workspace/src/F.tsx', 'next'));
    expect(getCall('m1', 'c4').priorContent).toBe('hello there');
  });

  test('a refused delete (PINNED) does NOT zero the shadow', () => {
    useChatStore.getState().appendMessage(asst('m1'));
    startCall('m1', inflightWrite('c1', '/workspace/src/C.tsx', 'kept'));
    finishCall('m1', 'c1', { path: '/workspace/src/C.tsx', replaced: false });

    const del: ToolCall = {
      id: 'c2',
      name: 'delete_file',
      argsJson: JSON.stringify({ path: '/workspace/src/C.tsx' }),
    };
    startCall('m1', del);
    finishCall('m1', 'c2', { path: '/workspace/src/C.tsx', deleted: false, reason: 'PINNED' });

    startCall('m1', inflightWrite('c3', '/workspace/src/C.tsx', 'next'));
    expect(getCall('m1', 'c3').priorContent).toBe('kept');
  });

  test('restored sessions replay completed writes into the shadow via appendMessage', () => {
    const restored: ChatMessage = {
      ...asst('m0'),
      streaming: false,
      toolCalls: [
        {
          ...inflightWrite('c0', '/workspace/src/D.tsx', 'restored-content'),
          ok: true,
          resultJson: JSON.stringify({ path: '/workspace/src/D.tsx', replaced: false }),
        },
      ],
    };
    useChatStore.getState().appendMessage(restored);

    useChatStore.getState().appendMessage(asst('m1'));
    startCall('m1', inflightWrite('c1', '/workspace/src/D.tsx', 'new-content'));
    expect(getCall('m1', 'c1').priorContent).toBe('restored-content');
  });

  test('non-write tools and already-completed calls pass through untouched', () => {
    useChatStore.getState().appendMessage(asst('m1'));
    const read: ToolCall = {
      id: 'c1',
      name: 'read_file',
      argsJson: JSON.stringify({ path: RULES_PATH }),
    };
    startCall('m1', read);
    expect(getCall('m1', 'c1').priorContent).toBeUndefined();
  });

  test('clear() resets the shadow', () => {
    useChatStore.getState().appendMessage(asst('m1'));
    startCall('m1', inflightWrite('c1', '/workspace/src/E.tsx', 'v1'));
    finishCall('m1', 'c1', { path: '/workspace/src/E.tsx', replaced: false });
    useChatStore.getState().clear();

    useChatStore.getState().appendMessage(asst('m2'));
    startCall('m2', inflightWrite('c2', '/workspace/src/E.tsx', 'v2'));
    expect(getCall('m2', 'c2').priorContent).toBeUndefined();
  });
});
