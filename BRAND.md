# walfly — Brand Guidelines

> *"The moments you were there for."*

---

## 1. Brand Story

walfly is a passive conversation recorder. It sits quietly in your pocket and captures the meetings, ideas, and conversations you're part of — the ones you want to remember but won't.

The name comes from "a fly on the wall." Not a spy. A witness. **You** are the fly. walfly is your companion.

The central metaphor is **amber** — the fossil resin that preserves creatures, including flies, for millions of years. A moment captured in walfly is like a fly in amber: permanent, warm, golden. Every recording is a piece of time made tangible.

The brand voice is **quiet confidence** — unhurried, personal, warm. Never cold or technical. Never invasive or surveillance-adjacent. walfly is for your moments, not anyone else's.

---

## 2. Name & Tagline

| | |
|---|---|
| **App name** | `walfly` — always lowercase in display contexts |
| **Legal / App Store** | `Walfly` — sentence-case only where required |
| **Tagline** | *The moments you were there for.* |
| **Never use** | "spy", "surveillance", "eavesdrop", "secretly", "hidden" |

The lowercase name follows modern app conventions (notion, figma, linear). It reads approachable and modern, not corporate.

---

## 3. Color Palette

The palette is dark-first. Amber on Midnight. Every color has a role.

### Core

| Token | Hex | Role |
|---|---|---|
| `midnight` | `#0D0D0F` | Primary background — the darkest surface, like night |
| `obsidian` | `#141416` | Surface / card background |
| `charcoal` | `#1E1E22` | Elevated surface — inputs, modals, raised cards |
| `border` | `#2A2A2F` | Subtle dividers and stroke outlines |

### Amber — the brand accent

| Token | Hex | Role |
|---|---|---|
| `amber` | `#F5A623` | Primary accent — record button, tint, highlights |
| `amberDim` | `#C4801A` | Pressed state, secondary amber |
| `amberGlow` | `#F5A62326` | Glow rings, halos, shadows |
| `amberSubtle` | `#F5A62312` | Badge fills, tinted backgrounds |

Amber was chosen because it is **warm, not dangerous** — it reads as golden and inviting, not as an alert or error. It directly references the amber fossil metaphor.

### Text

| Token | Hex | Role |
|---|---|---|
| `cream` | `#F5EDD6` | Primary text on dark — warm, not harsh white |
| `mist` | `#9B9AA3` | Secondary / muted text, labels |
| `fog` | `#55545D` | Placeholder text, disabled states |

Cream instead of pure white keeps the dark palette warm and prevents eye strain on OLED screens.

### Status

| Token | Hex | Role |
|---|---|---|
| `success` | `#4CAF7D` | Ready state, completion |
| `successSubtle` | `#4CAF7D18` | Success badge fill |
| `error` | `#FF5757` | Error state, failed recordings |
| `errorSubtle` | `#FF575718` | Error banner fill |
| `warning` | `#F5A623` | Reuses amber — keeps the palette coherent |

### Light Mode

Light mode inverts the warmth: background becomes `#FAF6EF` (warm parchment), surface becomes `#FFFFFF`, text becomes `#1A1A1C`. Amber accent stays unchanged — it works equally well on light and dark.

### Usage rules

- **Never** use pure `#000000` black as a background — use `midnight`.
- **Never** use pure `#FFFFFF` white as foreground text — use `cream`.
- Amber is an accent. Do not use it as a large background fill.
- Status colors (success, error) are for state only — not decoration.

---

## 4. Typography

Two fonts. Both loaded via `expo-font` / `@expo-google-fonts`.

### Playfair Display — display & headings

