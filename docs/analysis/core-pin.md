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
| Release tag | `v0.1.0-fork.4` |

Release published 2026-10-10 (our fork); tag commit
committer date 2026-10-10T22:50:56+03:00:

| Field      | Value                                      |
| ---------- | ------------------------------------------ |
| Commit SHA | `e30941321f5e4657671b6f5c41359faad285a4c2` |

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
| `Xray-linux-64.zip`        | f80c656a6b99a034858154015772a07a6874a976509eb9d59fddcbce3e4353e5 | 22942923 |
| `Xray-macos-64.zip`        | 41bf7539f5c5cd4ea81ea041afa9aa79f235b4978edcbef43f41105bbb332880 | 22747018 |
| `Xray-macos-arm64-v8a.zip` | 85cfc7545d5865737d052319d3badec488a5c4a6a96b6fc8b28f718438d85f8d | 21400349 |

## Verification contract (M2 DoD #1)

- Build/pack time: every downloaded asset goes through
  `npm run verify:core-pin -- <file> <asset>`; a non-zero exit fails the
  build (wired into the release CI in M2-07).
- Pin bumps are a deliberate act: update the release-tag row, the
  commit-SHA row and the asset table together, then re-run the verifier.
  The raw-text pins in `tests/unit/core-pin.test.ts` read this file
  directly (DV-39), so the structure above is contract, not decoration.
