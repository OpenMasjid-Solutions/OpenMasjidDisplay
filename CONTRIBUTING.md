<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Contributing to OpenMasjid Display

Thanks for helping! A few ground rules.

## Licensing

This project is licensed **AGPL-3.0-only** (see [`LICENSE`](LICENSE)) and contributions are
governed by the **Contributor License Agreement** ([`CLA.md`](CLA.md), the canonical text). By
submitting a contribution you agree it is licensed under **AGPL-3.0-only**, you certify the
[Developer Certificate of Origin](https://developercertificate.org/) (the work is yours to
contribute), and you accept the CLA. Sign your commits off:

```
git commit -s -m "..."
```

**Signing the CLA.** You sign **once**, automatically, on your first pull request: the CLA bot
comments with a link to [`CLA.md`](CLA.md) and asks you to reply with the exact sentence

> I have read the CLA Document and I hereby sign the CLA

The CLA keeps the public tree AGPL-3.0 while letting OpenMasjid-Solutions also offer
commercial/dual licenses; you keep your copyright. If you cannot accept the relicensing grant
(§2 of the CLA), say so in your PR and we'll take it AGPL-only or discuss.

## Code

- Keep it **AGPL-3.0-only** — every source file carries an SPDX header
  (`// SPDX-License-Identifier: AGPL-3.0-only`); add one to new files.
- It must build (`cd server && npm run build`, `cd web && npm run build`) and pass
  `npm test` in `server/`.
- Match the surrounding style; UI follows the OpenMasjidOS design language
  (dark default, WCAG AA, RTL-ready, honors `prefers-reduced-motion`).
- Don't weaken the security invariants noted in the code (stream-scheme allowlist,
  audience-bound tokens, scrypt + constant-time compare, array-form `spawn`, Fabric
  private-range SSRF guard).
