/**
 * Type surface for `src/main/update-checker.ts`, mirrored from the contract
 * declared in tests/unit/update-checker.test.ts (header-contract style, the
 * same pattern profile-validator-stub.ts uses).
 *
 * Exists so the RED test typechecks while the module is still absent: the
 * import in the suite goes through a non-literal specifier, which TypeScript
 * cannot follow, so the shapes the suite relies on are declared here instead.
 */
import type { PlatformName } from '../../src/main/update-checker';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface ReleaseCandidate {
  tag: string;
  version: string;
  url: string;
  assetName: string;
  sizeBytes: number;
  pageUrl: string;
  prerelease: boolean;
}

export interface UpdateCheckResult {
  /** The running build's version, without a leading `v`. */
  current: string;
  /** Newest published version, or null when it could not be determined. */
  latest: string | null;
  /** True only when `latest` is strictly newer than `current`. */
  available: boolean;
  /** Download URL for this platform, or null when no artifact matches. */
  url: string | null;
  assetName: string | null;
  sizeBytes: number | null;
  /** Always present when a release was found — the human-readable fallback. */
  pageUrl: string | null;
  prerelease: boolean;
}

/** The injected network call — a parameter so every case stays hermetic. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface CheckForUpdateOptions {
  current: string;
  platform: PlatformName;
  arch: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface UpdateCheckerModule {
  RELEASES_URL: string;
  compareVersions(a: string, b: string): number;
  isNewer(remote: string, local: string): boolean;
  pickAsset(
    assets: readonly ReleaseAsset[],
    platform: PlatformName,
    arch: string,
  ): ReleaseAsset | null;
  parseReleases(body: string, platform: PlatformName, arch: string): ReleaseCandidate[];
  checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult>;
}
