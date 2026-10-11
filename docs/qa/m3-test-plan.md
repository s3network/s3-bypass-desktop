# M3 Test Plan — wording ↔ surfaces ↔ icon ↔ docs ↔ beta

Owner: **QA** · Basis: `docs/plans/m3-polish.md` (M3 board), `BRIEF.md` §2/§5/§9,
`docs/plans/milestones.md` §M3 · Strategy: `strategy.md` · Status: **open (M3-02)** —
rows are written RED-first per batch and results land in §10; acceptance history:
`docs/qa/acceptance-m2-13.md` (M2 verdict GO), the M3 acceptance report is a to-come
artifact (M3-13).

**TC numbering rule** (extends strategy §4.3): behavior that belongs to a user story
keeps the `TC-<story>-<nn>` family (`nn` equals the AC number; `nn ≥ 10` when the case
is not AC-derived — M3 continues existing sequences where the surface belongs to a story:
AC-04.5 manual-proxy hint = the `TC-04` family, quit surfacing = `TC-05`, etc.).
Cross-cutting M3 pins use **`TC-POL-nn`** — wording-table growth & contract hardening,
icon/naming config, i18n seam, docs consistency, status/tray dedup. The #27 release-leg
pins continue **`TC-PKG-nn`** in `docs/qa/m2-test-plan.md` §6 (fix-20 precedent — the
family lives with the release-CI rows). NFR-5 wording coverage is expressed BOTH as
`errorWording.test.ts` **table rows** (row ids, strategy §7 schema) and, where a row
cannot reach a surface, as TC-POL pins. Raw-text doc/config pins follow the DV-36/DV-37
pattern. IDs are never renumbered.

**Status legend:** `RED-planned` = row planned, test not written yet · `RED-written` =
the failing test exists · `observed-GREEN` · `L3` = packaged-app / Playwright E2E ·
`L4` = manual checklist · `blocked-xx` = waiting on a decision or environment ·
`deferred-M3` = out of M3 scope per spec note.

---

## 1. Scope ↔ board tasks

