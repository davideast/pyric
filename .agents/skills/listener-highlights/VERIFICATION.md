# Verification by changed surface

Commands run from the repository root after workspace dependencies are installed. For explanation-only work, verify source references; running the app suite is unnecessary.

## Theme or runtime painter changes

```sh
bun test packages/cli/test/serve/runtime/overlay-theme.test.ts packages/cli/test/serve/runtime/listener-overlay.test.ts packages/cli/test/serve/runtime/listener-flow-painter.test.ts
```

Include `listener-mode.test.ts` and the relevant Theme dialog tests when changing application or persistence. Run `bun run build` in `packages/cli` for production TypeScript changes. Select additional tests based on the actual changed behavior rather than asserting styling through source-text matches.

## Visual treatments

Start the example:

```sh
bun examples/runtime-flow-lab/serve.ts
```

Restart after TypeScript edits; CSS and HTML are read per request. To use a different port, set `FLOW_LAB_PORT` for the server and `FLOW_LAB_URL` for the browser checks. Inspect an existing server before replacing it.

With it running:

```sh
node examples/runtime-flow-lab/verify.mjs
bunx --no-install tsc -p examples/runtime-flow-lab/tsconfig.json
```

The browser script covers specific render targets, fan-out, idle delivery, the treatment catalog, bursts, narrow viewports, reduced motion, and inspector toggling. If adding a treatment, inspect the script for assumptions about catalog size and expand meaningful coverage.

Visually inspect the changed treatment on both a normal component and a photo/input, during fresh and retained states. Include a long label, small target, and nested component. Confirm app text remains readable, click targets work, and changing treatments clears prior decoration. For motion, inspect the reduced-motion result as well as the animated state. Existing screenshots go to `/tmp/flow-lab-review` by default.

## Positioning or detached decoration

```sh
node examples/runtime-flow-lab/verify-scroll.mjs
```

This checks native CSS anchors and forced measured fallback: document scrolling, nested scrolling, reflow, target resizing, removed photos, and shared anchor-name restoration. Geometry comparisons allow less than two pixels of drift. It uses Chromium; passing it is not evidence for every browser engine.

Add a focused regression for any geometry case outside that coverage. Compare target and decoration rectangles before and after the triggering action; a stationary screenshot cannot establish scroll attachment. For animation-only movement, clipping, transforms, or shadow roots, reproduce that host structure explicitly.

Report observed results and remaining limits, without presenting demo fixture deliveries as end-to-end SDK transport verification.
