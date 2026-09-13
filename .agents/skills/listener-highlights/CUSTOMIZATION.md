# Customization reference

All source links are relative to this repo-local skill. Read the named functions rather than assuming line numbers or copying a full token catalog into the skill.

## Theme values

[overlay-theme.ts](../../../packages/cli/src/serve/runtime/overlay-theme.ts) owns `OVERLAY_THEME_DEFAULTS`, `OVERLAY_THEME_VARIABLES`, resolution, persistence helpers, and both stylesheets. Its defaults are the allowlist: arbitrary keys in a theme object are ignored. Values must be strings and are applied as CSS values without semantic validation.

Precedence is defaults → `createListenerMode`'s `overlayTheme` option → stored page overrides under `pyric:overlay-theme`. `applyOverlayTheme` mirrors resolved variables to both the overlay container and `document.documentElement`. Flow targets are app elements outside the container, so container-only variables cannot theme both paths. Inline resolved values can also outrank a stylesheet's `:root` overrides.

Example value set for the existing Theme editor or `overlayTheme` option:

```json
{
  "--pyric-overlay-flow-outline-width": "1px",
  "--pyric-overlay-outline-style": "solid",
  "--pyric-overlay-radius": "3px",
  "--pyric-overlay-badge-bg": "#101621",
  "--pyric-overlay-badge-font-family": "\"Pyric Geist Mono\", ui-monospace, monospace",
  "--pyric-overlay-retained-opacity": "0.4"
}
```

`Pyric Geist Mono` is the locally registered font name; confirm [chip-fonts.ts](../../../packages/cli/src/serve/runtime/chip-fonts.ts) is installed in that document. Declaring the name alone does not load the font. The overlay's own default font and the chip's font can differ.

Use the existing mode handle's `setOverlayTheme(overrides)` for a live session change. That setter alone does not persist. The Theme editor wires persistence and application together; see [chip-theme-dialog.ts](../../../packages/cli/src/serve/runtime/chip-theme-dialog.ts) and [listener-mode.ts](../../../packages/cli/src/serve/runtime/listener-mode.ts). Writing localStorage directly requires a reload or explicit application in the same document: its own write does not fire a `storage` event there. Flow Studies intentionally supplies `themeStorage: null`, so use its option or live handle when testing values there.

Color assignment is stable by listener ID through [listener-palette.ts](../../../packages/cli/src/serve/runtime/listener-palette.ts). Palette overrides use `--pyric-hue-N`, `--pyric-hue-N-text`, and `--pyric-hue-N-retained`; obtain the actual indices from the contract. Overview incidents have their own incident color.

### Timing is two mechanisms

CSS hold/fade tokens control appearance. The painter separately schedules retention/removal with `fadeMs`, passed through `createListenerMode({ flow: { fadeMs } })`. Changing a CSS duration does not change that timer. If the request changes lifetime, inspect both [listener-flow-mode.ts](../../../packages/cli/src/serve/runtime/listener-flow-mode.ts) and [listener-flow-painter.ts](../../../packages/cli/src/serve/runtime/listener-flow-painter.ts), and verify the intended end state.

Each listener accumulates marks during a burst. When a mark's timer ends, it stays dim if it belongs to that listener's latest delivery; older marks clear. A repeat on the same element restarts its mark. Retained means last observed delivery, not currently executing.

## Treatments

[Flow Studies](../../../examples/runtime-flow-lab/README.md) consumes the same registry as the chip. Its deliveries are fixtures; React commits, listener folding, and the Flow painter are real.

The existing project-root `pyric.json` owns `flow.treatment` and `flow.treatments` registrations. Read the configuration and custom-module examples in the Flow Studies README when configuring an application. The shared sandbox host serves custom browser modules; Vite can override `flow`, and Next uses its existing host rewrites. Saved browser selection (`pyric:flow-treatment`) overrides the project default.

Read [flow-treatments/catalog.ts](../../../packages/cli/src/serve/runtime/flow-treatments/catalog.ts) for IDs and descriptions and [builtins.ts](../../../packages/cli/src/serve/runtime/flow-treatments/builtins.ts) for lazy loaders. Each implementation exports a `FlowTreatment`: `css` and optionally `mount(context)` returning `update`/`dispose`. Types are exported from `@pyric/cli/flow`. Common appearance lives in `base.ts`; vector annotations in `maps.ts`; the controller owns selection, metadata, loading failures, and lifecycle.

