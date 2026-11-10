/**
 * The terminal lines a live host prints for the observed calls it accepts: a
 * block for each call production denied, the AI block for each AI Logic
 * request production rejected, and the AI block for each answer production
 * withheld. These pin the terminal text, which is neither
 * chip nor Studio copy.
 */
import { describe, expect, it } from 'bun:test';
import type { ObservedCall } from 'pyric/sandbox';
import type { BridgeMessage } from '../../src/bridge/protocol.js';
import { formatAiBlockedBlock, formatAiRejectionBlock } from '../../src/serve/ai-terminal-blocks.js';
import { createLiveHostState } from '../../src/serve/live-host-state.js';
import {
  createLiveTerminalLines,
  formatObservedAiBlock,
  formatObservedAiRejection,
  formatProductionDenial,
  liveTerminalBlock,
  rulesFilesOf,
  type LiveRulesFiles,
} from '../../src/serve/live-terminal-lines.js';

const RULES: LiveRulesFiles = { firestore: ['firestore.rules'], rtdb: ['database.rules.json'], storage: ['storage.rules'] };

function call(fields: Partial<ObservedCall> & { method: string }): ObservedCall {
  return { service: 'firestore', at: 1, outcome: { status: 'ok' }, ...fields } as ObservedCall;
}

const denied = { status: 'error', code: 'permission-denied' } as const;

describe('the production denial block', () => {
  it('names the call, the code, the client, the uid and the rules file production did not read', () => {
    const block = formatProductionDenial(
      call({ method: 'getDoc', path: 'notes/n1', outcome: denied, account: { uid: '8fK2qLx0aVb3' } }),
      { kind: 'browser', label: '/settings/billing' },
      RULES,
    );
    expect(block).toBe([
      '  ⚠ [pyric] production denied: firestore getDoc notes/n1',
      '      permission-denied',
      '      from: browser tab /settings/billing',
      '      auth: 8fK2qLx0aVb3',
      '      production decided this with its deployed rules, not your local firestore.rules',
    ].join('\n'));
  });

  it("adds production's message to the code line, as the SDK's error held it", () => {
    const block = formatProductionDenial(
      call({ method: 'getDoc', path: 'notes/n1', outcome: { ...denied, message: 'Missing or insufficient permissions.' }, account: { uid: '8fK2qLx0aVb3' } }),
      { kind: 'browser', label: '/settings/billing' },
      RULES,
    );
    expect(block).toBe([
      '  ⚠ [pyric] production denied: firestore getDoc notes/n1',
      '      permission-denied: Missing or insufficient permissions.',
      '      from: browser tab /settings/billing',
      '      auth: 8fK2qLx0aVb3',
      '      production decided this with its deployed rules, not your local firestore.rules',
    ].join('\n'));
  });

  it("flattens production's message and preserves emails and URLs verbatim", () => {
    const message = "User does not have permission to access 'users/ann@example.com/a.png'.\n\u001b[31m forged https://x.example/a?key=public-web-key";
    const block = formatProductionDenial(call({ service: 'storage', method: 'getBytes', path: 'a.png', bucket: 'b', outcome: { status: 'error', code: 'storage/unauthorized', message } }), undefined, RULES);
    const line = block.split('\n')[1]!;
    expect(block.split('\n')).toHaveLength(3);
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(line).toContain("users/ann@example.com/a.png");
    expect(line).toContain('https://x.example/a?key=public-web-key');
  });

  it('names each service\'s own rules file', () => {
    const rtdb = formatProductionDenial(call({ service: 'rtdb', method: 'get', path: '/items/a', instance: 'p-default-rtdb', outcome: { status: 'error', code: 'permission_denied' } }), undefined, RULES);
    expect(rtdb.split('\n').at(-1)).toBe('      production decided this with its deployed rules, not your local database.rules.json');
    const storage = formatProductionDenial(call({ service: 'storage', method: 'getBytes', path: 'a.png', bucket: 'b', outcome: { status: 'error', code: 'storage/unauthorized' } }), undefined, RULES);
    expect(storage.split('\n').at(-1)).toBe('      production decided this with its deployed rules, not your local storage.rules');
  });

  it('drops each line whose field the call did not carry', () => {
    const block = formatProductionDenial(call({ method: 'getDocs', outcome: denied }), undefined, { firestore: [], rtdb: [], storage: [] });
    expect(block).toBe(['  ⚠ [pyric] production denied: firestore getDocs', '      permission-denied'].join('\n'));
  });

  it('names a Node process and a service worker by their scripts, and a client with no label by its kind', () => {
    const from = (source: Parameters<typeof formatProductionDenial>[1]) =>
      formatProductionDenial(call({ method: 'getDoc', outcome: denied }), source, RULES).split('\n')[2];
    expect(from({ kind: 'node', label: 'server.ts' })).toBe('      from: Node process server.ts');
    expect(from({ kind: 'service-worker', label: '/sw.js' })).toBe('      from: service worker /sw.js');
    expect(from({ kind: 'browser' })).toBe('      from: browser tab');
  });

  it('flattens control characters from every field and preserves an email in a path', () => {
    const block = formatProductionDenial(
      call({ method: 'getDoc', path: 'users/ann@example.com/x\u001b[31m', outcome: denied, account: { uid: 'u\nforged' } }),
      { kind: 'browser', label: '/a\u001b]0;title\u0007' },
      { firestore: ['rules/\u001bfs.rules'], rtdb: [], storage: [] },
    );
    expect(block).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(block.split('\n')).toHaveLength(5);
    expect(block).toContain('users/ann@example.com/x');
  });
});

