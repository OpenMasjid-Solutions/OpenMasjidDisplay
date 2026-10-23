<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# What a frame costs, measured

Every screen this app drives — a decoder box, a browser screen, a Raspberry Pi — is drawn by the
same renderer: `renderDisplaySvg()` builds an SVG and resvg rasterises it. That rasterisation is
the single largest CPU cost in the product, so this is where it goes.

**All figures are p50 of 10–15 runs.** The Pi figures were taken on a **Raspberry Pi 4 Model B
Rev 1.2** with the screen agent **stopped** — an earlier set taken with it running was wrong by up
to ±40 ms and pointed at the wrong culprit, which is why that detail is here rather than implied.

---

## Where a frame actually goes

A 1080p Modern timetable, to raw pixels:

| | Pi 4 | desktop |
| --- | --- | --- |
| build the SVG string | <1 ms | 0.6 ms |
| parse it (no fonts) | 1.7 ms | 0.2 ms |
| build the font database | **140 ms** | 42 ms |
| rasterise | **403 ms** | 56 ms |
| **whole frame** | **558 ms** | 103 ms |

Two things dominate, and neither is the SVG.

---

## 1. The font database is rebuilt on every single frame

`new Resvg(svg, { font })` constructs a font database from scratch each time, and there are as
many constructions as there are frames. On a Pi that is **140 ms a frame for a set of files that
never changes** — a quarter of the frame.

It is *not* the number of files, and that is worth knowing because the obvious fix does not work:

| curated set | bytes | DB build | pixels identical? |
| --- | --- | --- | --- |
| all 5 (today) | 2510 KB | 140 ms | — |
| drop DejaVuSans + Noto Naskh | 1596 KB | 140 ms | yes |
| Amiri only | 592 KB | **178 ms** | **no** |

Dropping 914 KB changed the cost by nothing, and cutting to one face made it *slower* while
changing what was drawn. So trimming the list is not the lever.

The cost tracks font **complexity**, roughly 0.14 ms/KB with a large fixed floor:

| one file | size | DB build |
| --- | --- | --- |
| NotoSansLycian | 4 KB | 10 ms |
| NotoSansAvestan | 22 KB | 13 ms |
| NotoSansGeorgian-Bold | 54 KB | 18 ms |
| NotoSansSignWriting | 5089 KB | 1431 ms |

**So the fix is subsetting, and it is not free.** A face carrying only the glyphs a timetable can
draw would cost ~10–15 ms instead of 140 ms — around **125 ms a frame on a Pi**. What stops it
being done here and now:

- **resvg-js 2.6.2 offers no way to reuse a font database** between instances (checked: the whole
  `font` option is file paths and family names, and 2.6.2 is the latest published). So the saving
  has to come from the files themselves.
- **A missing glyph is tofu on a masjid's wall**, and `golden.test.ts` pins the SVG, not the
  pixels, so it would not catch one. Any subsetting needs a pixel-equivalence test over the golden
  fixtures first — the same method used for the table above, which is cheap to automate.
- **Amiri is OFL with a reserved font name.** A subset is a modification, so it must be renamed
  and carry its licence. That is a licensing step, not a build step.

Until then the floor stands: **no frame on a Pi can cost less than ~142 ms**, whatever else
changes.

---

## 2. Gradients are most of the rasterisation, and only the Modern design pays

Replacing every gradient fill with a flat colour, desktop, Modern 1080p:

```
  whole frame            57.9 ms
  gradients -> flat       8.8 ms      -85%
  opacity attrs removed  56.4 ms       -3%   (not the cause)
```

The Modern layout paints **three full-canvas 1920×1080 fills** — `#scene` (a radial gradient at
r=130%), `#cglow` (r=60%), and `#khatam` (a 58×58 pattern, so ~617 tiles of two stroked paths at
5% opacity) — plus ten `#sheen`/`#litsheen` panel overlays. Sixteen gradient fills, several of
them the whole screen, layered.

Removing any one of scene / cglow / khatam / sheen / litsheen saves 8–11 ms each on the desktop,
which is the 49 ms between them. There is no single culprit to delete.

**The Simple layout references none of them.** That is the whole of the 11× gap:

| | Pi 4, no fonts | Pi 4, with fonts |
| --- | --- | --- |
| Modern 1080p | 403 ms | 558 ms |
| Simple 1080p | **37 ms** | 163 ms |

So a masjid on the Simple design already gets a frame that costs a quarter of Modern's.

**The fix is to stop repainting a background that does not change.** `#scene`, `#cglow` and
`#khatam` depend on the theme, the accent and the sun's position — things that change over
minutes, not per second. Rendering them once and compositing the foreground over them would take
Modern on a Pi from ~558 ms toward ~215 ms. It needs a `layer` option on the renderer (there is
precedent: `tickerBandOnly` already renders a subset) and a composite step, and the Pi already
converts RGBA→RGB565 in a per-pixel loop that a composite could fold into at near-zero extra cost.