Adding a built-in requires its metadata, loader, implementation, and meaningful browser coverage. Custom modules live in the consuming app and use namespaced IDs. Scope selectors to `html[data-pyric-treatment="ID"]`. The controller sets `data-pyric-flow-hits`, `data-pyric-flow-sequence`, `data-pyric-flow-name`, and `data-pyric-flow-size` on marks and detached badges. Heat means observed paints; thread curves express correlation, not a proven causal graph. Treatment changes restyle retained marks without inventing another delivery.

### Runtime styling hooks

| Hook | Meaning |
| --- | --- |
| `[data-pyric-flow]` | Marked app element; attribute value is its palette index |
| `[data-pyric-flow-listener]` | Listener ID associated with the visible element mark |
| `[data-pyric-flow-role]` | Component kind supplied by the Flow subtree |
| `[data-pyric-flow-label]::after` | Ordinary target's label; first target names the delivery, later ones the component |
| `[data-pyric-flow-fading]` | CSS animation/transition state; can coexist with retained |
| `[data-pyric-flow-retained]` | Dimmed last-delivery mark |
| `[data-pyric-flow-badge]` | Detached label for a replaced target, inside the overlay |
| `[data-pyric-listener-box]` | Overview region box, not a Flow render target |

Detached badges carry `data-listener-id`, `data-hue`, and the fading/retained attributes. They are outside the app target: its descendant selectors cannot style them. Match them separately under `[data-pyric-listener-overlay]` and the same treatment selector. Preserve their position binding and translate-up placement while changing their appearance.

A minimal custom outline rule uses the runtime's per-target hue:

```css
html[data-pyric-treatment="team:custom"] [data-pyric-flow] {
  outline: 1px dashed var(--pyric-overlay-hue);
  outline-offset: 3px;
}
html[data-pyric-treatment="team:custom"] [data-pyric-flow-retained] {
  outline-color: color-mix(in srgb, var(--pyric-overlay-hue) 35%, transparent);
}
```

Treat this as the visual rule, not a complete treatment registration. Built-ins share base rules that handle labels and suppress the runtime outline animation; a custom module must account for the runtime animation cascade explicitly.

For a built-in treatment change, edit its implementation in the registry. For underlying fallback paint, edit `flowStyleSheetText` or `overlayStyleSheetText`. Extending the token contract is a separate change from registering a demo treatment. Trace any new property through resolution, both application locations, the Theme editor, persistence, and its tests.

## Geometry

Direct outlines move with their target's CSS box. Ordinary labels use a positioned pseudo-element; the painter temporarily sets `position: relative` only on static targets and restores it on cleanup. A large owner-region box is Overview even when it overlaps a Flow treatment demo.

Detached labels and Overview boxes use [overlay-anchor.ts](../../../packages/cli/src/serve/runtime/overlay-anchor.ts): `tryAnchorOverlay` feature-detects native anchors, binds position and optionally size, and returns a release function. Private names are reference-counted per target, preserving existing app anchor names. Targets behind shadow boundaries or an `anchor-scope` use measured fallback.

[listener-overlay.ts](../../../packages/cli/src/serve/runtime/listener-overlay.ts) owns fallback geometry updates: captured scroll events catch nested scrollers, frame scheduling coalesces work, and resize/mutation observers cover further layout changes. `onReposition` lets the Flow painter follow. Measured coordinates come from `getBoundingClientRect` in a fixed viewport layer; adding document scroll offsets mixes coordinate systems.

Keep detached decorations in the diagnostic overlay layer so they are excluded from Flow's observation of app mutations. Release anchor bindings, observers, timers, and detached nodes when targets disappear or a mode is disposed. Reuse this machinery when adding vector decorations; use the treatment context and its geometry-driven `update` callback, as `maps.ts` does.

Native support is feature-detected, not guaranteed by browser name. For a new API capability, verify current browser documentation and behavior; existing tests exercise the native path and a forced fallback separately. Transformed containing blocks, clipping, and existing app pseudo-elements require testing in the actual host layout.