describe('which accepted calls print', () => {
  it('prints a denial only for a client call to a service with rules', () => {
    expect(liveTerminalBlock(call({ method: 'getDoc', outcome: denied }), undefined, RULES)).not.toBeNull();
    expect(liveTerminalBlock(call({ method: 'getDoc' }), undefined, RULES)).toBeNull();
    expect(liveTerminalBlock(call({ method: 'getDoc', outcome: { status: 'error', code: 'unavailable' } }), undefined, RULES)).toBeNull();
    // An Admin call bypasses Security Rules; production's IAM decided it.
    expect(liveTerminalBlock(call({ method: 'DocumentReference.get', sdk: 'admin', outcome: denied }), undefined, RULES)).toBeNull();
    expect(liveTerminalBlock(call({ service: 'auth', method: 'signInWithEmailAndPassword', outcome: { status: 'error', code: 'auth/permission-denied' } }), undefined, RULES)).toBeNull();
  });

  it('prints an AI block only for an answer production gave', () => {
    const ai = (code: string) => call({ service: 'ai', method: 'generateContent', ai: { model: 'models/gemini-2.5-flash' }, outcome: { status: 'error', code } });
    expect(liveTerminalBlock(ai('invalid_argument'), undefined, RULES)?.block).toContain('INVALID_ARGUMENT (400)');
    expect(liveTerminalBlock(ai('http_418'), undefined, RULES)?.block).toContain('ERROR (418)');
    // The SDK failed before any request: production never answered.
    expect(liveTerminalBlock(ai('fetch-error'), undefined, RULES)).toBeNull();
    expect(liveTerminalBlock(ai('AbortError'), undefined, RULES)).toBeNull();
    expect(liveTerminalBlock(call({ service: 'ai', method: 'generateContent', ai: { model: 'm' } }), undefined, RULES)).toBeNull();
  });
});

