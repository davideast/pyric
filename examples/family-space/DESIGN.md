---
name: Kin family space
description: A private family feed, calendar, and conversation space.
colors:
  primary: "#0659fd"
  primary-hover: "#034bda"
  canvas: "#f7f8fa"
  surface: "#ffffff"
  ink: "#1e1f20"
  muted: "#69727e"
  line: "#e7eaee"
  selected: "#e9f0ff"
  secondary: "#edf1f6"
  secondary-ink: "#334052"
  chat-header: "#24272c"
  chat-bubble: "#f2f4f7"
  pending: "#fff0d7"
  pending-ink: "#846022"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-1px"
  title:
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.5px"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "15px"
    lineHeight: 1.5
  label:
    fontSize: "13px"
    fontWeight: 600
  eyebrow:
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "2px"
rounded:
  tag: "6px"
  field: "10px"
  button: "11px"
  navigation: "12px"
  avatar: "13px"
  card: "18px"
  sheet: "24px"
spacing:
  compact: "8px"
  small: "12px"
  inset: "16px"
  medium: "20px"
  section: "24px"
  panel: "28px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.button}"
    padding: "11px 19px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-ink}"
    rounded: "{rounded.button}"
    padding: "11px 19px"
  navigation-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.primary}"
    rounded: "{rounded.navigation}"
    padding: "13px 12px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
  tag-pending:
    backgroundColor: "{colors.pending}"
    textColor: "{colors.pending-ink}"
    rounded: "{rounded.tag}"
    padding: "5px 9px"
---

# Design System: Kin family space

## Overview

**Creative North Star: "Private family space"**

Kin adapts the supplied mobile social dashboard into a private family space. White cards sit on a pale canvas; vivid blue carries navigation and actions, while real photographs provide warmth. Compact system typography keeps names, dates, and supporting context close to the content.

The charcoal chat header and overlapping white conversation sheet give messaging its own recognizable setting within the same system. Desktop adds a quiet navigation rail and family context; mobile retains the reference’s rounded blue bottom navigation.

This is a scan of the implemented example, grounded in `styles.css`, `ui.tsx`, and the app’s page components. The supplied Figma file and inspected nodes in `ASSETS.md` establish visual authority; desktop composition, calendar, and parent review are adaptations. The North Star is descriptive shorthand for the existing product purpose, not a separately approved creative direction.

**Key Characteristics:**
- White cards and inset rounded media on a pale canvas.
- Vivid blue actions and navigation, with restrained supporting neutrals.
- Compact system typography and real exported Figma photography.
- A charcoal header above the white chat sheet.

## Colors

The palette combines vivid navigation blue with cool paper-like neutrals. Frontmatter records the reusable values; CSS remains implementation truth.

### Primary

Primary blue marks calls to action, links, selected navigation, and the mobile navigation surface. Its deeper hover variant applies to primary buttons. The selected tint supports navigation and outgoing chat messages.

### Neutral

Canvas and surface separate the workspace from cards. Ink carries primary text; muted carries timestamps, labels, and supporting context. Line separates sections. Secondary and secondary ink support quiet actions. Chat header establishes the dark conversation surround, and chat bubble identifies received messages.

The pending pair is a semantic approval status, not an additional brand palette.

## Typography

All interface text uses the system sans-serif stack. Page headlines are compact and tightly tracked; card titles are smaller but retain strong weight. Body copy defaults to the body token and reduces to 14px at the mobile breakpoint. Feed descriptions use 14px with 1.7 line height; longer article content uses 16px with 1.85 line height, reducing to 14px on mobile.

Small metadata generally ranges from 10–13px. Eyebrows provide a spaced uppercase context label. The Kin wordmark uses the same family at 44px, weight 800, with -3px tracking; it is not a separate display font.

## Layout

The desktop shell has a maximum width of 1680px, a sticky 232px navigation rail, and a 124px top bar. The feed region uses a main column up to 660px and a supporting column with a 42px gap. Wide working views use a 1050px maximum container.

