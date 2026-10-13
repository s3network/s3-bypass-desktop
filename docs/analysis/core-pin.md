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
| Release tag | `v0.1.0-fork.5` |

Release published 2026-10-13 (our fork); tag commit committer date
2026-10-13T14:10:08+03:00:

| Field      | Value                                      |
| ---------- | ------------------------------------------ |
| Commit SHA | `ad9ca7b66b81cd377d195d9e4fb9d61c99d00846` |

**Why this pin moved.** `v0.1.0` shipped on 2026-10-12 with `fork.3` still
pinned here, so the released application carried a core that could not talk to
a server on `fork.4`: the client wrote sessions the server never read, and the
tunnel failed with `no ACK for session …` while the server log stayed empty.
The version numbers must match on both ends of the bucket — a pin bump is a
release, not a housekeeping edit.

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
release assets on 2026-10-13 and cross-checked against the fork release
`.dgst` files shipped with the release (`SHA2-256=` lines) — all three
matched.

| Asset                      | SHA-256                                                          | Bytes    |
| -------------------------- | ---------------------------------------------------------------- | -------- |
| `Xray-linux-64.zip`        | 4adea4d24689e2f83f232ce5d6baf331335c0f5ae583f2eb034897fb20075fb6 | 22993069 |
| `Xray-macos-64.zip`        | d8f3ac71df6a153278d59155c225d3ef3f8bacded58016ac3e4f5d6be4985f3a | 22760197 |
| `Xray-macos-arm64-v8a.zip` | 9db9480b1debc78f93f0699f3bb183b23a7f833f7d8ca9fe369f13ae59489aa5 | 21413599 |

## Verification contract (M2 DoD #1)

- Build/pack time: every downloaded asset goes through
  `npm run verify:core-pin -- <file> <asset>`; a non-zero exit fails the
  build (wired into the release CI in M2-07).
- Pin bumps are a deliberate act: update the release-tag row, the
  commit-SHA row and the asset table together, then re-run the verifier.
  The raw-text pins in `tests/unit/core-pin.test.ts` read this file
  directly (DV-39), so the structure above is contract, not decoration.