describe('the observed AI blocks', () => {
  it('prefixes the headline with production, names no engine and adds the client', () => {
    const block = formatObservedAiRejection(
      call({ service: 'ai', method: 'generateContent', ai: { model: 'gemini-2.5-flash' }, outcome: { status: 'error', code: 'invalid_argument' } }),
      { kind: 'node', label: 'server.ts' },
    );
    expect(block).toBe([
      '  ⚠ [pyric] production ai request rejected',
      '      model: gemini-2.5-flash',
      '      INVALID_ARGUMENT (400)',
      '      from: Node process server.ts',
    ].join('\n'));
  });

  it("ends an observed rejection's headline with production's message", () => {
    const block = formatObservedAiRejection(
      call({ service: 'ai', method: 'generateContent', ai: { model: 'gemini-2.5-flash' }, outcome: { status: 'error', code: 'invalid_argument', message: 'Request contains an invalid argument.' } }),
      { kind: 'node', label: 'server.ts' },
    );
    expect(block).toBe([
      '  ⚠ [pyric] production ai request rejected: Request contains an invalid argument.',
      '      model: gemini-2.5-flash',
      '      INVALID_ARGUMENT (400)',
      '      from: Node process server.ts',
    ].join('\n'));
  });

  it('prints the blocked block for an answer production withheld, from its finish or block reason', () => {
    const answered = (ai: NonNullable<ObservedCall['ai']>) => call({ service: 'ai', method: 'generateContent', ai });
    expect(formatObservedAiBlock(answered({ model: 'gemini-2.5-flash', finishReason: 'SAFETY' }), { kind: 'browser', label: '/chat' })).toBe([
      '  ⚠ [pyric] production ai response blocked: SAFETY',
      '      model: gemini-2.5-flash',
      '      no content was returned; text() and functionCalls() throw for this finish reason',
      '      from: browser tab /chat',
    ].join('\n'));
    expect(formatObservedAiBlock(answered({ model: 'gemini-2.5-flash', blockReason: 'PROHIBITED_CONTENT' }), undefined)).toBe([
      '  ⚠ [pyric] production ai response blocked: PROHIBITED_CONTENT',
      '      model: gemini-2.5-flash',
      '      the prompt was blocked before generation; no candidates were returned',
    ].join('\n'));
    // A finish reason the SDK still answers text() for is no block, and neither is an answer with content.
    expect(formatObservedAiBlock(answered({ model: 'm', finishReason: 'OTHER' }), undefined)).toBeNull();
    expect(formatObservedAiBlock(answered({ model: 'm' }), undefined)).toBeNull();
  });

  it('keeps production\'s reason when it has one, and the blocked block takes the same additions', () => {
    const rejected = formatAiRejectionBlock(
      { message: 'Request contains an invalid argument.', model: 'gemini-2.5-flash', engine: 'gemini', status: 'INVALID_ARGUMENT', code: 400 },
      { from: 'Node process server.ts' },
    );
    expect(rejected).toBe([
      '  ⚠ [pyric] production ai request rejected: Request contains an invalid argument.',
      '      model: gemini-2.5-flash',
      '      INVALID_ARGUMENT (400)',
      '      from: Node process server.ts',
    ].join('\n'));
    const blocked = formatAiBlockedBlock({ finishReason: 'SAFETY', model: 'gemini-2.5-flash', engine: 'gemini' }, { from: 'browser tab /chat' });
    expect(blocked).toBe([
      '  ⚠ [pyric] production ai response blocked: SAFETY',
      '      model: gemini-2.5-flash',
      '      no content was returned; text() and functionCalls() throw for this finish reason',
      '      from: browser tab /chat',
    ].join('\n'));
  });

  it('leaves the sandbox blocks as they were', () => {
    expect(formatAiRejectionBlock({ model: 'm', engine: 'scripted' }).split('\n')).toEqual([
      '  ⚠ [pyric] ai request rejected: request rejected',
      '      model: m (engine: scripted)',
    ]);
    expect(formatAiBlockedBlock({ finishReason: 'SAFETY' }).split('\n')[0]).toBe('  ⚠ [pyric] ai response blocked: SAFETY');
  });
});

describe('the rules files a session names', () => {
  it('names each relative to the project, Firestore\'s source only', () => {
    const session = {
      firestoreRulesFiles: () => ['/app/rules/firestore.rules', '/app/rules/lib.rules'],
      databaseRulesFiles: () => ['/app/database.rules.json'],
      storageRulesFiles: () => ['storage.rules'],
    };
    expect(rulesFilesOf(session, '/app')).toEqual({ firestore: ['rules/firestore.rules'], rtdb: ['database.rules.json'], storage: ['storage.rules'] });
  });
});

