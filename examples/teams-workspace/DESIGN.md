---
name: Teams workspace
description: A charcoal collaboration workspace adapted from the user's Brainwave reference frames.
colors:
  primary: "#3984fa"
  primary-hover: "#5798ff"
  focus: "#91baff"
  canvas: "#101415"
  conversation: "#232728"
  context: "#202526"
  composer: "#202425"
  selected-nav: "#303638"
  secondary: "#353d41"
  line: "#343839"
  text: "#f0f1f2"
  message-text: "#d5dadc"
  muted: "#a4aaae"
  online: "#88cba9"
  away: "#d9ad6c"
  error: "#f0b5ae"
typography:
  title:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: "17px"
    fontWeight: 600
    letterSpacing: "-0.025em"
  body:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: "13px"
    lineHeight: 1.7
  label:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: "11px"
rounded:
  control: "6px"
  navigation: "7px"
  composer: "9px"
  dialog: "12px"
  shell: "13px"
spacing:
  compact: "8px"
  standard: "12px"
  section: "24px"
  content: "30px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    rounded: "{rounded.control}"
    width: "30px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    rounded: "{rounded.control}"
    padding: "9px"
  navigation-selected:
    backgroundColor: "{colors.selected-nav}"
    rounded: "{rounded.navigation}"
    padding: "11px 12px"
  composer:
    backgroundColor: "{colors.composer}"
    rounded: "{rounded.composer}"
---

# Design System: Teams workspace

## Overview

Visual authority remains the user-supplied Brainwave AI UI Kit frames: 196:6482, 295:51668, 422:176199, 422:176189, 299:54916, 422:188334, 422:188342, 422:188341, and 200:9026. This is an operate-mode adaptation of those frames into human team collaboration. The values below record the implemented example in `workspace.css` and `workspace.tsx`; they are not claims of exact Figma token extraction.

The established character is compact, charcoal, and restrained. Near-black navigation supports a lighter conversation surface and a contextual rail. Portraits, small line icons, and quiet metadata give activity a human scale. Product assumptions remain recorded in `PRODUCT.md`; the first surface's composition is recorded in `SURFACE.md`.

**Key Characteristics:**

- Tonal charcoal surfaces with subtle separators.
- Small, readable collaboration content and compact controls.
- Blue reserved for primary action and selected feedback.
- Context revealed explicitly as space becomes scarce.

## Colors

Primary blue identifies the send action; its brighter hover color communicates interactivity. The focus color identifies keyboard position independently of hover.

Neutral canvas, conversation, context, and composer tokens establish depth. The line token divides persistent regions. Main text carries headings, message text carries conversation, and muted text carries supporting descriptions.

Online green, away amber, and error rose communicate state. Presence includes adjacent text in the team list. Content previews can carry their own palette; the seeded mint artwork is an attachment, not a global surface color.

**The Quiet Accent Rule.** Keep broad surfaces neutral and place color on actionable controls, identity markers, and meaningful state.

## Typography

Use an independent Inter/system sans-serif stack. The interface has no display-heading tier. Channel titles use the title role; message paragraphs use the body role; metadata uses compact labels, generally between 10px and 12px. Author names are semibold. The brand wordmark is a separate 26px, bold treatment.

At the wide breakpoint message text grows to 14px. At the phone breakpoint the channel title becomes 15px. Preserve generous message line height and allow long content to wrap.

## Layout

The implemented desktop shell fills the dynamic viewport height, with 12px outer padding and a maximum width of 1800px. Its columns are 236px navigation, a flexible conversation with a 420px minimum, and a 284px contextual rail. Conversation and context share a 91px header alignment. The message list scrolls independently above a persistent composer.

At widths of 1500px and above, outer columns expand to 260px and 320px, with more conversation padding. At 1100px and below, the rail is hidden until opened as a 310px overlay. At 680px and below, the conversation fills the viewport, navigation opens as a 245px drawer, and context opens as a full-screen panel. Member stacks disappear from the narrow header.

**The Explicit Context Rule.** Open navigation and context on demand at small widths; do not compress three desktop columns into a phone viewport.

## Elevation & Depth

Persistent desktop surfaces use tonal layering and thin borders, without card shadows. Shadows separate overlays: search uses `0 18px 60px #0008`, the contextual overlay uses `-12px 0 50px #0005`, and mobile navigation uses `14px 0 60px #0009`. Search additionally dims the background.

Search enters with a 150ms ease-out vertical reveal only when reduced motion is not requested. Other controls use immediate color feedback.

## Shapes

Controls have gently rounded corners; composers and dialog surfaces are softer. Joined conversation and context surfaces round only the outer shell corners on desktop. The phone conversation is edge-to-edge and square. Avatars and presence indicators are circular, while channel identity marks are small rounded squares.

## Components

- **Primary and icon buttons:** the compact blue send control uses the primary component token. Utility icons sit in 32px neutral targets and gain a tonal background on hover. Disabled buttons reduce opacity to 0.45. Keyboard focus uses a 2px outline with a 3px offset.
- **Navigation:** compact icon-and-label rows, a tonal selected background, brighter selected icon, and separate grouped channels. Channel selection and global navigation retain distinct active treatments.
- **Composer:** an outlined dark field with a 65px textarea, lower attachment/send toolbar, optional file chip, and inline error text. It anchors the conversation and is reused within threads.
- **Messages:** circular portrait, author/time byline, wrapping prose, and small reaction/thread actions. Reactions gain a muted blue selected treatment. Messages are rows, not individual cards.
- **Attachments:** an outlined rounded row with file icon, filename, and secondary metadata. Rich seeded artwork is a separate content preview.
- **Team context:** portrait rows with presence dots and status text, followed by a channel description. Threads, files, and scenarios reuse the contextual panel.
- **Search:** a focused native dialog with a separated search field, scrolling result rows, and empty-state text. Width is capped at 560px and 90vw.

## Do's and Don'ts

- Do preserve the Brainwave reference authority when extending this example.
- Do reuse tonal layers, compact typography, and visible keyboard focus.
- Do keep attachment artwork visually distinct from the application shell.
- Don't introduce landing-page hero composition or dashboard KPI cards into this workspace.
- Don't squeeze desktop navigation and context into a three-column phone layout.
- Don't promote provisional product assumptions into confirmed requirements.

## Authentication and mobile header

Signed-out visitors see the two-column authentication screen inspired by frame 196:6482. On mobile the workspace header is a 32px / flexible / 32px grid, with 12px gaps and a single-line truncated description. Authentication and impersonation are separate: the app offers sign-in/sign-out; the injected chip offers developer identity controls.