| §   | Scope                                                                                | Board task    | Family                                 |
| --- | ------------------------------------------------------------------------------------ | ------------- | -------------------------------------- |
| 2   | Error-wording pass: table rows for the audit gaps + `expectHumanError` hardening     | M3-03 / M3-04 | `errorWording.test.ts` rows + `TC-POL` |
| 3   | UX surfaces: AC-04.5 hint, footer copy, quit-failure surfacing, states, status dedup | M3-05 / M3-06 | `TC-04` / `TC-05` / `TC-POL`           |
| 4   | App icon + naming                                                                    | M3-07         | `TC-POL` (+ builder-config)            |
| 5   | i18n groundwork (EN seam, byte-identical wording pins)                               | M3-08         | `TC-POL`                               |
| 6   | User docs + beta setup doc + README split                                            | M3-09         | `TC-POL` (docs-consistency)            |
| 7   | darwin-x64 dmg leg (issue #27) — rows live in m2-test-plan §6                        | M3-10         | `TC-PKG` (m2 plan)                     |
| 8   | Beta distribution + security re-review + acceptance (L4)                             | M3-11..13     | L4 checklist in the acceptance report  |

**Audit basis (scoping 2026-10-08):** the error-surface inventory that drove §2/§3 —
19 covered rows; unpinned triples E-IO-006, E-CORE-003, E-IO-001, E-IO-002, E-STOR-005;
sibling-only pins E-IO-004, E-IO-003, E-CORE-001, E-CORE-002, E-VAL-015, no-profile
refusal; wording divergence B-8c (status-machine vs errors.md); internal-code leaks B-9
(`E-PLAT-001` in a nextStep) and B-2 (`E-PLAT-005` in a nextStep); missing AC-04.5 hint
render (B-11); swallowed quit failure (B-13); stale footer `App.tsx:353`.

---

## 2. Error-wording pass (M3-03 RED / M3-04 GREEN)

### 2.1 Rows added to `tests/unit/errorWording.test.ts` (TC-POL-01)

| Row id                                          | Code         | Surface / trigger                                                                                    | Status                                                       |
| ----------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `fileReadFailed`                                | `E-IO-001`   | `FILE_READ_FAILED` triple from the new single-source `src/shared/error-triples.ts` (FR-06)           | RED-written                                                  |
| `dialogFailed`                                  | `E-IO-002`   | `DIALOG_FAILED` triple (FR-01 defensive)                                                             | RED-written                                                  |
| `stor005ProfileSaveFailed`                      | `E-STOR-005` | real `secret-store.saveProfile` over a read-only data dir (FR-54 defensive)                          | RED-written (observed GREEN in the RED batch — additive pin) |
| `noProfileStepZeroRefusal`                      | `E-VAL-016`  | `NO_PROFILE` triple, FR-12 step-0 refusal (errors.md §1 M3-A amendment)                              | RED-written                                                  |
| `illegalTransitionRejection`                    | `E-VAL-017`  | pure reducer `transition(INITIAL_STATUS, "stop")` (FR-18, errors.md §1 M3-A amendment)               | RED-written                                                  |
| `e005Dedup.mainModulesCarryNoInlineE005Literal` | —            | raw-text pin (DV-36): `index.ts`/`secret-store.ts` must carry NO inline `code: 'E-STOR-005'` literal | RED-written                                                  |

Contract hardening (same batch): `FORBIDDEN` gains `an internal error code`
(`/\bE-(?:VAL|IO|CORE|PLAT|STOR)-\d{3}\b/`) and `an operating-system errno token`
(`ENOENT|EACCES|…`), both `userTextOnly` (the `code` field legitimately carries a code —
errors.md §0 amended: the forbidden thing is a code _citation inside_
title/cause/nextStep).

### 2.2 Sibling-surface wording pins (TC-POL-02, `core-supervisor.test.ts`)

| Case                                                                                                                                                                   | Code         | Status                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------- |
| `supervisor.start.doubleClick` — code pin amended `E-VAL-015` → `E-VAL-017` + `expectHumanWording`                                                                     | `E-VAL-017`  | RED-written                     |
| `TC-02-06` crash — `expectHumanWording` added                                                                                                                          | `E-CORE-001` | observed GREEN in the RED batch |
| `TC-02-04` binary missing — `expectHumanWording` added                                                                                                                 | `E-IO-004`   | observed GREEN in the RED batch |
| `TC-02-05` port busy — `expectHumanWording` added                                                                                                                      | `E-IO-003`   | observed GREEN in the RED batch |
| `TC-02-10` never ready — `expectHumanWording` added                                                                                                                    | `E-CORE-002` | observed GREEN in the RED batch |
| NEW `supervisor.start.configWriteFails.documentedEio006NeverSpawns` (TMPDIR read-only → `mkdtempSync` EACCES)                                                          | `E-IO-006`   | observed GREEN in the RED batch |
| NEW `supervisor.start.binaryNotExecutable.settlesDocumentedEcore003` (existing but non-executable binary → spawn EACCES; nextStep must drop the `E-PLAT-005` citation) | `E-CORE-003` | RED-written                     |

Sibling amendments outside the wording suites: `core-wiring.test.ts` TC-02-03 pins the
now-documented `E-VAL-016` (DV-19 superseded); `errors.md` §0/§1/§3/§4 amended per DV-64;
`system-proxy.ts` E-PLAT-002 nextStep loses its `E-PLAT-001` citation at GREEN (row
`systemProxyChangeFailed` observed RED via the hardening).

---

## 3. UX surfaces (M3-05 RED / M3-06 GREEN) — TC-POL-03

| Pin                                                         | Surface / finding                                                                                                                                                                                                                 | Suite                         | Status                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------- |
| `app.footer.shippedProductCopyNotM0ScaffoldNote`            | footer `App.tsx` still says "M0 scaffold — tunnel features land in M1." → shipped copy = `S3 Bypass Desktop` (BRIEF §9 productName)                                                                                               | `app-render.test.tsx`         | RED-written                     |
| `app.proxy.unsupportedDesktopRendersExactManualHint`        | AC-04.5 (audit B-11): renderer must read `ProxyState.supported`/`hint` and render the exact data-flows §3.3 sentence                                                                                                              | `app-render.test.tsx`         | RED-written                     |
| `app.proxy.supportedDesktopShowsNoManualHint`               | the hint is the unsupported answer only — never shown when supported                                                                                                                                                              | `app-render.test.tsx`         | observed GREEN in the RED batch |
| `app.statusIpcLine.noBridgeKeepsDevParenthetical`           | plain-browser/dev context keeps "(run inside Electron)"                                                                                                                                                                           | `app-render.test.tsx`         | observed GREEN in the RED batch |
| `app.statusIpcLine.bridgePresentShowsNoDevText`             | audit: a packaged app whose ping failed must not see dev text                                                                                                                                                                     | `app-render.test.tsx`         | RED-written                     |
| `app.statusLabels.rendererAndTrayMapsIdentical`             | duplicated status-label maps (renderer badge vs tray statusText) — ABSENCE RED until both are exported from one source                                                                                                            | `app-render.test.tsx`         | RED-written (absence)           |
| `logs.view.emptyStateTextPinned`                            | Logs empty-state copy ("No log lines yet.") ships but was never pinned                                                                                                                                                            | `logs-view.test.tsx`          | observed GREEN in the RED batch |
| `trayQuit.stopFailure.firstFailureRethrownAfterRequestQuit` | the policy-level surfacing contract (`window-lifecycle.ts` header) was explicitly unpinned ("whether the promise rejects is NOT pinned") — pinning it is what B-13's call-site fix relies on                                      | `window-lifecycle.test.ts`    | observed GREEN in the RED batch |
| `quitTeardown.stopFailureSurfacedNotSwallowed`              | audit B-13 source pins: stopCore binds + throws the `handleStopForce` result; `beginQuit` routes the rethrow to `surfaceQuitFailure` (native dialog, `isAppError` gate, triple fields); the empty `.catch(() => {})` must be gone | `index-native-wiring.test.ts` | RED-written                     |

Scope decisions recorded in the RED (owner-approved batch B): the unsupported-desktop
hint is _rendered_ but the toggle state machine is untouched (its refusal path already
answers with the documented `E-PLAT-001` triple, AC-04.6); non-triple quit failures
(hung-step budget timeouts) stay non-visual — inventing wording for them would violate
errors.md §0 (only documented triples reach the user).

---

## 4. App icon + naming (M3-07 RED / GREEN) — TC-POL-04

| Pin                                                               | What                                                                                                                                                                                      | Suite                    | Status                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------- |
| `builderConfig.iconWiredToGeneratedArtifactsAndProductNamePinned` | `mac:` declares `icon: assets/icon.icns`, `linux:` declares `icon: assets/icon.png`, `productName: S3 Bypass Desktop` stays exact (BRIEF §9)                                              | `builder-config.test.ts` | RED-written           |
| `appIcon.sourceGeneratorAndArtifactsShipInRepo`                   | ABSENCE RED: `assets/app-icon.svg` + `scripts/build-icon.mjs` + generated `assets/icon.icns`/`assets/icon.png` exist; the generator reads the SVG, writes both artifacts, uses `iconutil` | `builder-config.test.ts` | RED-written (absence) |
| `appIcon.artifactsAreRealIcnsAndPng`                              | magic bytes (`icns`/`PNG`), ≥ 1000 B container, PNG ≥ 256 px and square — placeholders cannot satisfy the config pins vacuously                                                           | `builder-config.test.ts` | RED-written (absence) |
| `appIcon.generatorWiredIntoPackageScripts`                        | `npm run build:icon` regenerates the artifacts (SVG = source of truth)                                                                                                                    | `builder-config.test.ts` | RED-written (absence) |

Owner decision (recorded on the board 2026-10-08): the icon is generated in-repo —
SVG source + build script → icns/png, no owner artwork; generated artifacts are
committed so packaging runs without an extra generation step.

---

## 5. i18n groundwork — single EN strings module (M3-08 RED / GREEN) — TC-POL-05

| Pin                                           | What                                                                                                                                                                                                                                            | Suite                  | Status                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| `strings.moduleExistsAndTSeamIsByteIdentical` | ABSENCE RED: `src/shared/strings.ts` exports `t(key)`; 18 exact rows byte-identical (5 status words, `hint.noProfile`/`hint.proxyNotRunning`, `action.start/stop`, 4 tray labels, 4 logs strings, tagline) + the parameterized AC-04.5 sentence | `strings-seam.test.ts` | RED-written (absence)                                  |
| `strings.enMapCarriesNoRussianContent`        | BRIEF §3: no Cyrillic in any EN value (RU is backlog, never MVP content)                                                                                                                                                                        | `strings-seam.test.ts` | RED-written (absence)                                  |
| `strings.consumersRenderThroughTheSeam`       | raw-text (comment-stripped): `App.tsx`/`LogsView.tsx`/`window-lifecycle.ts`/`status-labels.ts` import the seam, contain the `t('…')` keys and no longer hardcode the literals                                                                   | `strings-seam.test.ts` | RED-written                                            |
| all existing wording pins                     | byte-identical output — e2e `Import a profile first`, TC-04-04, TC-05-04, TC-06-05, TC-POL-03 rows, FR-41 words                                                                                                                                 | existing suites        | observed GREEN in the RED batch (contract of the task) |

Scope decisions (recorded in the RED, plan M3-08): identity strings stay out of the
seam (the `S3 Bypass Desktop` h1/footer — BRIEF §9 productName, pinned by
`builder-config`); the dev-only IPC line stays out (not translatable copy); error
triples stay out (their wording is owned by `docs/analysis/errors.md` + main-process
modules, batch A). Key namespace: `status.* hint.* action.* tray.* logs.* app.*`.

---

## 6. User documentation set + README split (M3-09 RED / GREEN) — TC-POL-06

| Pin                                                    | What                                                                                                                                                                                                     | Suite                      | Status                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------- |
| `docs.user.installMacos.unsignedGatekeeperPathWritten` | ABSENCE RED: `docs/user/install-macos.md` exists; says the build is **unsigned** (BRIEF §10 honesty), gives the Control/right-click → Open gesture (not "disable Gatekeeper"), links `macos-gatekeeper`  | `docs-consistency.test.ts` | RED-written (absence)                 |
| `docs.user.installLinux.threeTargetsCovered`           | ABSENCE RED: `docs/user/install-linux.md` exists; covers AppImage + deb + rpm (BRIEF §9) incl. the real `chmod +x` step                                                                                  | `docs-consistency.test.ts` | RED-written (absence)                 |
| `docs.user.firstProfile.quotesShippedHintVerbatim`     | ABSENCE RED: `docs/user/first-profile.md` exists; quotes the exact shipped hint `Import a profile first`, the `Start` control, the `Running` badge word (byte-identical with the app — TC-POL-05 tie-in) | `docs-consistency.test.ts` | RED-written (absence)                 |
| `docs.user.troubleshooting.manualProxyAndCopyLogs`     | ABSENCE RED: `docs/user/troubleshooting.md` exists; manual proxy endpoint `127.0.0.1:10808` + `SOCKS` + the exact `Copy logs` button (AC-06.5)                                                           | `docs-consistency.test.ts` | RED-written (absence)                 |
| `docs.user.betaSetup.installerHandoutSpelledOut`       | ABSENCE RED (DoD #1 input): `docs/user/beta-setup.md` exists; `SHA256SUMS` verification, `arm64` + `x64` installers (issue #27 outcome), `AppImage`, the app name                                        | `docs-consistency.test.ts` | RED-written (absence)                 |
| `docs.readme.userVsDevelopmentSplitAndHonestStatus`    | README keeps `## Development`, links `install-macos` + `beta-setup`, and the M0/M1-era `Not usable yet.` claim is gone (acceptance reality, same discipline as D-04..D-10)                               | `docs-consistency.test.ts` | RED-written (status line still stale) |
| `docs.readme.everyUserFileLinked`                      | mechanical sweep: every `docs/user/*.md` (≥ 5 files) is linked from README — no orphan, future files included                                                                                            | `docs-consistency.test.ts` | RED-written (dir absent)              |

---

## 10. Execution log (per batch)

_Appended when a batch is written/observed — RED entry first, then GREEN, mirroring
the m2-test-plan §10 narrative style: counts, observed RED, baseline untouched, green
results.)_

### M3-03 RED (error-wording pass, 2026-10-08)

- Chain before RED: `prettier --check docs/ src/ tests/` clean, typecheck rc=0,
  eslint rc=0. Spec amendments in the same RED commit (DV-64): `docs/analysis/errors.md`
  §0 (code citations + errno tokens forbidden in user text), §1 (+`E-VAL-016`, +`E-VAL-017`, E-VAL-015 note), §3 `E-CORE-003` and §4 `E-PLAT-002` next-step
  citations dropped.
- Suite: **9 failed | 290 passed (299)** — baseline 291 → +8 tests (5 wording rows
  - 1 dedup pin + 2 new supervisor trigger tests), 43 files. The 9 observed REDs are
    exactly the named gaps:
  1. `errorWording.fileReadFailed` / `dialogFailed` / `noProfileStepZeroRefusal` —
     ABSENCE RED (`src/shared/error-triples.ts` missing, `loadErrorTriples` gate);
  2. `errorWording.illegalTransitionRejection` — impl code `E-VAL-015` ≠ pinned `E-VAL-017`;
  3. `errorWording.e005Dedup.mainModulesCarryNoInlineE005Literal` — both literals inline;
  4. `errorWording.systemProxyChangeFailed` — hardening catches `E-PLAT-001` citation;
  5. `core-supervisor.doubleClick` — code pin `E-VAL-017`;
  6. `core-supervisor.binaryNotExecutable` (E-CORE-003) — hardening catches the
     `E-PLAT-005` citation + nextStep substring pin;
  7. `core-wiring.noProfileMainGuard` — code pin `E-VAL-016`.
- Observed GREEN in the RED batch (additive pins that hold already):
  `stor005ProfileSaveFailed`, `supervisor.start.configWriteFails` (E-IO-006),
  and the `expectHumanWording` additions on TC-02-04/05/06/10.
- e2e: not re-run for this RED (suite-only + docs; e2e unchanged, 1/1 last green
  at `b26e0a2`). Fixup needed? One was: the first RED run failed 50+ tests because
  `tripleText` includes the `code` field — the two new FORBIDDEN rules are
  `userTextOnly` (checked against title/cause/nextStep only); re-observed RED after
  the fix is the 9 listed above.

### M3-04 GREEN (alignment, 2026-10-08)

- Chain: prettier `docs/ src/ tests/` clean, typecheck rc=0, eslint rc=0 (two
  fixups during GREEN: import-sort autofix; `WORDING_BY_CODE` gained the
  `E-VAL-016`/`E-VAL-017` pins — the `expectHumanWording` lookup is
  code-keyed and must cover every code it can be called with).
- Implementation: `src/shared/error-triples.ts` created (`FILE_READ_FAILED`,
  `DIALOG_FAILED`, `E_STOR_005`, `NO_PROFILE` — verbatim literals); `index.ts`
  imports the three (own copies deleted), `secret-store.ts` aliases
  `STORE_IO_FAILED` to the shared triple (dedup pin passes), `core-wiring.ts`
  returns the shared `NO_PROFILE` (`E-VAL-016`), `status-machine.ts`
  `INVALID_TRANSITION_CODE` → `E-VAL-017`, `core-supervisor.ts` E-CORE-003
  nextStep drops `(E-PLAT-005)`, `system-proxy.ts` E-PLAT-002 nextStep drops
  the `E-PLAT-001` citation (values instead).
- Sibling pin amendments (DV-64): `system-proxy.test.ts` TC-04-06 substring
  → `set the proxy manually (SOCKS host 127.0.0.1`; canned E-PLAT-002
  fixtures in `proxy-wiring.test.ts`/`proxy-toggle.test.tsx` reworded;
  comment-only code renames in `core-supervisor.test.ts`/`quit-force-stop.test.ts`.
- Result: **299 passed (299)** / 43 files — all 9 named REDs resolved. e2e:
  1 passed (1).

### M3-05 RED (UX surfaces, 2026-10-08)

- Chain: prettier `docs/ src/ tests/` clean, typecheck rc=0, eslint rc=0
  (one RED-fixup before this observation: the status-labels test pulled
  `src/main/window-lifecycle.ts` into the tsconfig.web program — no `node`
  types → `NodeJS` namespace error; the tray half now loads through a
  non-literal specifier, the documented absence-RED loader trick, so the
  web project never follows the import; second fix: `exactOptionalPropertyTypes`
  on the `window.s3Bypass` spread in the empty-state pin — replaced by a
  guarded property assignment).
- Suite: **5 failed | 303 passed (308)** — baseline 299 → +9 tests
  (6 app-render + 1 logs empty-state + 1 lifecycle rethrow + 1 source scan).
  The 5 observed REDs are exactly the named findings:
  1. `app.footer.shippedProductCopyNotM0ScaffoldNote` — footer still the
     M0 scaffold note;
  2. `app.proxy.unsupportedDesktopRendersExactManualHint` — renderer never
     reads `ProxyState.supported`/`hint` (audit B-11, AC-04.5);
  3. `app.statusIpcLine.bridgePresentShowsNoDevText` — dev parenthetical
     renders even when the bridge exists;
  4. `app.statusLabels.rendererAndTrayMapsIdentical` — ABSENCE RED (neither
     map is exported; M3-06 creates the shared source);
  5. `quitTeardown.stopFailureSurfacedNotSwallowed` — audit B-13: the
     `handleStopForce` result is dropped and `beginQuit`'s catch is empty.
- Observed GREEN in the RED batch: `supportedDesktopShowsNoManualHint`,
  `noBridgeKeepsDevParenthetical`, `logs.view.emptyStateTextPinned`,
  `trayQuit.stopFailure.firstFailureRethrownAfterRequestQuit` (the
  policy-level contract the call-site fix relies on).
- e2e: not re-run for this RED (suite-only + docs; e2e unchanged, 1/1 at
  `c0a2eb7`).

### M3-06 GREEN (surface pins, 2026-10-08)

- Chain: prettier `docs/ src/ tests/` clean, typecheck rc=0, eslint rc=0
  (one GREEN fixup: `CoreState` alias in App.tsx became unused once the
  shared label map supplied its own typing).
- Implementation:
  - `src/shared/status-labels.ts` (new): the ONE status-word map;
    `App.tsx` re-exports it as `STATUS_LABELS`, `window-lifecycle.ts`
    re-exports it as `STATUS_TEXT` (local duplicate deleted) — the
    equality pin compares the two exports of the same object;
  - footer: `S3 Bypass Desktop` (BRIEF §9 productName), scaffold note gone;
  - AC-04.5: `readProxyState` now stores the full `ProxyState`; the
    unsupported desktop renders the exact data-flows §3.3 sentence built
    from `hint` (host/port, `DEFAULT_SOCKS_PORT` fallback) — supported
    path unchanged;
  - IPC line: the `(run inside Electron)` parenthetical renders only when
    `window.s3Bypass` is absent (plain-browser/dev context);
  - B-13: `stopCore` binds the `handleStopForce` result and throws the
    documented triple on `!ok`; `beginQuit` routes the rethrown first
    failure to the new `surfaceQuitFailure` (native warning dialog,
    `isAppError` gate — non-triple infrastructure failures stay
    non-visual per errors.md §0).
- Result: **308 passed (308)** / 43 files — all 5 named REDs resolved.
  e2e: 1 passed (1) (the Start/Stop exact-name contract untouched).

### M3-07 RED (app icon, 2026-10-08)

- Chain: prettier `docs/ src/ tests/` clean, typecheck rc=0, eslint rc=0.
- Suite: **4 failed | 308 passed (312)** — baseline 308 → +4 tests (the
  whole TC-POL-04 describe), 1 file. The 4 observed REDs are the named
  absence pins: config wiring (mac/linux `icon:` + `productName` pin),
  source/generator/artifacts existence, artifact reality (magic bytes,
  size, squareness), `build:icon` script wiring.
- e2e: not re-run (suite + docs only; unchanged at `a2dcd21`, 1/1).

### M3-07 GREEN (app icon, 2026-10-08)

- Chain: prettier `docs/ src/ tests/ scripts/ *.yml *.json` clean, typecheck
  rc=0, eslint rc=0 (one GREEN fixup: unused `writeFileSync` import in the
  generator — `sips` writes the files, not the script).
- Implementation: `assets/app-icon.svg` (pure-shapes source, 1024 intrinsic)
  - `scripts/build-icon.mjs` (`npm run build:icon`: sips rasterize → master
    PNG → linux artifact; `.iconset` 16..512 + @2x → `iconutil -c icns` →
    darwin artifact; fails loudly when a stock tool is missing, never emits
    placeholders) + committed artifacts `assets/icon.icns` (170 KB) and
    `assets/icon.png` (58 KB, 1024×1024 RGBA) + `electron-builder.yml`
    `mac.icon`/`linux.icon` + the `build:icon` package script.
- Result: **312 passed (312)** / 43 files — all 4 named REDs resolved.
  e2e: 1 passed (1).

### M3-08 RED (i18n groundwork, 2026-10-09)

- Chain: prettier `docs/ src/ tests/` clean, typecheck rc=0, eslint rc=0
  (one RED fixup before this observation: `UNSUPPORTED_FORMAT` was declared
  but the expected sentence was written inline — now the assertion derives
  from the constant; and `/\p{Cyrillic}/u` → `/\p{Script=Cyrillic}/u`,
  the only TS-recognized script-property spelling).
- Suite: **3 failed | 312 passed (315)** — baseline 312 → +3 tests (the
  whole TC-POL-05 describe), 1 file. The 3 observed REDs are the named
  absence pins: `strings.moduleExistsAndTSeamIsByteIdentical` (module +
  `t(key)` + 18 byte-identical rows + the parameterized AC-04.5 sentence),
  `strings.enMapCarriesNoRussianContent` (BRIEF §3), and
  `strings.consumersRenderThroughTheSeam` (all four consumers still
  hardcode their literals — comment-stripped raw-text).
- Observed GREEN in the RED batch: every EXISTING wording pin across the
  e2e/supervisor/proxy/logs/status suites — the M3-08 contract is that the
  seam re-exports exactly those strings, so nothing may move until GREEN.
- Fixup (separate commit, `logs.clear` row): the survey assumed the clear
  button reads `Clear logs` — the shipped JSX reads `Clear` (no test pins
  it either). The row now pins the TRUE current label: the seam must
  re-export what the app shows, and a wording change would need an owner
  decision, never a refactor. The consumer absence-check followed
  (`'Clear'` instead of `'Clear logs'`).

### M3-08 GREEN (i18n seam, 2026-10-09)

- Chain: prettier `docs/ src/ tests/` clean, typecheck rc=0, eslint rc=0
  (one GREEN fixup: `simple-import-sort` in `status-labels.ts`).
- Implementation:
  - `src/shared/strings.ts` (new): the `EN` map (19 keys, `status.*
hint.* action.* tray.* logs.* app.*`) + `t(key, params?)` with
    `{name}` substitution — byte-identical values, no Cyrillic;
  - `status-labels.ts`: every entry resolves through `t('status.*')`
    (local duplicates gone); `App.tsx`: both tunnel hints, the tagline,
    the Start/Stop accessible name and the AC-04.5 sentence render
    through the seam; `LogsView.tsx`: title/buttons/empty state;
    `window-lifecycle.ts`: the four verbatim tray labels.
  - Rendered output unchanged everywhere — identity strings, the
    dev-only IPC line and error triples stayed out (§5 scope decisions).
- Result: **315 passed (315)** / 44 files — all 3 named REDs resolved and
  every pre-existing wording pin green without a single edit (the M3-08
  contract). e2e: 1 passed (1) (the Start/Stop exact-name contract byte-
  identical).

### M3-10 RED (darwin-x64 leg, issue #27, 2026-10-09)

- Chain: prettier `docs/ src/ tests/` clean, typecheck rc=0, eslint rc=0
  (one RED fixup: an apostrophe in the failure message — `waiver'd` —
  broke the single-quoted string; reworded to `waived` before observation).
- Suite: **1 failed | 315 passed (316)** — baseline 315 → +1 test
  (`releaseWorkflow.macBuildsBothArchDmgs`, TC-PKG-21), 1 file. The named
  RED: the mac matrix row still carries `dist_args: ''` (arm64-only — the
  M2 waiver) and the build job has no two-dmg assertion. The
  `core-bin/darwin-${arch}` per-arch core row and the `release/*.dmg`
  glob in the mac row already hold (observed GREEN in the RED batch —
  the Intel dmg would stage the Intel core the moment it builds).
- m2-test-plan §6: TC-PKG-21 row added (the #27 pins continue the PKG
  family there per DV-60 precedent; this §10 carries the M3 execution
  narrative).
- e2e: not re-run (suite + docs only; unchanged at `25994d3`, 1/1).

### M3-10 GREEN (darwin-x64 leg, 2026-10-09)

- Chain: prettier `release.yml` + `docs/ src/ tests/` clean, typecheck
  rc=0, eslint rc=0.
- Implementation (release.yml only — the yml builder config untouched):
  the mac matrix row gains `dist_args: --arm64 --x64` (one leg, both
  arches, one `artifacts-macOS` upload — two rows would collide on the
  `artifacts-${{ runner.os }}` name); a new mac-only step
  `Verify both mac arch dmgs staged (issue #27)` runs `test $(ls
release/*.dmg | wc -l) -ge 2` BETWEEN dist and the manifest — the
  upload's `if-no-files-found: error` cannot see one arch silently
  skipped next to a matching dmg, and the manifest is only written once
  both exist. `core-bin/darwin-${arch}` (observed-GREEN row) resolves
  the Intel core into the Intel dmg automatically.
- Result: **316 passed (316)** / 44 files. e2e: 1 passed (1).
- Validation tag run (M2-07 pattern): pushed after GREEN CI → observe
  both `*-arm64.dmg` + `*-x64.dmg` + SHA256SUMS in the run → delete the
  tag. Empirical outcome appended below when the run completes.

#### M3-10 validation appendix — tag `v0.0.1-m310check`, run `37846078455` (2026-10-09)

- **Result: FAILURE on all three legs** (`build (macos-latest)`,
  `build (ubuntu-latest)`, `build rpm (fedora container)`) — each at the
  electron-builder step with `core pack gate: no staging manifest for
linux-ia32` / `darwin-ia32`. The verify step never even ran (it sits
  after dist), and the ubuntu leg — untouched by M3-10 — failed too, so
  the root cause was NOT the new mac flags.
- Root cause (**DV-65**, §11): `scripts/after-pack-verify.mjs`'s
  `ARCH_BY_ENUM` never matched electron-builder's real `Arch` enum
  (`ia32=0, x64=1, armv7l=2, arm64=3, universal=4` — verified in
  `node_modules/builder-util/out/arch.d.ts`): the shipped table read
  `1 → ia32`, so EVERY x64 build resolved to a never-staged `*-ia32`
  target and tripped the fail-closed gate. Why it shipped: TC-PKG-19/20
  drive `verifyPackedCore({target})` with literal string targets (the
  enum path lives only in the untested default `afterPack` export), and
  the local DV-60 GREEN ran on an arm64 host where `3 → arm64` was
  coincidentally right.
- Fix-forward (TDD, tests only grow): **TC-PKG-22** RED pins the seam
  (`archName` exported, enum rows) and the default entry's target
  resolution (arch 0 → `linux-ia32` fail-closed) → GREEN fixes the
  table + exports the seam → tag deleted and re-pushed; the empirical
  re-run outcome is appended below.

#### Validation re-run — tag `v0.0.1-m310check` @ `5d61e44`, run `37846938932` (2026-10-09)

- **Result: SUCCESS on all three legs** — `build (macos-latest)`,
  `build (ubuntu-latest)`, `build rpm (fedora container)` all green.
- Both mac archs empirically confirmed (issue #27 gate): the new step
  `Verify both mac arch dmgs staged (issue #27)` = success (≥ 2 dmgs —
  `--arm64 --x64` both built), `Build artifacts (electron-builder)` =
  success, `SHA-256 manifest — written then re-verified` = success,
  upload `artifacts-macOS` = 309 863 581 B (≈ double the single-dmg
  M2-07 artifact) + `artifacts-Linux` 266 383 783 B + `artifacts-fedora`
  104 030 552 B — every leg's `if-no-files-found: error` upload green.
- DV-65 confirmed fixed in CI: the pack gate passed on the x64 legs it
  had never actually processed before.
- Tag deleted (local + remote) per the M2-07 pattern — no tag remains.

### Beta build `v0.1.0-beta.1` (M3-11 prep, 2026-10-09)

- Owner picked the beta build while the cohort is pending: version
  bump `0.0.1 → 0.1.0-beta.1` (no test pins the version — verified),
  committed as `3f67cc2` (chain 0, **325 passed (325)**), tag
  `v0.1.0-beta.1` pushed → release run **`37848480103` = SUCCESS on
  all three legs** (macos-latest, ubuntu-latest, fedora container).
- Empirical evidence (mac leg): `Build artifacts` ✓, `Verify both mac
arch dmgs staged (issue #27)` ✓ (≥ 2 dmgs for `0.1.0-beta.1`), `SHA-256
manifest — written then re-verified` ✓; artifacts — `artifacts-macOS`
  309 863 535 B (arm64 + x64 dmg + SHA256SUMS), `artifacts-Linux`
  266 383 789 B (AppImage + deb + SHA256SUMS — the rpm ships in
  `artifacts-fedora`), `artifacts-fedora` 104 042 043 B (native rpm +
  SHA256SUMS).
- Handout path unchanged: `docs/user/beta-setup.md` points testers at
  exactly these artifact names + SHA256SUMS verification. Distribution
  stays the owner's manual step (M2-07 decision — no GitHub Release
  published by CI). M3-11 remains `blocked-owner-cohort`; artifacts are
  built and waiting.

### GitHub Release `v0.1.0-beta.1` (owner-requested, 2026-10-09)

- Evidence pass on run `37848480103` surfaced a naming gap:
  electron-builder drops the arch suffix for the default arch, so the
  Intel dmg shipped as `S3 Bypass Desktop-0.1.0-beta.1.dmg` (arch
  confirmed by `lipo -archs` on the mounted app: `x86_64`; the `-arm64`
  dmg = `arm64`) while `beta-setup.md` promises `-x64.dmg`. TC-PKG-23
  RED `7bb60e4` → GREEN `14c8c52`: `mac.artifactName =
${productName}-${version}-${arch}.dmg` + truthful deb/rpm filenames
  in the user docs; **326 passed (326)**, e2e 1/1.
- Tag re-pushed at GREEN → rebuild run **`37850207592` = SUCCESS on
  all three legs**; `-x64.dmg` present, and all five installers
  verified OK against their per-leg CI `SHA256SUMS.txt`.
- Release published (owner-approved body, marker scan 0 →
  https://github.com/s3network/s3-bypass-desktop/releases/tag/v0.1.0-beta.1)
  — **prerelease** ✓, 5 installers + `SHA256SUMS.txt` (~682 MB).
  GitHub normalizes spaces in asset names to dots, so the attached
  manifest lists `S3.Bypass.Desktop-…` names (re-verified locally:
  `shasum -a 256 -c SHA256SUMS.txt` → 5/5 OK exactly as a tester
  downloads it); the release body carries the normalization note.
- Distribution decision (explicit owner word): the repo was flipped to
  **public** so the release link works without auth — pre-flip marker
  scan over tree + full history came back clean (3 hits, all false
  positives: a stock GPLv3 clause in LICENSE, an ordinary prose
  sentence in an M0 scaffold commit message, and AWS's official
  `AKIAIOSFODNN7EXAMPLE` key in the redaction test). Anonymous fetch
  of the release page and `docs/user/beta-setup.md` → HTTP 200.
- M3-11 stays `blocked-owner-cohort` — release link + handout ready
  for the cohort.

#### DV-65 GREEN (2026-10-09)

- Chain: prettier clean (incl. the script), typecheck rc=0, eslint rc=0.
- Fix (`scripts/after-pack-verify.mjs`): `ARCH_BY_ENUM` realigned to
  `builder-util/out/arch.d.ts` (`0: ia32, 1: x64, 2: armv7l, 3: arm64,
4: universal`), the phantom `armv6l`/`s390x`/`riscv64` enum rows
  dropped (not in the Arch enum — the string passthrough still accepts
  asset-style names, unknown numeric enums still throw), and `archName`
  exported as the TC-PKG-22 seam. The `universal` row resolves to a
  never-staged target → the gate fails closed on it, by design.
- Result (file-scoped): **13 passed (13)** in
  `core-staging-gate.test.ts` — both TC-PKG-22 REDs resolved. The full
  working tree at observation additionally carried the not-yet-committed
  M3-09 RED (§10 batch E entry); this commit stages the DV-65 files only,
  so CI sees a fully green state.

### M3-09 RED (user docs set + README split, 2026-10-09)

- Chain: prettier `docs/ src/ tests/` clean, typecheck rc=0, eslint rc=0.
- Suite: **7 failed | 318 passed (325)** — baseline 316 → +9 tests across
  the two committed REDs of this window; the M3-09 slice is 7 tests
  (`docs-consistency.test.ts`, TC-POL-06) and the DV-65 slice (committed
  separately, §11) is 2. Named REDs — the five doc files don't exist
  (absence via existsSync-gated `userDoc`, never a raw ENOENT), README
  still ends `Not usable yet.`, and the `docs/user/` sweep can't run.
- e2e: not re-run (suite + docs only; unchanged at `5d61e44`, 1/1).

### M3-09 GREEN (user docs set + README split, 2026-10-09)

- Chain: prettier `docs/ src/ tests/ README.md` clean, typecheck rc=0,
  eslint rc=0.
- Implementation:
  - `docs/user/` (five new docs): `install-macos.md` (unsigned +
    Control-click → Open, links the dedicated Gatekeeper doc — the
    gate stays ON, never "disable it"), `install-linux.md` (AppImage
    with the real `chmod +x` + .deb + .rpm), `first-profile.md`
    (quotes the shipped hint/status words verbatim — the TC-POL-05
    tie-in), `troubleshooting.md` (manual **SOCKS 127.0.0.1:10808`,
`Copy logs`support path),`beta-setup.md` (the DoD #1 handout:
    artifact table incl. both mac archs from issue #27, SHA256SUMS
    verification, reporting checklist);
  - README: honest M3/beta status line replaces the M0/M1
    `Not usable yet.` claim; new **Install (beta)** + **First run &
    troubleshooting** sections link all five docs; **Development**
    section untouched.
- Result: **325 passed (325)** / 44 files — all 7 named REDs resolved.
  e2e: 1 passed (1).
- e2e: not re-run for this RED (suite + docs only; unchanged at `e08d2e5`,
  1/1).

---

## 11. Deviations log (QA bookkeeping)

_(Appended per deviation with a DV-64+ row — global DV numbering continues from
m2-test-plan §11 (DV-63 last).)_

| DV    | Batch | Deviation / decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Justification                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DV-64 | M3-03 | Spec amendments inside the RED commit: `errors.md` §0 extended (no `E-…-###` code citation and no OS errno token inside title/cause/nextStep; the `code` field stays internal), §1 gains `E-VAL-016` (no-profile step-0 refusal — DV-19 superseded, the `E-VAL-*` placeholder is gone) and `E-VAL-017` (generic state-machine rejection — was mislabelled `E-VAL-015`, audit B-8c), §3/§4 drop the `E-PLAT-005`/`E-PLAT-001` next-step citations; sibling pins amended accordingly (`E-VAL-015`→`E-VAL-017` in TC-02-07, `E-VAL-*`→`E-VAL-016` in TC-02-03); the canned E-PLAT-002 fixtures in `proxy-wiring.test.ts`/`proxy-toggle.test.tsx` reworded to the amended §4 sentence (and the `system-proxy.test.ts` TC-04-06 substring pin with them); the two new `FORBIDDEN` rules are `userTextOnly`.                                                                                                 | Owner-approved M3 batch A ("error-wording pass") on 2026-10-08; wording is strengthened, no existing pin weakened or removed (strategy §5.2); the `userTextOnly` split follows §0 itself (the code is internal _by design_ — only its citation inside user text is forbidden), so the canary/stack/`Error:` rules keep scanning `tripleText` unchanged.                     |
| DV-65 | M3-10 | The validation tag run (`v0.0.1-m310check`, run 37846078455) failed all three legs on the afterPack core gate: `ARCH_BY_ENUM` in `scripts/after-pack-verify.mjs` never matched electron-builder's real `Arch` enum (`ia32=0, x64=1, armv7l=2, arm64=3, universal=4`), so every x64 build resolved to a never-staged `*-ia32` target and the fail-closed gate (issue #20 / DV-60) did exactly its job. Fix-forward inside the M3-10 window: **TC-PKG-22** (new, m2-test-plan §6) pins the exported `archName` seam row by row (including the CI-caught `1 → x64`) and the default `afterPack(context)` target resolution (arch 0 → `linux-ia32` fail-closed); GREEN aligns the table with `builder-util/out/arch.d.ts`, drops the phantom `s390x`/`riscv64`/`armv6l` enum entries (they do not exist in the Arch enum — the string passthrough still accepts them) and exports `archName` for the test. | Release runs are the empirical layer of DoD #1; the gate's own tests (TC-PKG-19) could not see this because they pass literal STRING targets — the enum path lived only in the untested default export, and the DV-60 local GREEN ran on an arm64 host where `3 → arm64` was coincidentally right. No existing pin weakened; the deviation is a DEV bug fix + two new pins. |

### Beta build `v0.1.0-beta.3` — our own core + signed bundle (2026-10-09)

- **Why**: beta.1 bundled the upstream engine, whose writer abandons a
  file after `uploadAttempts`. The peer reads strictly in sequence and
  cannot skip a missing object, so one lost file wedged the session: a
  6×50 MB burst froze all traffic for ~4 min while the UI kept showing
  "Connected" (owner machine, 2026-10-09).
- **What**: core repinned to `s3network/s3-bypass-protocol`
  `v0.1.0-fork.3` (based on upstream `26.9.9-1.0.1fed`, so the engine
  version and log wording are unchanged). `uploadUntilDelivered` retries
  a file until the backend takes it; the client additionally fails over
  in ~13 s instead of minutes.
- **Evidence before pinning**: our server + our client on the owner's
  bucket, isolated prefix — 600 MB over six parallel 50 MB streams, two
  rounds, every byte delivered, 0 holes, 0 teardowns, 1 session. Same
  test upstream: stalls in ~9 s, ~4 min to recover.
- **Also in this build**: the bundled core now ships the fork README
  (the Project X one with NFT/sponsor promotion was inside the ZIPs);
  asset digests re-verified against the release `.dgst` files.
- Version bump `0.1.0-beta.1 → 0.1.0-beta.2`; no test pins the version.

### Beta build `v0.1.0-beta.3` — Gatekeeper fix (2026-10-09)

- **Symptom**: beta.2 could not be opened — macOS showed "приложение
  повреждено".
- **Not a bad download**: the dmg hash matched the manifest, and beta.1
  was checked afterwards and shipped the same defect.
- **Cause**: `mac.identity: null` (BRIEF §10) leaves the Mach-O with the
  linker's ad-hoc signature but no bundle seal — no
  `Contents/_CodeSignature` at all. spctl then reports "code has no
  resources but signature indicates they must be present", which macOS
  renders as damage.
- **Fix**: TC-PKG-24 — the pack hook ad-hoc signs the bundle as its last
  step (after the core is packed; adding files invalidates signatures).
  Gatekeeper still asks the tester to confirm the first launch, but the
  prompt is now truthful.
- Verified by TC-PKG-24 (5 specs): `_CodeSignature` produced,
  `codesign --verify` passes, spctl no longer reports the broken seal,
  re-signing is idempotent, hook is a no-op off macOS.
- Deviation from beta.2: version bump only.