describe('the throttle', () => {
  it('prints one block per call and code within the window, as the sandbox denial relay does', () => {
    const printed: string[] = [];
    let now = 0;
    const lines = createLiveTerminalLines({ print: (block) => printed.push(block), now: () => now });
    const read = call({ method: 'getDoc', path: 'notes/n1', outcome: denied });
    lines.accepted(read, undefined);
    lines.accepted(read, undefined);
    lines.accepted(call({ method: 'getDoc', path: 'notes/n2', outcome: denied }), undefined);
    expect(printed).toHaveLength(2);
    now = 5_000;
    lines.accepted(read, undefined);
    expect(printed).toHaveLength(3);
  });

  it('prints one blocked block per model and reason within the window', () => {
    const printed: string[] = [];
    const lines = createLiveTerminalLines({ print: (block) => printed.push(block), now: () => 0 });
    const blocked = (finishReason: string) => call({ service: 'ai', method: 'generateContent', ai: { model: 'm', finishReason } });
    lines.accepted(blocked('SAFETY'), undefined);
    lines.accepted(blocked('SAFETY'), undefined);
    lines.accepted(blocked('RECITATION'), undefined);
    expect(printed.map((block) => block.split('\n')[0])).toEqual([
      '  ⚠ [pyric] production ai response blocked: SAFETY',
      '  ⚠ [pyric] production ai response blocked: RECITATION',
    ]);
  });

  it('reads the rules files once the session runs, and drops the line while it cannot', () => {
    const printed: string[] = [];
    const lines = createLiveTerminalLines({ print: (block) => printed.push(block) });
    lines.accepted(call({ method: 'getDoc', path: 'a/1', outcome: denied }), undefined);
    lines.readRulesFiles(() => RULES);
    lines.accepted(call({ method: 'getDoc', path: 'a/2', outcome: denied }), undefined);
    lines.readRulesFiles(() => {
      throw new Error('closed');
    });
    lines.accepted(call({ method: 'getDoc', path: 'a/3', outcome: denied }), undefined);
    expect(printed.map((block) => block.includes('firestore.rules'))).toEqual([false, true, false]);
  });
});

describe('the live host', () => {
  function frame(id: string, observed: ObservedCall, platform: string, script?: string): BridgeMessage {
    const message = { t: 'observe', id, call: observed, ...(script === undefined ? {} : { script }) };
    return { type: 'worker-message', clientSessionId: 's-1', platform, message } as unknown as BridgeMessage;
  }
  function reply(id: string, ok: boolean): BridgeMessage {
    const message = ok ? { t: 'res', id, ok: true, value: undefined } : { t: 'res', id, ok: false, error: { code: 'invalid-argument', message: 'no' } };
    return { type: 'worker-message-result', clientSessionId: 's-1', message } as unknown as BridgeMessage;
  }

  it('prints a block for each denied call it accepted, naming the client that sent it, and none for a refused frame', () => {
    const printed: string[] = [];
    const live = createLiveHostState({ configProjectId: 'p', configSource: undefined, optionName: '--project', warn: () => {}, print: (block) => printed.push(block) });
    live.readRulesFiles(() => RULES);
    live.inbound(frame('1', call({ method: 'getDoc', path: 'notes/n1', outcome: denied, account: { uid: 'u1' } }), 'node', 'server.mjs'));
    live.outbound(reply('1', true));
    live.inbound(frame('2', call({ method: 'getDoc', path: 'notes/n2', outcome: denied }), 'node', 'server.mjs'));
    live.outbound(reply('2', false));
    expect(printed).toEqual([[
      '  ⚠ [pyric] production denied: firestore getDoc notes/n1',
      '      permission-denied',
      '      from: Node process server.mjs',
      '      auth: u1',
      '      production decided this with its deployed rules, not your local firestore.rules',
    ].join('\n')]);
  });
});
