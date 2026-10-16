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
| Release tag | `v0.1.0-fork.6` |
| Published   | 2026-10-14      |

Release published 2026-10-14 (our fork); tag commit
committer date 2026-10-14T13:21:12+03:00:

| Field      | Value                                      |
| ---------- | ------------------------------------------ |
| Commit SHA | `2c968483a74be06cd9bb468bc1490a6c9eb4e285` |

**Why this pin moved.** `v0.1.0-fork.6` is the audit release: a full review of
the tree found roughly thirty confirmed defects, four of them reachable from
the network. The ones that touch this client are in `proxy/fedarisha` —
bounded buffers (an unbounded `io.ReadAll` on a decoded object, and up to
128 MiB of buffering per connection), timeouts on the S3 calls that run on the
session-discovery loop, and per-key delete errors that were previously
swallowed so a "deleted" session left objects in the bucket still being
billed.

The wire format is unchanged: `proxy/fedarisha/transport/protocol.go` is
byte-identical to `v0.1.0-fork.5`, so session discovery, file names and the
hello handshake are the same. The cryptographic changes in this release
(xmc RSA-2048 with PBKDF2, mkcp AES-256) touch transports that neither the
client nor the deployed server uses, and the xmc change falls back to the
legacy derivation by default so mixed versions still talk.

`v0.1.0` shipped on 2026-10-12 with `fork.3` still pinned here, so the
released application carried a core that could not talk to a server on
`fork.4`: the client wrote sessions the server never read, and the tunnel
failed with `no ACK for session …` while the server log stayed empty. That
is the failure mode this pin prevents: the version numbers must match on both
ends of the bucket — a pin bump is a release, not a housekeeping edit.

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
release assets on 2026-10-14 and cross-checked against the fork release
`.dgst` files shipped with the release (`SHA2-256=` lines) — all three
matched.

| Asset                      | SHA-256                                                          | Bytes    |
| -------------------------- | ---------------------------------------------------------------- | -------- |
| `Xray-linux-64.zip`        | 3dc20407da407df0d03546c737032ae0638b5e7bfb15238dc184d4615aaffa4d | 23031346 |
| `Xray-macos-64.zip`        | b30d2c3153b47fb4d367fd05e509a6f759846f53bee08ecce1c5b4204ff2de07 | 22799923 |
| `Xray-macos-arm64-v8a.zip` | 76efd6b8deed7d2199b784c1178521acf438f4b793c30bd58512e20174bfabfb | 21449599 |

## Verification contract (M2 DoD #1)

- Build/pack time: every downloaded asset goes through
  `npm run verify:core-pin -- <file> <asset>`; a non-zero exit fails the
  build (wired into the release CI in M2-07).
- Pin bumps are a deliberate act: update the release-tag row, the
  commit-SHA row and the asset table together, then re-run the verifier.
  The raw-text pins in `tests/unit/core-pin.test.ts` read this file
  directly (DV-39), so the structure above is contract, not decoration.