At 1450px and wider, spacing expands and the rail becomes 250px. At 1150px and below, spacing contracts. At 950px and below, the supporting column disappears and the feed uses a single column. At 680px and below, the rail becomes a toggleable drawer; fixed blue bottom navigation takes over. Main content has 16px side gutters and 110px bottom padding to remain clear of that navigation. Mobile forms collapse to one column; the week calendar becomes a vertical list while month retains seven columns.

Use the recurring 8, 12, 16, 20, 24, and 28px spacing steps for local grouping. Images are inset within feed cards, with object-fit cover. Chat messages scroll inside their sheet; the composer sits below that scrolling area.

## Elevation & Depth

Most depth comes from white surfaces, pale backgrounds, and thin borders. Ordinary cards have no shadow. A light shadow identifies the active calendar segment; the mobile navigation and open drawer use shadows to distinguish fixed layers. There is no general animation system in the current implementation. State changes are immediate; reduced-motion CSS preserves automatic scrolling.

## Shapes

Cards use broad 18px corners, inset media uses 11px corners, and fields use 10px corners. Avatars are rounded squares, with circular overlapping portraits reserved for the chat header. The chat sheet has 24px top corners over the dark surround. Chat bubbles leave a square upper corner toward their author; outgoing bubbles reverse that corner. Status tags remain compact and only gently rounded.

## Components

Primary and secondary buttons share 11px corners, 11px by 19px padding, weight 600, and a 44px minimum height before documented compact mobile variants. Hover changes the fill. Disabled buttons use half opacity. Keyboard focus uses a 2px primary-blue outline with a 4px offset.

Fields have a pale fill, thin cool-gray border, 13px by 15px padding, and a visible label. Textareas grow vertically. Desktop navigation uses a selected pale-blue row with blue text; mobile navigation uses white active labels against solid blue. Calendar segments use a white selected surface with blue text.

Feed cards combine an author row, optional status, inset media, title and excerpt, and a separated action row. Pending tags name the status explicitly. Calendar date tiles and event rows reuse the same selected tint. Chat uses grouped author context, asymmetrical message bubbles, and native audio/video controls; attachment and recording states appear above the composer.

The sidecar contains self-contained previews of observed primitives. These previews document appearance; they do not implement app authorization or messaging behavior.

## Do's and Don'ts

### Do:
- Do preserve the supplied Figma palette, rounded media, compact typography, and charcoal chat header.
- Do show pending approval with a textual status as well as the warm status tint.
- Do keep keyboard focus visible and preserve space for fixed mobile navigation.
- Do use the supplied asset provenance in ASSETS.md when extending imagery.

### Don't:
- Don’t replace family photographs with decorative generated artwork.
- Don’t add heavy shadows to ordinary feed cards.
- Don’t use the pending tint as a general brand accent.


## App activity

The Apps destination joins Family, Kid feeds (For you for kids), Schedule, and Chat in the five-column mobile bottom navigation. The existing desktop sidebar also includes Apps.

The activity view uses a white surface with an ordered series of expandable entries, separated by thin lines. Each entry pairs a Phosphor icon with a title and textual In progress, Complete, or Issue status. Context, response, tool, summary, result, and error entries have distinct icons; active entries use a spinner and errors use a red icon. Model responses expand onto a charcoal code surface; context and tool details use pale, wrapping, scrollable code blocks. Provider summaries and result/error explanations use wrapping prose. The heading carries the build state and a Stop build action while running; ready activity exposes Open app.

A fixed white progress bar with a thin border and rounded corners keeps the build title and latest event visible across navigation. Its status links back to activity, the latest event is announced politely, and a ready build adds Open app. Completed, failed, and stopped states expose a labelled dismiss button. On mobile, the bar sits above the blue bottom navigation with safe-area spacing; content gains bottom padding, and the runtime chip moves above the bar. Long titles truncate in the compact bar, with two-line wrapping at the narrowest breakpoint. Spinner motion is disabled when reduced motion is requested.
