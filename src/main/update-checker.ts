/**
 * The update checker: is there a newer build, and which artifact can THIS
 * machine install?
 *
 * ── Why the release LIST, not /releases/latest ─────────────────────────────
 * Every desktop release so far is a GitHub *prerelease* (v0.1.0-beta.1..3),
 * and `GET /releases/latest` excludes prereleases by definition. Measured
 * against this repository it answers **404**. A checker built on that endpoint
 * would report "no update" forever while newer builds sat published — the
 * worst shape an updater can have, because it looks perfectly healthy.
 *
 * So: read the release list and decide by VERSION. Not by date (the Android
 * repository carries two naming lines at once, where list order and version
 * order disagree), and not by the server's opinion of "latest".
 *
 * ── What this can and cannot do ────────────────────────────────────────────
 * The macOS build is UNSIGNED by owner decision (no Apple Developer account),
 * and an unsigned bundle cannot replace itself in place — Squirrel.Mac and
 * every equivalent require a signature. So this module never claims to
 * install anything: it reports a newer version and hands over the exact
 * artifact for the machine's platform and architecture. On Linux the AppImage
 * is the self-replaceable artifact; .deb and .rpm belong to the system package
 * manager, so they are never offered as "the update".
 *
 * ── Failure is silent, by design ───────────────────────────────────────────
 * This is a VPN client. When its own tunnel is broken the lookup may never
 * complete, and an updater that blocks the interface or raises a dialog at
 * that moment makes the one thing the user needs worse. Every failure path —
 * DNS, timeout, 403 rate limit, malformed body — resolves to "no update
 * known" and never throws.
 *
 * Contract: tests/unit/update-checker.test.ts (and its type mirror in
 * tests/helpers/update-checker-stub.ts). The module imports no electron and
 * performs no I/O beyond the single injected fetch, so every case is
 * hermetic — the network is a parameter, never a global the tests trip over.
 */

/**
 * The platform tag a build is selected for.
 *
 * `NodeJS.Platform` rather than the three platforms this repository actually
 * publishes: `process.platform` is a wider union (aix, freebsd, android…) and
 * narrowing it at the call site would mean silently mapping the ones with no
 * build onto a platform that has one. Every value outside darwin/linux falls
 * through `pickAsset` to null, which the checker reports as "newer version,
 * no installer for this platform".
 */
export type PlatformName = NodeJS.Platform;

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
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
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

export const RELEASES_URL =
  'https://api.github.com/repos/s3network/s3-bypass-desktop/releases?per_page=20';

/** Matches the artifact layout of the release workflow (electron-builder names). */
const MAC_DMG_SUFFIX: Record<string, string> = {
  arm64: '-arm64.dmg',
  x64: '-x64.dmg',
};
const LINUX_ASSET_SUFFIX = '.AppImage';

/**
 * Compares dotted version strings component by component, numerically.
 *
 * String comparison gets this wrong at the exact moment it matters: "1.1.9" >
 * "1.1.10" lexicographically, so the tenth release after the ninth would
 * never be offered and a stale build would look current forever. Every
 * component is parsed as a number and any non-numeric tail is dropped, which
 * is what makes `0.1.0-beta.10` sort above `0.1.0-beta.9`.
 */
export function compareVersions(a: string, b: string): number {
  // Strip a leading "v" on BOTH sides. parseReleases already removes it from
  // the tag, but without this a stray "v" becomes a component that parses as
  // 0 — silently downgrading "v1.2.0" to 0.2.0 and hiding an update behind a
  // wrong answer.
  const left = a.replace(/^v/, '').split('.');
  const right = b.replace(/^v/, '').split('.');
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const l = digitsOf(left[index]);
    const r = digitsOf(right[index]);
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * The numeric prefix of one component, or 0.
 *
 * `undefined` (component missing) and a component with no leading digits both
 * count as 0 rather than throwing: a malformed tag must never be able to make
 * an update look available.
 */
function digitsOf(component: string | undefined): number {
  if (component === undefined) return 0;
  const digits = /^\d+/.exec(component);
  return digits === null ? 0 : Number.parseInt(digits[0], 10);
}

/** True when `remote` is strictly newer than `local`. */
export function isNewer(remote: string, local: string): boolean {
  return compareVersions(remote, local) > 0;
}

/**
 * The artifact this machine can install, or null.
 *
 * Strict by design: offering a Windows user a link would point at a file this
 * repository never publishes, and a .deb/.rpm would ask the app to overwrite
 * what the system package manager owns.
 */
export function pickAsset(
  assets: readonly ReleaseAsset[],
  platform: PlatformName,
  arch: string,
): ReleaseAsset | null {
  for (const asset of assets) {
    if (platform === 'darwin') {
      const suffix = MAC_DMG_SUFFIX[arch];
      if (suffix !== undefined && asset.name.endsWith(suffix)) return asset;
    } else if (platform === 'linux' && asset.name.endsWith(LINUX_ASSET_SUFFIX)) {
      // The AppImage name carries no architecture (electron-builder emits one
      // AppImage per build), so any arch matches it.
      return asset;
    }
  }
  return null;
}

/** A release as it arrives, before any of our selection. */
interface RawRelease {
  tag_name?: unknown;
  html_url?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Version from a tag: `v0.1.0-beta.3` → `0.1.0-beta.3`. */
function versionOf(tag: string): string {
  return tag.replace(/^v/, '');
}

function toAssets(value: unknown): ReleaseAsset[] {
  if (!Array.isArray(value)) return [];
  const assets: ReleaseAsset[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = asString(record['name']);
    const url = asString(record['browser_download_url']);
    if (name === '' || url === '') continue;
    const size = record['size'];
    assets.push({
      name,
      browser_download_url: url,
      size: typeof size === 'number' ? size : 0,
    });
  }
  return assets;
}

function toReleases(parsed: unknown): RawRelease[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is RawRelease => typeof entry === 'object' && entry !== null);
}

/** Body may be the raw text or an already-parsed value (the fetch path). */
function toParsed(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Drafts are never a released build. */
function isDraft(release: RawRelease): boolean {
  return release['draft'] === true;
}

/**
 * Newest first, by version, with the published date only breaking ties.
 *
 * The list order is not a contract — the Android repository shows why:
 * `v1.1.1` is above `v0.1.0-android.2` by date while being newer by
 * version, and which one wins depends on nothing we control.
 */
function sortNewestFirst<T extends { version: string; publishedAt: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const byVersion = compareVersions(b.version, a.version);
    if (byVersion !== 0) return byVersion;
    return a.publishedAt < b.publishedAt ? 1 : -1;
  });
}