Not attempted here: it is a change to what every screen draws, and it wants the pixel-equivalence
harness in place first for exactly the reason the font work does.

### An unused-defs red herring

The Simple layout emits all 11 gradient definitions and the pattern in `<defs>` and uses none of
them. That looks like obvious waste and is not: resvg does not rasterise an unreferenced def, and
parsing the whole SVG without fonts costs 1.7 ms on a Pi. Removing them would buy single-digit
*micro*seconds and couple `defs()` to the layout. Left alone deliberately.

---

## 3. Ruled out, with the measurement

Recorded so the work is not done twice.

**Trimming the curated font list — no.** Dropping DejaVuSans and Noto Naskh removes 914 KB and
changes the DB build by nothing (140 ms either way), and the pixels are identical, so those two
faces are already contributing nothing to cost. Cutting to Amiri alone made it *slower* (178 ms)
and changed what was drawn. The cost is not the list.

**Memoising the frame — no.** `Screen.show()` could skip the whole render when the SVG is
byte-identical to the last one, which would be exactly safe. It would never fire: over 119
consecutive seconds the SVG changed on **all 119**, in every layout and with the seconds display
both on and off.

- Simple changes because the countdown is MM:SS. That is the feature working.
- Modern changes because of that *and* decorative scene dots whose radius is recomputed from the
  timestamp — `r="6.9"` becoming `r="6.8"`. A full 1080p frame, 403 ms of rasterisation on a Pi,
  partly to move a dot by a tenth of a pixel.

  Quantising that animation would not help on its own while a seconds-level countdown is on the
  screen, so it is not worth doing for speed. It is noted because it is the only part of the
  per-second churn that buys the viewer nothing.

**`textRendering` / `shapeRendering: optimizeSpeed` — no.** 103 ms → 99 ms on the desktop, inside
the noise, for a quality risk.

**Resizing the render — no.** 720p Modern is 153 ms against 1080p's 187 ms, an 18% saving for a
visibly softer picture. The `RENDER_CAP` comment already records why the obvious 2.25× pixel-count
reasoning is wrong; this confirms it.

## 4. What is already right

Worth recording so it is not "optimised" later by someone measuring the wrong thing.

- **A browser screen downloads 76 KB.** `screen.html` is its own rollup entry, pulling
  `screen-*.js` (72 KB) and the preload helper (4 KB) — not the 336 KB control panel.
- **`hls.js` (580 KB) and xterm (288 KB) are dynamic imports**, so a screen that shows no camera
  and a panel with no terminal open never fetch them. Vite's "chunks larger than 500 kB" warning
  on every build is about `hls.js` and is noise.
- **`sampleImage()` builds a 24×24 Resvg with no fonts** to read a background photo's luminance,
  and caches the result per photo. 0.2 ms, once — correct as written.
- **Render resolution is full by default, not capped at 1280.** The comment above `RENDER_CAP`
  records why (the 2.25× pixel-count ratio was never the cost ratio; measured, it is 1.25×) and
  that remains true: parsing and tessellation do not care what size they are drawn at.
- **`textRendering` / `shapeRendering: optimizeSpeed` do nothing measurable** (103 → 99 ms on the
  desktop, inside the noise). Not worth the quality risk.

## 5. Measuring this yourself: set OMD_FONT_DIR

`fonts.ts`'s `DIRS` is `OMD_FONT_DIR`, `/app/fonts`, `/usr/share/fonts`, `/usr/local/share/fonts`.
The repository's own `server/assets/fonts` is deliberately not in that list — `OMD_FONT_DIR` is
the hook for a source checkout, and it is scanned first so a vendored face still wins over the
distro's copy of the same family. `fontPick.test.ts` sets it for exactly this reason.

**So a server started from a checkout without it finds no fonts**, falls back to
`loadSystemFonts: true`, and both renders ~3× slower (122 ms of font DB instead of 42 ms on a
desktop) and draws with whatever the host happens to have. That is not a production problem — the
Dockerfile copies `server/assets/fonts` to `/app/fonts` and installs `fonts-dejavu-core` and
`fonts-noto-core`, a standalone Pi's installer puts its faces in `/usr/share/fonts` from the
distribution's packages, and a managed Pi is sent the server's own — but it is the first thing to
get wrong when measuring.

It got this file wrong once: the opening numbers were taken with `loadSystemFonts` and had to be
thrown away. If a render benchmark reports ~120 ms of font work on a desktop, that is the symptom.

```sh
cd server && npm run build && OMD_FONT_DIR=assets/fonts npm start   # there is no root package.json
```
