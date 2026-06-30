<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Bundled fonts

Fonts vendored into the image so rendering is identical on every host, and so the
renderer never depends on exactly which glyphs the distro's font packages happen to
ship.

## NotoNaskhArabic-Regular.ttf

- **Source:** [notofonts/arabic](https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoNaskhArabic)
  (Google Noto, static hinted build).
- **License:** SIL Open Font License 1.1 — see [`LICENSE-OFL.txt`](LICENSE-OFL.txt).
  OFL is compatible with this repository's AGPL-3.0-only code (fonts are bundled as
  data; the OFL governs the font file itself).
- **Why vendored:** the renderer must draw the Arabic _ṣallā-llāhu ʿalayhi wa-sallam_
  ligature **ﷺ (U+FDFA)** correctly. Debian's `fonts-noto-core` ships Noto Naskh Arabic
  as a **variable** font, and resvg's variable-font handling can drop that ligature to a
  tofu box. This static face is verified to contain U+FDFA, and `fonts.ts` loads it with
  priority so the glyph always renders.