/** Every release that carries an artifact for this platform, newest first. */
export function parseReleases(
  body: unknown,
  platform: PlatformName,
  arch: string,
): ReleaseCandidate[] {
  const releases = toReleases(toParsed(body));
  const candidates: (ReleaseCandidate & { publishedAt: string })[] = [];
  for (const release of releases) {
    if (isDraft(release)) continue;
    const tag = asString(release['tag_name']);
    const version = versionOf(tag);
    if (tag === '' || version === '') continue;
    const asset = pickAsset(toAssets(release['assets']), platform, arch);
    if (asset === null) continue;
    candidates.push({
      tag,
      version,
      url: asset.browser_download_url,
      assetName: asset.name,
      sizeBytes: asset.size,
      pageUrl: asString(release['html_url']),
      prerelease: release['prerelease'] === true,
      publishedAt: asString(release['published_at']),
    });
  }
  return sortNewestFirst(candidates).map(({ publishedAt: _publishedAt, ...rest }) => rest);
}

/**
 * The newest release regardless of artifact — what "you are behind" is
 * measured against.
 *
 * This is deliberately separate from `parseReleases`. A Windows user, or a
 * macOS user on an architecture nobody published, must still learn that a
 * newer build exists: answering "up to date" while the app is behind is the
 * same lie as a broken checker, just quieter.
 */
function newestRelease(
  body: unknown,
): { version: string; pageUrl: string; prerelease: boolean } | null {
  const releases = toReleases(toParsed(body)).filter((release) => !isDraft(release));
  const stamped = releases
    .map((release) => {
      const version = versionOf(asString(release['tag_name']));
      return version === ''
        ? null
        : {
            version,
            pageUrl: asString(release['html_url']),
            prerelease: release['prerelease'] === true,
            publishedAt: asString(release['published_at']),
          };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return sortNewestFirst(stamped)[0] ?? null;
}

/** The "could not determine anything" answer — used by every failure path. */
function unknownUpdate(current: string): UpdateCheckResult {
  return {
    current,
    latest: null,
    available: false,
    url: null,
    assetName: null,
    sizeBytes: null,
    pageUrl: null,
    prerelease: false,
  };
}

/**
 * Asks GitHub for a newer build. Never throws.
 *
 * `fetchImpl` is a parameter so tests never touch the network; the production
 * call is the global `fetch` bound to this module.
 */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult> {
  const current = versionOf(options.current);
  const timeoutMs = options.timeoutMs ?? 6_000;
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike) ?? null;
  if (doFetch === null) return unknownUpdate(current);

  let body: unknown;
  try {
    const response = await doFetch(RELEASES_URL, {
      // The app is a VPN client: the request may never answer. Node's timeout
      // signal is unref'd, so a pending check never holds the process open.
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 403 here is almost always the unauthenticated rate limit (60/hour per
    // address). Not worth interrupting anyone for.
    if (!response.ok) return unknownUpdate(current);
    body = await response.json();
  } catch {
    // Expected whenever the tunnel is down. Silent by design.
    return unknownUpdate(current);
  }

  try {
    const newest = newestRelease(body);
    if (newest === null) return unknownUpdate(current);

    const available = isNewer(newest.version, current);
    // Offer an artifact only when it belongs to the version being reported AND
    // that version is actually ahead. An older dmg is not "the update", and a
    // download link on a build that is already current is just a trapdoor.
    const artifact = parseReleases(body, options.platform, options.arch)[0];
    const match =
      available && artifact !== undefined && artifact.version === newest.version ? artifact : null;

    return {
      current,
      latest: newest.version,
      available,
      url: match?.url ?? null,
      assetName: match?.assetName ?? null,
      sizeBytes: match?.sizeBytes ?? null,
      pageUrl:
        newest.pageUrl === ''
          ? `https://github.com/s3network/s3-bypass-desktop/releases`
          : newest.pageUrl,
      prerelease: newest.prerelease,
    };
  } catch {
    return unknownUpdate(current);
  }
}
