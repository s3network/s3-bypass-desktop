# Core binary pin — Xray-core-fedarisha

Status: **active** · Owner: DevOps (board task M2-03) · Language: English
Basis: `BRIEF.md` §9 ("Core binary pinned to the latest
`Fedarisha/Xray-core-fedarisha` release; commit SHA recorded in docs"),
M2 DoD #1 (SHA-256 of the bundled core verified at build time).
Verifier: `npm run verify:core-pin -- <file> <asset>` →
`scripts/verify-core-pin.mjs` (exit 0 match, exit 1 MISMATCH naming the
asset, exit 2 usage).

## Pinned release

| Field       | Value           |
| ----------- | --------------- |
| Release tag | `v0.1.0-fork.3` |

Release published 2026-10-09 (our fork); tag commit
committer date 2026-10-09T21:32:29+03:00:

| Field      | Value                                      |
| ---------- | ------------------------------------------ |
| Commit SHA | `95c6befbf168057a650e0fd7ae3968ab0da352a3` |

Source repository: `github.com/s3network/s3-bypass-protocol` — our hardened
fork of `github.com/Fedarisha/Xray-core-fedarisha`, based on upstream tag
`v26.9.9-1.0.1fed` (commit `03660664`) — the same base the previous pin used,
so the engine log wording stays identical to it (Go,
**MPL-2.0** — corrected 2026-10-08 from the BRIEF's GPL-3.0 claim: the LICENSE
file inside every release asset reads "Mozilla Public License Version 2.0" and
the GitHub license API reports `MPL-2.0`; the bundled binary still triggers
the BRIEF §5 / M2-06 attribution duties — the client itself stays GPL-3.0).

## Pinned assets

One row per bundled platform (darwin-x64, darwin-arm64, linux-x64 per
BRIEF §9; Linux package formats AppImage + `.deb` + `.rpm` per the owner
decision of 2026-10-08). SHA-256 values were computed from the downloaded
release assets on 2026-10-09 and cross-checked against the fork release
`.dgst` files shipped with the release (`SHA2-256=` lines) — all three
matched.

| Asset                      | SHA-256                                                          | Bytes    |
| -------------------------- | ---------------------------------------------------------------- | -------- |
| `Xray-linux-64.zip`        | 72c6005321446cc1ab4fe60f85e20576bfe8907ed36fdbc53e272868b94454e1 | 22941394 |
| `Xray-macos-64.zip`        | 205fc117e078972b6a7e9ce368d4692979bac2db5fc91fbc51fb834820f40b19 | 22714214 |
| `Xray-macos-arm64-v8a.zip` | f400b1a1d3dddca9f2208a36418f35702c5336c2bebec11549baa87377c584e3 | 21366671 |

## Verification contract (M2 DoD #1)

- Build/pack time: every downloaded asset goes through
  `npm run verify:core-pin -- <file> <asset>`; a non-zero exit fails the
  build (wired into the release CI in M2-07).
- Pin bumps are a deliberate act: update the release-tag row, the
  commit-SHA row and the asset table together, then re-run the verifier.
  The raw-text pins in `tests/unit/core-pin.test.ts` read this file
  directly (DV-39), so the structure above is contract, not decoration.
