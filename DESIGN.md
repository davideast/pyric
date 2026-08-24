---
name: Pyric Design System
description: Minimal, low-contrast, local-first developer interface system
colors:
  primary: "#8f7fe8"
  primary-light: "#6b57d6"
  accent-tint: "#1e1b2e"
  accent-ink: "#14102a"
  bg: "#16161a"
  panel: "#1e1e24"
  elevated: "#24242c"
  code-bg: "#0f0f17"
  ink: "#fbfbfe"
  muted: "#72728a"
  line: "#2a2a35"
  line-2: "#3a3a48"
  deny: "#ededee"
  deny-ink: "#0c0c0d"
  deny-tint: "#161618"
  diff-add: "#57b985"
  diff-add-bg: "#111d16"
  diff-remove: "#e2607a"
  diff-remove-bg: "#221318"
typography:
  display:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.7
  data:
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  caption:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.4
  micro:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.06em"
rounded:
  sm: "2px"
  md: "4px"
  lg: "6px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "24px"
  space-6: "32px"
  rhythm-para: "0.875rem"
  rhythm-group: "1.5rem"
  rhythm-subsection: "2.25rem"
  rhythm-section: "3.25rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  studio-nav-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "0 12px"
  studio-nav-tab-active:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "0 12px"
---

# Design System: Pyric

## Overview

**Creative North Star: "The Quiet Inspector"**

Pyric's visual identity is a minimalist, zero-noise dark interface where whitespace and strict vertical rhythm carry structure without heavy boxes or aggressive fills. Calm surface steps with low contrast between them keep the interface focused on data, rules, and code execution. A single muted violet accent provides rare, highly intentional focus points.

Hierarchy is driven strictly through typographic weight (`--ink`, `--muted`, `--faint`) and vertical rhythm rather than decorative backgrounds. High-density controls, precise hairline boundaries, and code-first monospaced readouts establish a professional, tools-first aesthetic.

**Key Characteristics:**
- **Calm Neutral Base:** Dark mode by default (`#16161a` background) with minimal low-contrast elevation steps (`#1e1e24`, `#24242c`).
- **Single Accent Discipline:** Muted Violet (`#8f7fe8`) is reserved exclusively for primary actions, active states, and focus rings.
- **Rhythmic Proximity:** Layout structure is defined by strict mathematical vertical rhythm tokens rather than ad-hoc margins.
- **Sparing Hairlines:** Subtle 1px borders (`#2a2a35`) separate major layout sections without creating visual noise.

## Colors

A calm, low-contrast neutral palette with a single muted violet accent used sparingly across dark-first surfaces.

### Primary
- **Muted Studio Violet** (`#8f7fe8` in dark mode, `#6b57d6` in light mode): Reserved for active states, key focus rings, and primary action triggers. Occupies ≤10% of any view.
- **Accent Wash / Ink** (`#1e1b2e` / `#14102a`): Low-luminance background tint and high-contrast text color for active accent elements.

### Neutral
- **App Canvas** (`#16161a`): Resting background surface for the application and documentation chrome.
- **Sunken Panel** (`#1e1e24`): Recessed containers, cards, sidebar rails, and table backgrounds.
- **Elevated Control** (`#24242c`): Interactive controls, dropdowns, and active surface layers.
- **High-Contrast Text** (`#fbfbfe`): Primary headlines, active labels, and primary body text.
- **Muted Text** (`#72728a`): Secondary body text, navigation tabs, and meta descriptions.
- **Hairline Border** (`#2a2a35` / `#3a3a48`): Minimal 1px structural dividing lines.

### State & Diff
- **Deny Verdict** (`#ededee` fill / `#0c0c0d` text / `#161618` tint): High-visibility filled chip for rule denials.
- **Diff Add** (`#57b985` text / `#111d16` bg): Positive diff additions and allowed verdicts.
- **Diff Remove** (`#e2607a` text / `#221318` bg): Negative diff removals and denied rule paths.

### Named Rules
**The Single Spotlight Rule.** The primary accent is restricted to ≤10% of any view. Its rarity is what gives it visual authority.
**The No-Blue-Cast Rule.** Neutral dark surfaces use pure, low-saturation neutral charcoal tones (`#16161a`, `#1e1e24`), avoiding cold blue tints.

## Typography

**Display / UI Font:** Inter (with system fallbacks: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto`)
**Data / Code Font:** JetBrains Mono (with monospaced fallbacks: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas`)

**Character:** Clean, highly legible sans-serif paired with crisp, high-density monospaced data rendering for code, security rules, and evaluation verdicts.

