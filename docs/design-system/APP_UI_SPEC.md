<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

> **This is OpenMasjidOS's spec, copied here verbatim — not ours to edit.**
>
> It governs the **admin panel** (`web/`), which a volunteer opens from the masjid's dashboard.
> It does not govern the rendered SCREENS (`server/src/render/`): those are a 1920×1080 SVG on a
> wall, not a web page in a browser chrome, and they have their own themes, their own contrast
> rules and their own tests.
>
> Local conformance notes, and what is deliberately not done, live in
> [`APP_UI_CONFORMANCE.md`](APP_UI_CONFORMANCE.md) beside this file. Fix the panel to match this; if this document and the
> panel disagree about what the PLATFORM does, the platform wins and the note belongs in the
> audit, not in edits here.

# OpenMasjid app UI/UX spec

**Who this is for:** anyone — human or agent — building an app that runs on OpenMasjidOS.
Your app is its own container with its own web UI, on its own port. This is how to make it
look and feel like part of the masjid's dashboard instead of a website they happened to open.

**Your app is not part of OpenMasjidOS.** You keep your own licence and your own stack. Nothing
here is enforced by the platform — it is enforced by masjids noticing that your app looks wrong.

**One test.** A volunteer opens your app from the dashboard. Nothing about the transition should
feel like leaving. Same colours, same corners, same type, same warmth of language.

---

## 1. Get the masjid's look at runtime — do not hardcode it

The admin chooses a theme, an accent colour and a wallpaper. **There are five accents and two
themes, so there are ten looks.** Hardcoding one means nine masjids in ten see the wrong app.

There are two ways in, and you should support both.

### 1a. The launch fragment (instant, no request)

When the dashboard opens your app it appends a URL fragment:

```
https://masjid.example/donations/#omos=eyJ2IjoxLCJ0aGVtZSI6ImRhcmsiLC4uLn0
```

It is **base64url of JSON**, and it is a fragment — never sent to a server, never logged.
Read it on first paint so there is no flash of the wrong theme.

```js
function omosAppearance() {
  const m = /[#&]omos=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return null;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  try { return JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch { return null; }
}
// { v: 1, theme: 'dark'|'light'|'system', wallpaper, wallpaperImage?, accent, lang }
```

Apps that ignore the hash simply look like themselves — it is additive, never required.

### 1b. The public endpoint (live, CORS-enabled)

```
GET {OPENMASJID_BASE_URL}/api/public/appearance
```

```json
{ "v": 1, "theme": "dark", "wallpaper": "aurora", "wallpaperImage": "",
  "accent": "cyan", "lang": "en", "logo": "/api/public/logo" }
```

`access-control-allow-origin: *` and `cache-control: no-store`, so your app's browser can poll
it and follow a theme change while open. `logo` is a **path** — resolve it against the same
origin you fetched appearance from. It is `""` when the masjid has set no logo; render their
name as a wordmark then, and never a broken image.

> **`OPENMASJID_BASE_URL` is injected into your container by the platform.** Never hardcode an
> address, and never assume `127.0.0.1` — inside a container that is *you*, not the platform.

**Apply the theme before first paint**, on the root element:

```html
<html data-theme="dark">
```

`theme: 'system'` means follow `prefers-color-scheme`. Resolve it yourself to `dark` or `light`
and write the resolved value, so every selector has one thing to match on.

---

## 2. Tokens

Define these as CSS custom properties and reference them everywhere. **Never write a raw hex in
a component.** Transcribed from `packages/ui/src/styles/tokens.css`.

```css
:root, [data-theme="dark"] {          /* DARK IS THE DEFAULT */
  --color-surface:         #030D1A;   /* page background */
  --color-surface-raised:  #0A1828;   /* cards */
  --color-surface-overlay: #0F2040;   /* menus, popovers */
  --color-surface-hover:   rgba(34, 211, 238, 0.07);

  --color-ink:       #F4F7FB;         /* body text */
  --color-ink-muted: #9FACC2;         /* secondary text */
  --color-ink-faint: #5C6B83;         /* hints, timestamps */
  --color-border:    rgba(148, 175, 210, 0.14);

  --color-primary:   #22D3EE;         /* OVERWRITTEN BY THE ACCENT — see §3 */
  --color-btn:       #22D3EE;         /* filled-button background */
  --color-on-primary:#00131C;         /* ink ON primary/btn */

  --color-accent:  #F59E0B;           /* warm accent, used sparingly */
  --color-success: #34D399;
  --color-warning: #FBBF24;
  --color-danger:  #F87171;
  --color-on-danger: #00131C;         /* dark ink: white on #F87171 is 2.77:1 */

  --radius-card:   1rem;              /* panels, dialogs, menus */
  --radius-button: 0.625rem;          /* controls */
}

[data-theme="light"] {
  --color-surface:         #F0F9FF;
  --color-surface-raised:  #FFFFFF;
  --color-surface-overlay: #E0F2FE;
  --color-surface-hover:   rgba(2, 132, 199, 0.06);

  --color-ink:       #0C4A6E;
  --color-ink-muted: #475569;
  --color-ink-faint: #94A3B8;
  --color-border:    rgba(2, 132, 199, 0.12);

  --color-primary:   #0284C7;
  --color-btn:       #0369A1;
  --color-on-primary:#FFFFFF;

  --color-accent:  #D97706;
  --color-success: #16A34A;
  --color-warning: #D97706;
  --color-danger:  #DC2626;
  --color-on-danger: #FFFFFF;         /* white passes here (4.83:1) */
}
```

