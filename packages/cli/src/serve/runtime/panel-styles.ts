/**
 * Pyric runtime panel design tokens and base component styles.
 *
 * Consumed by both the floating runtime chip (`chip.ts`) and served runtime
 * pages such as `/__pyric/unlock` (`unlock-page.ts`) so every served Pyric
 * control shares one palette, type ramp, spacing rail, and component skin.
 */

/** Color, spacing, and typography tokens for `:host` or `:root`. */
export const PYRIC_PANEL_TOKENS = `
    --pyric-bg: #1b1d23;
    --pyric-content: #15171c;
    --pyric-border: #3a3e49;
    --pyric-border-soft: #2d303a;
    --pyric-text: #edf0f5;
    --pyric-muted: #a4acbb;
    --pyric-accent: #b4c7ff;
    --pyric-warning: #e6c79c;
    --pyric-error: #f0a0a0;
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-6: 20px;
    --record-inset: calc(var(--space-3) + 1px);
    --content-inset: calc(var(--space-4) + var(--record-inset));
    color: var(--pyric-text);
    font-family: "Pyric Geist", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.5;
    font-synthesis: none;
    color-scheme: dark;
`;

/** Base reset, panel frame, sections, rows, fields, buttons, action bar, and verdicts. */
export const PYRIC_PANEL_BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  button, a, input { all: unset; box-sizing: border-box; font: inherit; }
  button, a { -webkit-tap-highlight-color: transparent; }
  :focus-visible { outline: 2px solid var(--pyric-accent); outline-offset: -2px; }
  .announcer, .sr-only { height: 1px; overflow: hidden; position: absolute; width: 1px; clip-path: inset(50%); white-space: nowrap; }
  .mono { font-family: "Pyric Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-variant-numeric: tabular-nums; }
  .icon { width: 16px; height: 16px; flex: none; }
  .live-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pyric-muted); font-weight: 600; font-size: 12px; }

  /* Zero-size outer tracks turn gaps into insets. The shell, section frames,
     and records all use this same construction, with no additive spacing. */
  .panel { display: grid; width: 440px; max-width: calc(100vw - 32px); background: var(--pyric-bg); border: 1px solid var(--pyric-border); border-radius: 12px; box-shadow: 0 18px 60px #0007; overflow: hidden; }
  .panel-header, .bar { display: grid; grid-template-columns: 0 minmax(0, 1fr) auto 0; align-items: center; column-gap: var(--content-inset); overflow: hidden; scrollbar-gutter: stable; scrollbar-width: thin; }
  .brand { display: flex; align-items: center; column-gap: var(--space-2); grid-column: 2; min-width: 0; }
  .panel-name { font-size: 16px; font-weight: 650; letter-spacing: -.02em; }
  .panel-header > .actions { grid-column: 3; }
  .actions { display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end; }

  /* The scrollbar owns a separate gutter. Records stop before it even on
     systems with overlay scrollbars; the footer never participates in scroll. */
  .view { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; column-gap: var(--space-4); min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: #555c6b transparent; overscroll-behavior: contain; }
  .view::-webkit-scrollbar { width: 8px; }
  .view::-webkit-scrollbar-thumb { background: #555c6b; border-radius: 4px; }
  .view-content { grid-column: 2; display: flex; flex-direction: column; gap: var(--space-6); min-width: 0; }
  .view-content::before, .view-content::after { content: ''; flex: 0 0 0; }
  .section { display: flex; flex-direction: column; gap: var(--space-3); }
  .section-heading, .intro-rail, .pagination { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; column-gap: var(--record-inset); }
  .section-line, .pagination-line { grid-column: 2; display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: 20px; }
  .intro-rail > .intro { grid-column: 2; }
  .section-title { font-size: 13px; font-weight: 600; margin: 0; }
  .section-meta, .hint { color: var(--pyric-muted); font-size: 11px; margin: 0; }
  .intro { display: flex; flex-direction: column; gap: var(--space-1); }
  .intro .section-title { font-size: 15px; }
  .rows { display: flex; flex-direction: column; border: 1px solid var(--pyric-border-soft); border-radius: 8px; background: var(--pyric-content); }
  .rows:empty { display: none; }
  .row { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; grid-template-rows: 0 auto 0; column-gap: var(--space-3); row-gap: var(--space-3); text-align: left; width: 100%; }
  .row + .row, .identity-record + .identity-record { border-top: 1px solid var(--pyric-border-soft); }
  .row:first-child { border-start-start-radius: 7px; border-start-end-radius: 7px; }
  .row:last-child { border-end-start-radius: 7px; border-end-end-radius: 7px; }
  .row-content { grid-column: 2; grid-row: 2; display: grid; align-items: center; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 88px; column-gap: var(--space-3); row-gap: var(--space-1); min-width: 0; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); width: 88px; height: 32px; flex: 0 0 88px; border: 1px solid #454b59; border-radius: 6px; background: #282d37; color: #dbe1ed; cursor: pointer; font-size: 11px; font-weight: 550; line-height: 16px; text-decoration: none; white-space: nowrap; }
  .btn:hover:not(:disabled):not([aria-disabled="true"]) { background: #343d4d; border-color: #76839b; color: #fff; }
  .btn:disabled, .btn[aria-disabled="true"] { cursor: not-allowed; opacity: .5; }
  .btn[aria-pressed="true"], .btn.btn-primary { background: #35435e; border-color: #829ac9; color: #dce6ff; }
  .btn.btn-primary:hover:not(:disabled):not([aria-disabled="true"]) { background: #3e4f6f; border-color: var(--pyric-accent); color: #fff; }
  .btn.icon-button { width: 32px; flex-basis: 32px; background: transparent; }
  .bar { min-height: 64px; border-top: 1px solid var(--pyric-border-soft); background: var(--pyric-content); }
  .bar-hint { grid-column: 2; color: var(--pyric-muted); font-size: 11px; }
  .bar > .actions { grid-column: 3; }
  .bar.no-hint { grid-template-columns: 0 minmax(0, 1fr) 0; }
  .bar.no-hint > .actions { grid-column: 2; }
  .bar.no-hint .bar-hint { display: none; }
  .field { display: grid; grid-template-columns: 0 16px minmax(0, 1fr) 0; gap: var(--space-3); align-items: center; height: 36px; flex: none; border: 1px solid #454b59; border-radius: 6px; background: var(--pyric-content); color: var(--pyric-muted); }
  .field > .icon { grid-column: 2; }
  .field input { grid-column: 3; width: 100%; min-width: 0; color: var(--pyric-text); font-size: 12px; }
  .field input::placeholder { color: var(--pyric-muted); opacity: 1; }
  .field:focus-within { outline: 2px solid var(--pyric-accent); outline-offset: -2px; }
  .field input:focus-visible { outline: none; }
  .sandbox-ai-facts { grid-column: 2; grid-row: 2; display: grid; gap: var(--space-3); min-width: 0; margin: 0; }
  .sandbox-ai-facts > div { display: grid; grid-template-columns: 88px minmax(0, 1fr); align-items: baseline; gap: var(--space-3); }
  .sandbox-ai-facts dt { color: var(--pyric-muted); font-size: 11px; }
  .sandbox-ai-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-family: "Pyric Geist Mono", ui-monospace, monospace; font-size: 12px; }
  .verdict { --verdict-border: #705b62; display: grid; grid-template-columns: 24px minmax(0, 1fr) 8px; align-items: center; box-sizing: border-box; width: 80px; min-width: 80px; height: 24px; border: 1px solid var(--verdict-border); border-radius: 4px; background: #2c282e; color: #d2c6ca; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; }
  .verdict-icon { display: grid; place-items: center; height: 100%; border-right: 1px solid var(--verdict-border); color: #d6a7ae; }
  .verdict-label { text-align: right; }
  .verdict .icon { width: 12px; height: 12px; }
  .verdict.ok { --verdict-border: #586b60; background: #252e2c; color: #c4d2cb; }
  .verdict.ok .verdict-icon { color: #a4c7b5; }
  .verdict.bypassed { --verdict-border: #5d6478; background: #272a33; color: #c9cedb; }
  .verdict.bypassed .verdict-icon { color: #aab4cc; }
  .verdict.warning { --verdict-border: #72644c; background: #2f2c26; color: #d6ccb8; }
  .verdict.warning .verdict-icon { color: #d6c096; }
`;
