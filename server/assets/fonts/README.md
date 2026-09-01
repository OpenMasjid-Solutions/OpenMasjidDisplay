<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Bundled fonts

Fonts vendored into the image so rendering is identical on every host, and so the
renderer never depends on which glyphs the distro's font packages happen to ship.
resvg picks **one** font per text run and does not per-glyph fall back, so the Arabic
face has to cover everything a run might contain (Arabic letters, the ﷺ ligature, AND
Latin punctuation like `"`, `(`, `)`), or that character renders as a tofu box.

## Amiri-Regular.ttf  (the Arabic face)

- **Source:** [Amiri](https://github.com/aliftype/amiri) (via Google Fonts), a
  traditional Naskh typeface.
- **License:** SIL Open Font License 1.1 — see [`LICENSE-Amiri-OFL.txt`](LICENSE-Amiri-OFL.txt).
- **Why:** it has the full Arabic script, the ﷺ ligature (U+FDFA), **and** complete
  Latin punctuation, so a hadith like `… قال: "…" ((رواه …))` renders in one font with
  no broken/tofu characters. `fonts.ts` loads it as the primary Arabic face and
  `FONT_ARABIC` names it first.

## NotoNaskhArabic-Regular.ttf  (secondary Arabic fallback)

- **Source:** [notofonts/arabic](https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoNaskhArabic)
  (Google Noto, static hinted build). **License:** SIL OFL 1.1 — see [`LICENSE-OFL.txt`](LICENSE-OFL.txt).
- Kept as a fallback Arabic face. (On its own it lacked `"`, `(`, `)`, which is what
  left tofu boxes in punctuated hadith text — Amiri fixes that.)
