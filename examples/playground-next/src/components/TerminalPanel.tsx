/**
 * xterm.js-backed terminal panel. Owns the Terminal instance + the
 * Shell state machine; the React layer is a thin host that mounts
 * the canvas, hooks addons (fit / web-links / search / unicode11),
 * and wires the FilesPanel-style header (search toggle) on top.
 *
 * The Shell drives input, history, completion, cwd tracking, /ai,
 * etc. — see `src/lib/terminal/shell.ts`. Keep this component lean.
 */

import '@xterm/xterm/css/xterm.css';

import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

import { Shell } from '~/lib/terminal/shell';

const THEME = {
  // Match the playground's content background so the terminal looks
  // native to the panel and not like an embedded widget.
  background: '#0b0b12',
  foreground: '#e5e7eb',
  cursor: '#e5e7eb',
  cursorAccent: '#0b0b12',
  selectionBackground: '#2a2a35',
  black: '#0b0b12',
  red: '#ff7676',
  green: '#a4d4a8',
  yellow: '#e6c79c',
  blue: '#82a8d8',
  magenta: '#c79cd4',
  cyan: '#9cd4cb',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#ff9d9d',
  brightGreen: '#bce5bf',
  brightYellow: '#f1d4ad',
  brightBlue: '#a5c2e2',
  brightMagenta: '#d4b5dd',
  brightCyan: '#b6dfd8',
  brightWhite: '#f9fafb',
} as const;

interface TerminalPanelProps {
  /**
   * OPFS path the bash mount is rooted at. Defaults to the workspace
   * itself; pass a deeper subtree (e.g. a cloned repo dir) to scope
   * the terminal to that directory.
   */
  repoDir?: string;
}

export function TerminalPanel({ repoDir = '/workspace' }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const shellRef = useRef<Shell | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: THEME,
      // System monospace stack. Match the playground's font choice if
      // we ever pin one; for now stay native so each OS shows its own
      // tuned coding font.
      fontFamily:
        '"JetBrains Mono","Fira Code","SF Mono",Menlo,Consolas,"Liberation Mono",monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      // 100k-cell scrollback — enough for long log dumps without
      // bloating memory for the common case.
      scrollback: 10_000,
      allowProposedApi: true,
      convertEol: false,
      smoothScrollDuration: 80,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 4.5,
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    const webLinks = new WebLinksAddon();
    const unicode = new Unicode11Addon();

    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(webLinks);
    term.loadAddon(unicode);
    term.unicode.activeVersion = '11';

    term.open(host);
    fit.fit();

    const shell = new Shell(term, repoDir);
    shell.start();
    term.onData((data) => shell.handleData(data));

    // Refocus when the user clicks anywhere in the host — xterm's
    // built-in focus is on the canvas, but our scroll wrappers can
    // intercept clicks.
    const onHostClick = () => term.focus();
    host.addEventListener('click', onHostClick);
    term.focus();

    // Resize: react to the host element resizing (drag handles +
    // viewport changes) by re-running fit. ResizeObserver is the
    // right primitive — `window.resize` misses pane drags.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* fit can throw on a 0×0 measure during HMR — ignore */
      }
    });
    observer.observe(host);

    termRef.current = term;
    shellRef.current = shell;
    searchRef.current = search;
    fitRef.current = fit;

    return () => {
      observer.disconnect();
      host.removeEventListener('click', onHostClick);
      term.dispose();
      termRef.current = null;
      shellRef.current = null;
      searchRef.current = null;
      fitRef.current = null;
    };
  }, [repoDir]);

  // Wire Ctrl-F (Cmd-F on Mac) to the search overlay even when the
  // terminal has focus. We listen on the host to capture before xterm
  // handles it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handler = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === 'f') {
        event.preventDefault();
        setSearchOpen(true);
        setSearchQuery('');
      }
    };
    host.addEventListener('keydown', handler);
    return () => host.removeEventListener('keydown', handler);
  }, []);

  const runSearch = (forward: boolean) => {
    const search = searchRef.current;
    if (!search || !searchQuery) return;
    if (forward) search.findNext(searchQuery);
    else search.findPrevious(searchQuery);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0b0b12]">
      {searchOpen ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[#2a2a35] px-3 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-gray">find</span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(!e.shiftKey);
              if (e.key === 'Escape') closeSearch();
            }}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="search…"
            className="flex-1 rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[12px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
          />
          <button
            type="button"
            onClick={() => runSearch(false)}
            className="rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-gray hover:border-soft-white hover:text-soft-white"
            title="previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => runSearch(true)}
            className="rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-gray hover:border-soft-white hover:text-soft-white"
            title="next match (Enter)"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={closeSearch}
            className="rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-gray hover:border-soft-white hover:text-soft-white"
            title="close (Esc)"
          >
            ×
          </button>
        </div>
      ) : null}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 pt-2" tabIndex={0} />
    </div>
  );
}