Note `--color-on-primary` and `--color-on-danger`. **A filled button needs ink chosen for its
fill, not a fixed white.** Dark's danger is a light red; white on it measures 2.77:1, well under
AA — and that is the *delete* button. This cost us a real bug; do not repeat it.

---

## 3. The accent is the admin's choice, and it moves at runtime

`appearance.accent` is one of five. Each carries **its own ink**:

| id | primary | hover | onPrimary |
|---|---|---|---|
| `cyan` (default) | `#22D3EE` | `#67E8F9` | `#00131C` |
| `teal` | `#2DD4BF` | `#5EEAD4` | `#00201B` |
| `sky` | `#38BDF8` | `#7DD3FC` | `#001B2E` |
| `violet` | `#A78BFA` | `#C4B5FD` | `#190B3D` |
| `gold` | `#FBBF24` | `#FCD34D` | `#2B1B00` |

```js
const A = ACCENTS[appearance.accent] ?? ACCENTS.cyan;
const r = document.documentElement.style;
r.setProperty('--color-primary', A.primary);
r.setProperty('--color-btn', A.primary);
r.setProperty('--color-on-primary', A.onPrimary);   // ALWAYS together
```

**Set the ink in the same breath as the fill, or don't set either.** Setting only the fill is
how you get white text on gold at 1.67:1. In light mode the stylesheet's primary is a deep
blue with white ink; swapping in a bright accent without its ink breaks every button at once.

---

## 4. Type

```css
--font-sans:    "Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
--font-display: "Space Grotesk Variable", "Space Grotesk", var(--font-sans);
```

Display face for headings only; body in the sans. **Self-host both** (see §8 — no CDNs).

**`font-variant-numeric: tabular-nums` on every prayer time, countdown, money amount and
counter.** Proportional digits make a clock jitter as it ticks.

---

## 5. Surfaces, spacing, motion

- Panels: `--color-surface-raised`, `border-radius: var(--radius-card)`, a 1px `--color-border`.
- Controls: `--radius-button`.
- The dashboard uses a frosted-glass treatment. **You do not have to copy it** — a solid
  `--color-surface-raised` panel sits beside it perfectly well, and `backdrop-filter` is the
  single most expensive thing you can put on a Raspberry Pi. If you do use it, keep it to one
  layer and never nest it.
- **Spring physics, not linear easing.** Cards lift on hover, buttons press.
- Skeleton shimmer while loading, never a bare spinner.
- Stagger a grid's entrance on first mount — **not on every data refresh.** Prayer times
  re-render every minute; if they re-animate each time the screen never settles.

---

## 6. Right-to-left is not optional

Arabic and Urdu are first-class. **Use logical properties everywhere.** This is the single
easiest thing to get wrong and the single easiest to prevent.

| Never | Always |
|---|---|
| `margin-left` / `padding-right` | `margin-inline-start` / `padding-inline-end` |
| `left:` / `right:` | `inset-inline-start` / `inset-inline-end` |
| `text-align: left\|right` | `text-align: start\|end` |
| `border-left` | `border-inline-start` |
| Tailwind `ml-* pl-* left-* text-left border-l` | `ms-* ps-* start-* text-start border-s` |

**`transform: translateX()` is physical and has no logical form.** If you move something along
the inline axis, flip its sign under `[dir="rtl"]`. A toggle whose thumb travels with
`translateX(+1.2rem)` walks straight out of its own track in Arabic — that shipped here, in two
separate components, before a test caught it.

Set `dir` on the root from `appearance.lang`. Test by forcing `dir="rtl"` and looking.

---

## 7. Accessibility

- **WCAG AA in both themes.** Check ink on *filled* elements specifically — that is where it
  fails, and a delete button is the worst place for it to.
- Everything reachable and operable by keyboard. Visible focus:
  `outline: 2px solid var(--color-primary); outline-offset: 2px`.
