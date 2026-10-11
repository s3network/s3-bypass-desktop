/**
 * The desktop update checker (RED) — which release is newer, and which
 * artifact a given machine can actually install.
 *
 * ── Why the release LIST and not /releases/latest ──────────────────────────
 * Every desktop release so far is a GitHub *prerelease* (v0.1.0-beta.1..3),
 * and `GET /releases/latest` excludes prereleases by definition. Against this
 * repository it answers 404 — measured, not assumed. A checker built on that
 * endpoint would report "no update" forever while newer builds sat published,
 * which is the worst possible failure for an updater: it looks healthy.
 *
 * So the checker reads the release list and selects by VERSION, not by date
 * and not by the server's opinion of "latest".
 *
 * ── Why selection is by version ────────────────────────────────────────────
 * The list is not sorted by anything we can rely on: `v1.1.1` sits above
 * `v0.1.0-android.2` by date while being newer by version, and the Android
 * repository carries both naming lines at once. Highest semver wins, with the
 * published date only as a tie-break between equal versions.
 *
 * ── Why asset matching is strict ───────────────────────────────────────────
 * The repository ships dmg (macOS), AppImage/deb/rpm (Linux) and NO Windows
 * build at all. Offering a Windows user a download link would point at a file
 * that does not exist, so an unmatched platform reports "newer version exists,
 * no installer for this platform" and falls back to the release page.
 *
 * Contract (mirrored as `UpdateCheckerModule` below, header-contract style):
 *   module : src/main/update-checker.ts
 *   compareVersions(a, b)      → number  (numeric per component)
 *   pickAsset(assets, p, arch) → asset | null
 *   parseReleases(body, p, a)  → candidate list, newest first
 *   checkForUpdate(opts)       → UpdateCheckResult  (never throws)
 * The module does no electron import and no I/O beyond the single injected
 * fetch, so every case here is hermetic — the network is a parameter.
 */
import { describe, expect, it } from 'vitest';

import type { FetchLike, UpdateCheckerModule } from '../helpers/update-checker-stub';

/**
 * Non-literal specifier so `npm run typecheck` stays exit 0 while the module
 * is still absent (the RED gate this file opens) — same seam the other
 * main-module suites use.
 */
const UPDATE_CHECKER_SPECIFIER = '../../src/main/update-checker';
async function loadUpdateChecker(): Promise<UpdateCheckerModule> {
  return (await import(/* @vite-ignore */ UPDATE_CHECKER_SPECIFIER)) as UpdateCheckerModule;
}

interface Asset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface RawRelease {
  tag_name: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
  assets: Asset[];
}

function release(over: Partial<RawRelease> = {}): RawRelease {
  return {
    tag_name: 'v0.1.0-beta.3',
    html_url: 'https://github.com/s3network/s3-bypass-desktop/releases/tag/v0.1.0-beta.3',
    prerelease: true,
    draft: false,
    published_at: '2026-10-09T20:15:25Z',
    assets: [],
    ...over,
  };
}

const DMG_ARM64: Asset = {
  name: 'S3.Bypass.Desktop-0.1.0-beta.3-arm64.dmg',
  browser_download_url: 'https://example.invalid/arm64.dmg',
  size: 151_811_849,
};
const DMG_X64: Asset = {
  name: 'S3.Bypass.Desktop-0.1.0-beta.3-x64.dmg',
  browser_download_url: 'https://example.invalid/x64.dmg',
  size: 159_888_255,
};
const APPIMAGE: Asset = {
  name: 'S3.Bypass.Desktop-0.1.0-beta.3.AppImage',
  browser_download_url: 'https://example.invalid/app.AppImage',
  size: 149_800_636,
};
const DEB: Asset = {
  name: 's3-bypass-desktop_0.1.0-beta.3_amd64.deb',
  browser_download_url: 'https://example.invalid/app.deb',
  size: 117_333_772,
};
const CHECKSUMS: Asset = {
  name: 'SHA256SUMS.txt',
  browser_download_url: 'https://example.invalid/SHA256SUMS.txt',
  size: 533,
};

/** The six assets of the real v0.1.0-beta.3 release, verbatim. */
function realBeta3(): RawRelease {
  return release({
    assets: [DMG_ARM64, DMG_X64, APPIMAGE, DEB, CHECKSUMS],
  });
}