**Source:** [Google Fonts — Playfair Display](https://fonts.google.com/specimen/Playfair+Display)
**Weights used:** 600 SemiBold, 700 Bold

Playfair Display is a high-contrast transitional serif with classical proportions and strong editorial presence. It is used for:
- App wordmark (`walfly`)
- Screen titles (`moments`, `chat`, `record`)
- Recording card titles in the list
- Summary headings in recording detail

**Why Playfair Display:** It conveys timelessness and warmth — the feeling of a journal, a letter, something worth keeping. It is the "amber" of the type system.

**Fallback:** `Georgia, serif`

### Inter — body & UI

**Source:** [Google Fonts — Inter](https://fonts.google.com/specimen/Inter)
**Weights used:** 400 Regular, 500 Medium, 600 SemiBold

Inter is used for all body text, labels, metadata, badges, inputs, and captions. It is optimised for screen legibility and feels native on iOS and Android.

**Why Inter:** Maximum readability, neutral, widely recognised. It never competes with Playfair Display — it supports it.

**Fallback:** `-apple-system, system-ui, sans-serif`

### Type scale

| Token | Font | Weight | Size | Use |
|---|---|---|---|---|
| `display` | Playfair Display | 700 | 36px | App wordmark, major display text |
| `title` | Playfair Display | 600 | 28px | Screen headers, card titles |
| `headline` | Inter | 600 | 20px | Section headers |
| `md` | Inter | 500 | 17px | Primary UI labels |
| `base` | Inter | 400 | 15px | Body text |
| `sm` | Inter | 400 | 13px | Secondary labels, captions |
| `xs` | Inter | 400 | 11px | Badges, micro-labels |

### Letter spacing

- Wordmark / display (`walfly`): `letterSpacing: 2`
- Status labels and taglines: `letterSpacing: 0.5`
- All other text: default (0)

### Line height

- Tight (headings): `1.2`
- Body copy: `1.5`
- Chat messages: `1.45` (21–22px at 15px size)

---

## 5. The Fly Icon

The fly is the brand's primary visual element. It is **not a mascot**. It is a refined, abstract mark.

### Form

- Two symmetrical wing shapes — simple, geometric ovals or rounded polygons
- A small oval body centered below the wings
- No legs, no antennae, no detail lines
- Single color on a single background — never multi-color, never gradients
- Silhouette only — the shape must read at 16px and at 512px equally

### Color usage

| Context | Icon color | Background |
|---|---|---|
| App icon | `amber` `#F5A623` | `midnight` `#0D0D0F` |
| Tab bar (SF Symbol) | System tint via `DynamicColorIOS` | Liquid Glass (system) |
| Splash screen | `cream` `#F5EDD6` | `midnight` `#0D0D0F` |
| Light mode UI | `amberDim` `#C4801A` | Light background |

### Rendering mode

On iOS tab bars, icons are rendered as SF Symbols (system-provided glyphs for `mic`, `square.stack`, `bubble.left`). Custom fly icons use `renderingMode: "template"` so the system tint applies. For the record button inner indicator, a plain `View` with `borderRadius` animates between circle (idle) and rounded-square (recording — "stop" affordance).

### What the icon communicates

- **Wings open** = listening, present, alive
- **Wings closed / resting** = idle, safe, private
- **Amber color** = warmth, preservation, the fossil metaphor
- **Abstract geometry** = modern, minimal, not threatening

### What the icon must never be

- Cartoony or expressive (no face, no emotion)
- Detailed or realistic (no hair, legs, or compound eyes)
- Associated with dirt, disease, or nuisance (it is a *companion*, not a pest)

---

## 6. Spacing System

4-point base grid.

| Token | Value | Use |
|---|---|---|
| `px` | 1px | Hairline borders |
| `xxs` | 4px | Icon gaps, micro-spacing |
| `xs` | 8px | Component internal padding |
| `sm` | 12px | Dense component padding |
| `md` | 16px | Standard screen padding |
| `lg` | 24px | Section gaps |
| `xl` | 32px | Screen-level vertical rhythm |
| `xxl` | 48px | Large section breaks |
| `3xl` | 64px | Hero spacing |

Screen horizontal padding: always `spacing.md` (16px).

---

## 7. Shape & Radius

| Token | Value | Use |
|---|---|---|
| `sm` | 6px | Badges, small chips |
| `md` | 12px | Cards, inputs, search bars |
| `lg` | 18px | Large cards, bottom sheets |
| `xl` | 24px | Message bubbles |
| `full` | 9999px | Pills, circular buttons |

---

## 8. Shadows & Elevation

Three shadow levels, all using the amber color for glow:

| Token | Color | Blur | Use |
|---|---|---|---|
| `sm` | Black | 4px | Subtle card lift |
| `md` | Amber | 12px | Record button resting state |
| `glow` | Amber | 20px | Record button active / recording state |

---

## 9. Motion Principles

- **Purposeful** — every animation communicates state, not decoration
- **Subtle** — duration 600–800ms, ease in-out, no bounce on functional UI
- **Respectful** — all animations check `AccessibilityInfo.isReduceMotionEnabled` and skip or substitute a static state change
- **Native driver** — all `Animated` calls use `useNativeDriver: true`

### Key animations

| Moment | Animation |
|---|---|
| Recording starts | Amber glow ring fades in + scales 1.1 → 1.55, looping 800ms |
| Recording button | Opacity 1.0 → 0.7, looping 800ms pulse |
| Button inner | Morphs from 28px circle to 22px rounded-square (stop affordance) |
| Card press | Opacity → 0.75 on press, instant |
| List load | Future: stagger entry from bottom, 40ms delay per item |

---

## 10. Voice & Tone

| Principle | Do | Don't |
|---|---|---|
| **Lowercase confidence** | `tap to begin` · `your moments` · `saved` | `TAP TO RECORD` · `No Recordings Yet.` |
| **Personal, not corporate** | `the moments you were there for` | `Audio Recording Application` |
| **Warm, not technical** | `moments` (tab label) · `thinking…` | `My Recordings` · `Processing request` |
| **Honest, not hyped** | `something went wrong · tap to try again` | `Oops! Something went terribly wrong!` |
| **Brief** | One line. Always. | Paragraphs in UI |

### UI copy rules

- All UI labels, tab names, button labels: **lowercase**
- Status text: sentence fragment, no period, lowercase (`uploading…`)
- Error messages: plain, direct, one actionable hint below (`tap to try again`)
- Empty states: describe what's missing + a single next action
- No emoji in UI text (exception: future if brand evolves)

---

## 11. Screen-by-Screen Principles

### Tab 1 — record
The most important screen. One job: start and stop a recording. Nothing else competes for attention. Full `midnight` background. Single button centered. Wordmark `walfly` in Fraunces above. State label below in `mist`. **Zero clutter.**

### Tab 2 — moments
The library. Cards on `midnight`, each card `obsidian` with a 3px left accent bar colored by status (amber = in progress, green = ready, red = failed). Fraunces card titles. Compact metadata row in `mist`. Dark search bar. No horizontal rules or dividers between cards — card borders do the work.

### Tab 3 — chat
Dark always — chat is intimate and focused. Amber user bubbles (`amberDim`), dark assistant bubbles (`charcoal` with `border` stroke). Scope chip at top tells the user what context the AI has. Amber send button. Streaming dot (6px amber circle) replaces spinner.

### Recording Detail
(In progress — `walfly-dpm.5`.) Principles: Fraunces for the title (editable inline), summary in a soft `obsidian` card, takeaways as amber-dotted chips, transcript in monospace with timestamp markers, amber underline on active edit fields.

---

## 12. Implementation Reference

All tokens live in [`apps/mobile/lib/theme.ts`](apps/mobile/lib/theme.ts).

Fonts are loaded in [`apps/mobile/app/_layout.tsx`](apps/mobile/app/_layout.tsx) via `useFonts` from `@expo-google-fonts/fraunces` and `@expo-google-fonts/inter`. The splash screen is held until fonts resolve.

Native tabs are configured in [`apps/mobile/app/(tabs)/_layout.tsx`](apps/mobile/app/(tabs)/_layout.tsx) using `NativeTabs` from `expo-router/unstable-native-tabs` (SDK 56). `ThemeProvider` with `DarkTheme` ensures Liquid Glass on iOS 26 derives from dark content.

---

## 13. What We Are Not

| ✗ Not this | ✓ This instead |
|---|---|
| A spy app | A personal companion |
| Surveillance technology | Memory assistance |
| Cold / clinical | Warm / editorial |
| Feature-heavy | Radically simple |
| Loud, aggressive UI | Quiet confidence |
| Generic recorder | The fly on your wall |

---

*walfly brand guidelines — living document. Update when decisions change in beads.*
