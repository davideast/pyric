---
name: listener-highlights
description: Listener highlights in Pyric — use when explaining Overview or Flow styling, customizing highlight themes, adding Flow Studies treatments, or fixing detached highlight geometry.
---

# Listener highlights

Teach or customize the highlights without changing what the diagnostic claims. **Overview** identifies registered listener regions. **Flow** identifies component renders observed after a listener delivery; it does not prove data dependencies or measure CPU cost.

This skill belongs to the Pyric repository. Resolve code paths from its root; the current implementation is authoritative when a reference and source disagree.

## 1. Identify the surface

Read the relevant functions in [overlay-theme.ts](../../../packages/cli/src/serve/runtime/overlay-theme.ts), then locate the element being styled:

| Surface | Drawing mechanism | Owner |
| --- | --- | --- |
| Overview region | Separate box in the fixed overlay layer | `listener-overlay.ts` |
| Ordinary Flow target | Outline on the app element; `::after` label | `listener-flow-painter.ts` |
| Photo/input Flow label | Separate badge in the overlay layer | `listener-flow-painter.ts`, `overlay-anchor.ts` |
| Runtime chip panel | Shadow DOM styles | `chip.ts`; separate from highlight styling |

**Done:** name the surface, mode, and whether the request changes theme values, a visual treatment, or positioning. For explanation-only requests, explain this model and the applicable customization path below, then stop without editing files.

## 2. Choose the customization path

- **Colors, typography, line widths, fade appearance:** read [CUSTOMIZATION.md — Theme values](CUSTOMIZATION.md#theme-values). Use the existing allowlisted theme properties.
- **A new visual treatment:** read [CUSTOMIZATION.md — Treatments](CUSTOMIZATION.md#treatments). Start in Flow Studies unless the user explicitly wants a runtime default or configurable product feature.
- **Scroll drift, displaced labels, or cleanup:** read [CUSTOMIZATION.md — Geometry](CUSTOMIZATION.md#geometry). Trace the element-to-overlay binding before changing CSS offsets.

**Done:** identify the exact files and selectors or property names that implement the requested change. Distinguish demo-only hooks from the runtime contract.

## 3. Implement the treatment

Keep listener color identity and readable fresh/retained states. Animate diagnostic paint independently of app content; fading the marked element itself fades the user's app. Use outlines, inset shadows, or positioned decoration to preserve its layout and pointer interaction.

For this project's styling work, use grid/flex `gap` for spacing, with explicit control sizes and shared alignment tracks. Do not add margin or padding for spacing. Existing legacy padding tokens are compatibility surface, not a pattern for new treatments.

Ordinary targets and replaced-element badges are two rendering paths: account for both in every changed label treatment. Scope experimental selectors to the example, and reuse the positioning machinery for detached decoration. Check existing application pseudo-elements before taking over `::before` or `::after`.

**Done:** every affected surface has a fresh state, a retained state, and a cleanup path; any motion has a reduced-motion presentation. New visual metaphors explain what they encode without implying unmeasured behavior.

## 4. Verify at the changed boundary

Read [VERIFICATION.md](VERIFICATION.md) and run the checks for the affected path. For a positioning bug, first demonstrate measurable drift, then compare the overlay and target rectangles after the fix.

**Done:** report the changed surface, customization location, checks actually run, and any unverified browser or host-layout cases. Screenshots support visual judgment; geometry assertions establish attachment during scrolling.
