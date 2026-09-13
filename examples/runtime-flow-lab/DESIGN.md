---
name: Pyric Runtime Flow Lab
description: Local visual studies layered on real runtime Flow marks.
colors:
  canvas: "#0e1014"
  text: "#e8ebf1"
  muted: "#a3adbd"
  line: "#303640"
  control: "#222831"
  control-border: "#414b5b"
  control-hover: "#343e4e"
  primary: "#c3d0ff"
  primary-text: "#17213c"
typography:
  body:
    fontFamily: '"Pyric Geist", system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  title:
    fontFamily: '"Pyric Geist", system-ui, sans-serif'
    fontSize: "28px"
    fontWeight: 600
    letterSpacing: "-0.025em"
  control:
    fontFamily: '"Pyric Geist", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 500
  annotation:
    fontFamily: '"Pyric Geist Mono", monospace'
    fontSize: "10px"
rounded:
  control: "7px"
  workspace: "12px"
  mark: "5px"
spacing:
  tight: "4px"
  compact: "8px"
  control: "10px"
  row: "12px"
  inset: "16px"
  group: "20px"
  section: "24px"
components:
  button:
    backgroundColor: "{colors.control}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
  button-hover:
    backgroundColor: "{colors.control-hover}"
  flow-label:
    typography: "{typography.annotation}"
    height: "20px"
---

# Design System: Pyric Runtime Flow Lab

## Overview

**Creative North Star: "Runtime Flow studies"**

This document records the local example built in `lab.css`, `treatments.css`, `app.ts`, and `index.html`. It extends the existing dark Pyric preview with the user's chosen Geist and Geist Mono pairing. It establishes neither a new Pyric brand nor a public runtime theme API.

The workspace stays quiet so changes in individual chat regions remain visible. Controls introduce a delivery, annotations show observed rendering, and nearby descriptions explain each treatment's use and limitation.

**Key Characteristics:**

- Dark, flat surfaces with compact controls and aligned edges.
- Gap-only spacing, including inset and outer whitespace.
- Monospaced runtime annotations over readable chat content.
- Five standard and ten experimental treatments sharing real Flow marks.

## Colors

### Primary

Pale periwinkle identifies the main delivery action. Runtime listener colors remain supplied by Flow rather than being replaced with this interface accent. Heat memory deliberately uses a blue-to-amber count scale and changes its legend accordingly.

### Neutral

The near-black canvas, cool pale text, muted supporting text, and slate dividers keep the surrounding interface restrained. Controls become lighter on hover; the chat uses adjacent dark tones to separate channels from the conversation.

**The Evidence Color Rule.** Preserve listener color across treatments except where a treatment explicitly assigns color another disclosed meaning, as heat memory does for observed update counts.

## Typography

Geist is served locally as **Pyric Geist** for interface and chat text. **Pyric Geist Mono** marks metadata and runtime annotations. The heading is compact rather than promotional; its mobile size is (25px). Conversation headings use (16px), message text and controls (13px), and secondary metadata (10–12px). Supporting text keeps a clear hierarchy without introducing additional display faces.

## Layout

Flex and grid gaps establish spacing; empty pseudo-elements create inset space without margin or padding. Common content insets use the recorded inset step. Main sections use the section step, while message bylines and text use tighter steps.

The chat has a channel rail (148px) beside a flexible conversation. At widths up to (600px), the rail becomes a horizontal section above the messages and the treatment index becomes one column. At widths from (1250px), the page reserves a right column (452px) for the actual runtime inspector. Outer gaps are (24px), become (28px) with that inspector reservation, and (16px) on narrow screens.

**The Gap-Only Rule.** Express spacing through layout gaps, tracks, dimensions, and empty inset cells; do not add margin or padding declarations to this example.

## Elevation & Depth

The interface uses tonal surfaces and thin borders, with no ambient card shadows. Some experimental marks use inset washes or contour shadows as data annotations. These effects belong to the selected treatment, not the underlying page's elevation vocabulary.

## Shapes

Controls use gently rounded corners; the workspace has a larger shared outline and matching rail corners. Portraits and presence markers are circular. Flow perimeters and compact labels sit outside the marked region; their shape can vary by treatment without changing the chat layout.

## Components

- **Delivery buttons:** compact bordered controls with a minimum height of (36px), a lighter hover surface, and a visible focus outline. The main message action uses the primary colors. Disabled controls show a wait cursor and reduced opacity.
- **Treatment selector:** a native select in a gap-based inset wrapper, accompanied by two square (32px) SVG arrow buttons. Each index entry presents a treatment name and purpose; hover and selection share a darker blue surface.
- **Chat workspace:** one bordered container with static channel context, portraits, message rows, and independent presence, typing, and receipt regions. The unread badge remains a compact square count rather than a new navigation control.
- **Flow annotations:** outlines, labels, washes, rails, brackets, and experimental geometry decorate actual Flow-marked regions. Fresh and retained marks differ in emphasis. Reduced-motion preferences disable treatment animation and transitions.
- **Inspector control:** opens or minimizes the existing runtime chip. Its appearance and behavior remain owned by the runtime.

## Do's and Don'ts

### Do:

- **Do** preserve Geist and Geist Mono, shared alignment lines, and gap-only spacing.
- **Do** keep experimental effects scoped to this example and preserve reduced-motion behavior.
- **Do** disclose that deliveries are fixtures and that observed renders establish correlation.

### Don't:

- **Don't** describe heat as CPU cost, dimensions as render duration, or fixture sequence numbers as traced dependencies.
- **Don't** promote these experimental treatments into a public theme API or a new brand identity.

Not canonized: individual treatment flourishes and the one-letter workspace placeholder are local demonstration details, not reusable brand assets. No approved composition or external quality benchmark is claimed.