### Hierarchy
- **Display / Title** (600 weight, 17px, 1.5 line-height): Surface headers, card titles, and primary panel headings.
- **Body** (400 weight, 13px, 1.7 line-height): Standard prose and documentation paragraphs with a measure capped at 65–75ch.
- **Data / Code** (400 weight, 12.5px, 1.5 line-height): Monospaced code blocks, Firestore path expressions, and rule AST readouts.
- **Label** (500 weight, 12px, 1.5 line-height): UI buttons, input labels, form fields, and control options.
- **Caption** (400 weight, 11.5px, 1.4 line-height): Quiet metadata, timestamps, and secondary helper text.
- **Micro / Eyebrow** (600 weight, 10.5px, 0.06em tracking, uppercase): Section eyebrows, column headers, and status tags.

### Named Rules
**The Proximity Hierarchy Rule.** Text hierarchy is conveyed primarily by color weight (`--ink` → `--muted` → `--faint`) and vertical proximity rather than dramatic size jumps.

## Layout

A three-column grid system (`nav` | `content` | `toc`) anchored by a fixed 54px top header bar (`.studio__bar`). Content container width is capped at 1440px max-width (`--wide`), with responsive gutters (`clamp(16px, 3vw, 32px)`).

### Vertical Rhythm
Every element in prose and document layouts derives block spacing from four explicit rhythm tokens:
- **Para Beat (`--rhythm-para: 0.875rem`):** Tight binding between headings and intro text, or consecutive paragraphs.
- **Group Beat (`--rhythm-group: 1.5rem`):** Standard spacing between sibling blocks within a section.
- **Subsection Beat (`--rhythm-subsection: 2.25rem`):** Spacing before H3/H4 subsection headers.
- **Section Beat (`--rhythm-section: 3.25rem`):** Generous spacing before H2 section headers.

### Named Rules
**The Top-Heavy Gap Rule.** The margin-block-start above any heading always dwarfs the gap below the preceding block, ensuring headings visually bind to the content they introduce.

## Elevation & Depth

Pyric is strictly **Flat-By-Default**. Surfaces rely on flat, low-contrast background fills (`--bg`, `--panel`, `--elevated`) and hairline borders (`--line`) rather than drop shadows or heavy gradient overlays.

### Elevation Layers
- **Base Canvas (`--bg: #16161a`):** App backdrop.
- **Sunken Card / Code (`--panel: #1e1e24`):** Recessed containers and code blocks.
- **Raised Controls (`--elevated: #24242c`):** Dropdowns and active overlays.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Drop-shadows are omitted in favor of clear surface step contrast and 1px hairline borders (`#2a2a35`).

## Shapes

A crisp, subtle corner language:
- **Controls & Buttons:** 4px border-radius (`--rounded-md: 4px`).
- **Small Chips & Badges:** 2px border-radius (`--rounded-sm: 2px`).
- **Cards & Modals:** 6px border-radius (`--rounded-lg: 6px`).
- **Borders:** Subtle 1px solid hairline (`#2a2a35`).

## Components

### Buttons
- **Shape:** 4px radius (`var(--rounded-md)`).
- **Primary:** Background `var(--accent)` (`#8f7fe8`), text `var(--accent-ink)` (`#14102a`), padding `6px 14px`, 12px font-size, 500 font-weight.
- **Ghost:** Background `transparent`, text `var(--muted)` (`#72728a`), padding `6px 14px`, hover text `var(--ink)` (`#fbfbfe`).
- **Focus:** 2px outline in `var(--accent)` (`#8f7fe8`) with 2px offset.

### Navigation Bar (`.studio__bar`)
- **Height:** Fixed 54px height with sticky positioning at top.
- **Background:** `var(--panel)` (`#1e1e24`) with `1px solid var(--line)` bottom border.
- **Tabs (`.studio__nav-tab`):** 13px font-size, 500 font-weight, `color: var(--muted)`. Active tab has `color: var(--ink)` and a `2px solid var(--ink)` bottom border.

### Rule Verdict Badges
- **Allowed Chip:** Background `var(--diff-add-bg)` (`#111d16`), text `var(--diff-add)` (`#57b985`), 2px radius.
- **Denied Chip:** Background `var(--deny)` (`#ededee`), text `var(--deny-ink)` (`#0c0c0d`), 2px radius.

### Code Blocks & Pre
- **Background:** `var(--code-bg)` (`#0f0f17`), border `1px solid var(--line)`, radius 4px, font `var(--font-mono)`.

## Do's and Don't's

### Do:
- **Do** use strict vertical rhythm tokens (`--rhythm-para`, `--rhythm-group`, `--rhythm-section`) for all vertical spacing.
- **Do** keep primary violet accent usage under 10% of any view surface.
- **Do** use `var(--font-mono)` for all code, paths, and security rule expressions.
- **Do** bind headings tightly to their target content using the para beat (`0.875rem`).

### Don't:
- **Don't** use heavy drop shadows or gradient backgrounds.
- **Don't** introduce ad-hoc hex values; reference semantic CSS variables (`var(--bg)`, `var(--ink)`, `var(--accent)`).
- **Don't** create blue-tinted dark backgrounds; preserve neutral charcoal tones.
- **Don't** use ad-hoc margin-top values on headings or paragraphs outside the rhythm system.