describe('update-checker — version comparison', () => {
  it('update.compare.greaterVersionComparesGreater', async () => {
    const { compareVersions } = await loadUpdateChecker();
    expect(compareVersions('0.1.0-beta.4', '0.1.0-beta.3')).toBeGreaterThan(0);
  });

  it('update.compare.equalVersionsCompareEqual', async () => {
    const { compareVersions } = await loadUpdateChecker();
    expect(compareVersions('0.1.0-beta.3', '0.1.0-beta.3')).toBe(0);
  });

  it('update.compare.leadingVIsStrippedOnBothSides', async () => {
    // Without stripping, a stray "v" parses as component 0 and silently
    // downgrades "v1.2.0" to 0.2.0 — an update hidden behind a wrong answer.
    const { compareVersions } = await loadUpdateChecker();
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('v1.2.0', '0.9.9')).toBeGreaterThan(0);
  });

  it('update.compare.numericNotLexicographicAtTen', async () => {
    // The classic trap: "beta.10" < "beta.9" as strings, so the tenth
    // release after the ninth would never be offered.
    const { compareVersions } = await loadUpdateChecker();
    expect(compareVersions('0.1.0-beta.10', '0.1.0-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1.10', '1.1.9')).toBeGreaterThan(0);
  });

  it('update.compare.missingComponentCountsAsZero', async () => {
    const { compareVersions } = await loadUpdateChecker();
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('1.1.1', '1.1')).toBeGreaterThan(0);
  });

  it('update.compare.unparseableComponentCountsAsZeroNotNewer', async () => {
    // A malformed tag must never make an update look available.
    const { compareVersions } = await loadUpdateChecker();
    expect(compareVersions('total-garbage', '0.0.0')).toBe(0);
  });
});

describe('update-checker — asset matching', () => {
  it('update.asset.macArm64PicksTheArm64Dmg', async () => {
    const { pickAsset } = await loadUpdateChecker();
    const picked = pickAsset([DMG_X64, DMG_ARM64, APPIMAGE], 'darwin', 'arm64');
    expect(picked?.name).toBe(DMG_ARM64.name);
  });

  it('update.asset.macX64PicksTheX64Dmg', async () => {
    const { pickAsset } = await loadUpdateChecker();
    const picked = pickAsset([DMG_ARM64, DMG_X64], 'darwin', 'x64');
    expect(picked?.name).toBe(DMG_X64.name);
  });

  it('update.asset.linuxPicksTheAppImageNotTheDeb', async () => {
    // AppImage is the only artifact that can be replaced in place; .deb/.rpm
    // belong to the system package manager, not to the app.
    const { pickAsset } = await loadUpdateChecker();
    const picked = pickAsset([DEB, APPIMAGE], 'linux', 'x64');
    expect(picked?.name).toBe(APPIMAGE.name);
  });

  it('update.asset.windowsHasNoBuildAndPicksNothing', async () => {
    // The repository publishes no Windows artifact. Offering one would point
    // the user at a file that does not exist.
    const { pickAsset } = await loadUpdateChecker();
    expect(pickAsset([DMG_ARM64, APPIMAGE, DEB], 'win32', 'x64')).toBeNull();
  });

  it('update.asset.neverPicksTheChecksumFile', async () => {
    const { pickAsset } = await loadUpdateChecker();
    const picked = pickAsset([CHECKSUMS, DMG_ARM64], 'darwin', 'arm64');
    expect(picked?.name).not.toBe(CHECKSUMS.name);
  });

  it('update.asset.noMatchingPlatformYieldsNull', async () => {
    const { pickAsset } = await loadUpdateChecker();
    expect(pickAsset([DMG_ARM64], 'linux', 'x64')).toBeNull();
  });
});

describe('update-checker — release list parsing', () => {
  it('update.parse.readsPrereleaseListThatLatestEndpointWouldHide', async () => {
    // Every real desktop release is a prerelease, so /releases/latest is 404.
    const { parseReleases } = await loadUpdateChecker();
    const parsed = parseReleases(JSON.stringify([realBeta3()]), 'darwin', 'arm64');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.tag).toBe('v0.1.0-beta.3');
    expect(parsed[0]?.url).toBe(DMG_ARM64.browser_download_url);
  });

  it('update.parse.draftsAreExcluded', async () => {
    const { parseReleases } = await loadUpdateChecker();
    const body = JSON.stringify([release({ tag_name: 'v9.9.9', draft: true })]);
    expect(parseReleases(body, 'darwin', 'arm64')).toHaveLength(0);
  });

  it('update.parse.sortsByVersionNotByListOrder', async () => {
    // Newer by date, older by version — the list order must not decide.
    const { parseReleases } = await loadUpdateChecker();
    const body = JSON.stringify([
      release({
        tag_name: 'v0.1.0-beta.4',
        published_at: '2026-10-01T00:00:00Z',
        assets: [
          {
            name: 'S3.Bypass.Desktop-0.1.0-beta.4-arm64.dmg',
            browser_download_url: 'https://example.invalid/beta4.dmg',
            size: 1,
          },
        ],
      }),
      release({
        tag_name: 'v0.1.0-beta.10',
        published_at: '2026-09-01T00:00:00Z',
        assets: [
          {
            name: 'S3.Bypass.Desktop-0.1.0-beta.10-arm64.dmg',
            browser_download_url: 'https://example.invalid/beta10.dmg',
            size: 1,
          },
        ],
      }),
    ]);
    const parsed = parseReleases(body, 'darwin', 'arm64');
    expect(parsed[0]?.tag).toBe('v0.1.0-beta.10');
  });

  it('update.parse.survivesMalformedBodyWithoutThrowing', async () => {
    const { parseReleases } = await loadUpdateChecker();
    expect(parseReleases('not json at all', 'darwin', 'arm64')).toEqual([]);
    expect(parseReleases('{"nope":true}', 'darwin', 'arm64')).toEqual([]);
  });

  it('update.parse.assetlessReleaseIsSkipped', async () => {
    const { parseReleases } = await loadUpdateChecker();
    expect(parseReleases(JSON.stringify([release()]), 'darwin', 'arm64')).toEqual([]);
  });
});