- Dialogs trap focus, close on Escape, and **return focus to whatever opened them**. Prefer a
  real primitive (Radix, or your framework's) over hand-rolling this — every hand-rolled one we
  have audited was missing at least two of the three.
- **Honour `prefers-reduced-motion` unconditionally.** Collapse to instant or opacity-only. Not
  a setting, not a toggle — the OS already told you.
- Live regions for anything that changes on its own (a prayer time rolling over).

---

## 8. Constraints that come from where this runs

- **No CDNs. None.** Fonts, icons, scripts, analytics. A masjid may be LAN-only with no route
  to the internet at all, and the dashboard itself ships zero external requests. Bundle it.
- **A Raspberry Pi is a target, not an edge case.** Lazy-load heavy routes. Watch your bundle.
  Continuous GPU animation and stacked `backdrop-filter` are what kill these boxes.
- **Multi-arch image, `amd64` + `arm64`.** An arm64-less image cannot be installed on a Pi.
- **Publish your web port** in your compose file — the platform reads it to build the "Open" link.
- **Never write into another app's data**, and never mount the Docker socket. The install-time
  gate refuses both outright, and no amount of agreeing will change it.

---

## 9. Voice — the part most apps get wrong

**Your user is a masjid volunteer, not a sysadmin.** Often a trustee in their sixties doing this
on a Sunday. Write for them.

| Don't | Do |
|---|---|
| "Deploy container" | "Install" |
| "Exited (0)" / "SIGTERM" | "This app isn't running" |
| "Invalid input at field 3" | "That date doesn't look right — try 12/04/2026" |
| "Operation failed" | "We couldn't save that. Check your internet and try again." |

- Errors say **what happened and what to do next**, in one or two sentences.
- **Never show a raw stack trace.** Log it; show a tidy message with a "view technical details"
  expander if someone needs it.
- Say what a button will do: "Send receipts", not "Submit".
- Never report success you cannot verify. "Queued to send" is honest; "Sent" is a claim about
  something you did not watch happen. This project has been bitten by exactly that wording.

---

## 10. Dates, times, money, names

- **Show Hijri and Gregorian together** wherever a date appears.
- Prayer and iqamah times in `tabular-nums`; respect the masjid's 12h/24h choice.
- **Never assume the browser's locale is the masjid's.** Take the timezone from your own
  settings, not from the device — a trustee checking on holiday must not see shifted times.
- Money via `Intl.NumberFormat` with the masjid's currency. **Never hardcode `$`.** Mind
  zero-decimal and three-decimal currencies (JPY, KWD): dividing minor units by 100 regardless
  misreports a Gulf masjid's KWD by 10×.
- Render names as given. Do not title-case, truncate or transliterate them.

---

## 11. Religious content — read this before you decorate

- **Do not put Quranic verses or sacred Arabic text into decorative chrome** — loading
  spinners, empty states, watermarks, throwaway UI. If sacred text appears it must be
  intentional, correct, complete and dignified. When unsure, ask the masjid; do not improvise.
- Decoration means **geometric and architectural** motifs: girih tessellation, arches, domes,
  minarets, the crescent.
- **No figurative or human imagery** in default assets, illustrations or empty states.
- Bundle a proper Naskh face for Arabic. Do not let it fall back to a system serif.

---

## 12. Your app owns its own settings

The platform holds **no masjid profile** and never will. Location, calculation method, Asr
madhab, timezone, masjid name — all of it is **yours**, collected by your own `settings:` block
at install and stored by you.

Do not ask the platform for it, and do not expect it to be injected. Two apps needing the same
fact both ask for it; that is the design, not an oversight.

---

## Checklist

Before you call an app done:

- [ ] Reads the launch fragment, and applies the theme **before first paint**
- [ ] Polls `/api/public/appearance`, or at minimum re-reads on focus
- [ ] All five accents look right, in **both** themes — including the ink on filled buttons
- [ ] `dir="rtl"` renders correctly; no physical properties; `translateX` signs flipped
- [ ] AA contrast measured, not eyeballed, in both themes
- [ ] Keyboard-complete; dialogs trap focus and return it
- [ ] `prefers-reduced-motion` kills every animation
- [ ] Zero external network requests in the built output
- [ ] Multi-arch image; web port published
- [ ] Hijri + Gregorian; `tabular-nums`; `Intl.NumberFormat` for money
- [ ] Every string readable by a volunteer, with no jargon and no raw errors
- [ ] No sacred text used as decoration

---

## Reference

- `docs/APP_MANIFEST_SPEC.md` — the catalogue contract and the Fabric (SSO, email, alerts,
  WhatsApp, app-to-app calls)
- `docs/FABRIC_APP_LINK_AND_TUNNEL.md` — app-to-app calls and per-app internet exposure
- `docs/design-system/CONSUMING.md` — for apps that are themselves React and want the
  platform's own components rather than matching them by hand
