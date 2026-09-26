<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Where this app stands against the platform's app spec

Companion to [`APP_UI_SPEC.md`](APP_UI_SPEC.md), which is OpenMasjidOS's document and is not
ours to edit. This one is ours: it records what the control panel does, what it deliberately
does not, and — where a rule is the kind that silently comes undone — which test holds it.

**Scope.** The spec governs `web/`, the panel a volunteer opens from the dashboard. It does not
govern `server/src/render/`, the 1920×1080 SVG on the masjid's wall: that is not a web page in
browser chrome, it has its own ten themes, and its contrast rules live in
`server/src/render/simpleColours.test.ts`.

## The checklist

| Spec | State | Held by |
|---|---|---|
| Launch fragment, applied before first paint | Yes — `readOmosFragment` in `prefs.ts`; `index.html` ships `data-theme="dark"` so there is no flash | — |
| Polls `/api/public/appearance` | Yes — `fetchOmosAppearance`, gated on `followOmos` | — |
| All five accents, both themes, including ink on fills | Yes — `omosAccents.ts` + `applyAccent` | `panelContrast.test.ts` |
| `dir="rtl"`; no physical properties; `translateX` flipped | Yes — `applyLang`; zero physical inline properties | `panelSpec.test.ts` |
| AA measured, not eyeballed, in both themes | Yes | `panelContrast.test.ts` |
| Keyboard-complete; dialogs trap and return focus | Yes — `Modal` in `ui.tsx` traps Tab, closes on Escape, restores the opener | — |
| `prefers-reduced-motion` kills every animation | Yes — a blanket `*` rule in `tokens.css`, plus per-component rules | — |
| Zero external network requests | Yes | `panelSpec.test.ts` |
| Multi-arch image; web port published | Yes — `docker-compose.yml`, `build-image.yml` | `checks.yml` |
| Hijri + Gregorian; `tabular-nums` | Yes on both the panel clock and the screens | — |
| `Intl.NumberFormat` for money | N/A — this app handles no money | — |
| Volunteer-readable strings, no raw errors | Ongoing; no stack traces are surfaced | — |
| No sacred text as decoration | Yes — the decoration is geometric (`khatam`, the dome mark) | — |

## What was found when this was first measured

Three of these were not passing, and none of them looked wrong in the source:

- **`color: #fff` on four filled elements.** `.btn--danger` measured **2.77:1** — the button that
  deletes a masjid's timetable. There was no `--color-on-danger` token at all. The other three
  were white on `--color-primary`.
- **`--color-primary` was being used as both a fill and a letterform.** In light theme white on
  it measured **4.10:1**, under AA, on every chip, day-grid cell, active tab and PIN key. Fills
  now take `--color-btn` (which is what that token is for) and `--color-primary` is text only.
- **The accent was never read.** `appearance.accent` was ignored, so four masjids in five saw a
  colour they had not chosen. Adopting it then exposed the same fill/text split from the other
  side: the raw accents measure 1.67:1 (gold) to 2.72:1 (violet) as text on a light card.

## Deliberate deviations

- **The type is a system stack, not self-hosted Inter and Space Grotesk.** §4 asks for both, and
  §8 forbids a CDN, which together mean vendoring two font binaries. `--font-sans` /
  `--font-display` resolve to the platform stack the spec's own fallback chain ends in, so the
  panel is close but not identical. Vendoring the two faces is the outstanding half of §4 and
  needs the licence files alongside them.
- **`appearance.logo` is not adopted.** It is a path to the *platform's* logo, and this app
  already shows the masjid's own uploaded logo from its own settings (§12 — an app owns its own
  settings). Taking both would show one masjid two marks for the same building.
- **The panel offers no accent picker.** The accent is the admin's choice on the dashboard; this
  app follows it and does not add a second place to set it. The theme and wallpaper pickers under
  Settings predate this and stay, because a screen can be set up by someone who never opens the
  dashboard.
- **`--color-primary-subtle` is recomputed from the accent** rather than left at the theme's
  cyan, so an accent-tinted background matches the accent-coloured text sitting on it.

## Not yet verified

- **RTL has been implemented but not looked at.** Every mechanical check passes — no physical
  properties, the toggle's `translateX` is mirrored, `dir` is set from the dashboard's language —
  and the spec is explicit that the remaining step is to force `dir="rtl"` and look at it. Nobody
  has yet.