describe('update-checker — checkForUpdate', () => {
  /** A fetch stub returning the given body; records how it was called. */
  function fetchReturning(body: string, code = 200): { impl: FetchLike; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      impl: async (
        url: string,
      ): Promise<{
        ok: boolean;
        status: number;
        json: () => Promise<unknown>;
      }> => {
        calls.push(url);
        return {
          ok: code >= 200 && code < 300,
          status: code,
          json: async () => JSON.parse(body),
        };
      },
    };
  }

  it('update.check.reportsNewerVersionWithThePlatformArtifact', async () => {
    const { checkForUpdate } = await loadUpdateChecker();
    const stub = fetchReturning(JSON.stringify([realBeta3()]));
    const result = await checkForUpdate({
      current: '0.1.0-beta.2',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: stub.impl,
    });
    expect(result.available).toBe(true);
    expect(result.current).toBe('0.1.0-beta.2');
    expect(result.latest).toBe('0.1.0-beta.3');
    expect(result.url).toBe(DMG_ARM64.browser_download_url);
  });

  it('update.check.currentBuildReportsUpToDate', async () => {
    const { checkForUpdate } = await loadUpdateChecker();
    const stub = fetchReturning(JSON.stringify([realBeta3()]));
    const result = await checkForUpdate({
      current: '0.1.0-beta.3',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: stub.impl,
    });
    expect(result.available).toBe(false);
    expect(result.url).toBeNull();
  });

  it('update.check.newerVersionWithoutThisPlatformStillReportsAndKeepsPage', async () => {
    // The honest answer: a newer build exists, this machine cannot install it,
    // here is where to read about it. Silently reporting "up to date" would
    // leave the user on a build they were told is current.
    const { checkForUpdate } = await loadUpdateChecker();
    const stub = fetchReturning(JSON.stringify([realBeta3()]));
    const result = await checkForUpdate({
      current: '0.1.0-beta.1',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: stub.impl,
    });
    expect(result.available).toBe(true);
    expect(result.latest).toBe('0.1.0-beta.3');
    expect(result.url).toBeNull();
    expect(result.pageUrl).toContain('github.com');
  });

  it('update.check.networkFailureIsSilentAndNotAnUpdate', async () => {
    // This is a VPN client: when the tunnel is down the lookup may never
    // answer. An updater that throws a dialog there makes the one thing the
    // user needs worse.
    const { checkForUpdate } = await loadUpdateChecker();
    const result = await checkForUpdate({
      current: '0.1.0-beta.2',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(result.available).toBe(false);
    expect(result.latest).toBeNull();
  });

  it('update.check.rateLimitIsSilentAndNotAnUpdate', async () => {
    const { checkForUpdate } = await loadUpdateChecker();
    const stub = fetchReturning('{"message":"API rate limit exceeded"}', 403);
    const result = await checkForUpdate({
      current: '0.1.0-beta.2',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: stub.impl,
    });
    expect(result.available).toBe(false);
    expect(result.latest).toBeNull();
  });

  it('update.check.emptyReleaseListReportsNoUpdate', async () => {
    const { checkForUpdate } = await loadUpdateChecker();
    const stub = fetchReturning('[]');
    const result = await checkForUpdate({
      current: '0.1.0-beta.2',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: stub.impl,
    });
    expect(result.available).toBe(false);
  });

  it('update.check.queriesTheReleaseListNotTheLatestEndpoint', async () => {
    // The pin that keeps this from regressing: /releases/latest 404s while
    // every release is a prerelease.
    const { checkForUpdate, RELEASES_URL } = await loadUpdateChecker();
    const stub = fetchReturning('[]');
    await checkForUpdate({
      current: '0.1.0-beta.2',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: stub.impl,
    });
    expect(stub.calls[0]).toBe(RELEASES_URL);
    expect(RELEASES_URL).not.toContain('/releases/latest');
  });
});
