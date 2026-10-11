// @vitest-environment jsdom
/**
 * The update surface (RED) — the button exists only when a newer version is
 * real, and it hands over the artifact this machine can install.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT (header-contract style):
 *
 *  - `UpdateBanner` (src/renderer/src/components/UpdateBanner.tsx) asks main
 *    through `window.s3Bypass.checkForUpdate()` on mount and renders from that
 *    answer alone — the renderer never compares versions or picks a file, it
 *    only displays what main resolved.
 *  - The download control is ABSENT unless `available` is true. A control
 *    that is usually inert trains people to dismiss the one time it is not.
 *  - `window.s3Bypass.openUpdate()` takes no argument: main opens the URL it
 *    published in its own last answer.
 *  - A check that fails is reported as "could not check", never as an error
 *    dialog — the app is a VPN client and the lookup dies with the tunnel.
 *
 * RED status: ABSENCE RED — no UpdateBanner exists (docs/qa/strategy.md §5.2,
 * legitimate first-test-of-a-subsystem failure).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import UpdateBanner from '../../src/renderer/src/components/UpdateBanner';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stubApi(check: unknown, open: unknown = { ok: true }): void {
  Object.defineProperty(window, 's3Bypass', {
    configurable: true,
    value: {
      checkForUpdate: () => Promise.resolve(check),
      openUpdate: () => Promise.resolve(open),
    },
  });
}

const CURRENT: Record<string, unknown> = {
  current: '0.1.0-beta.2',
  latest: '0.1.0-beta.3',
  available: true,
  url: 'https://example.invalid/arm64.dmg',
  assetName: 'S3.Bypass.Desktop-0.1.0-beta.3-arm64.dmg',
  sizeBytes: 151_811_849,
  pageUrl: 'https://github.com/s3network/s3-bypass-desktop/releases/tag/v0.1.0-beta.3',
  prerelease: true,
};

describe('UpdateBanner — the control appears only for a real update', () => {
  it('update.ui.noButtonWhenTheBuildIsCurrent', async () => {
    stubApi({ ...CURRENT, available: false, url: null, assetName: null, sizeBytes: null });
    render(<UpdateBanner />);
    await waitFor(() => expect(screen.getByText(/latest version/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
  });

  it('update.ui.noButtonWhileTheCheckHasNotAnswered', async () => {
    stubApi(CURRENT);
    // Nothing is known yet, so nothing is offered — the button must not flash
    // in on every launch and then retract itself.
    const { container } = render(<UpdateBanner />);
    expect(container.querySelectorAll('button').length).toBe(0);
    await waitFor(() => expect(screen.getByRole('button', { name: /download/i })).toBeTruthy());
  });

  it('update.ui.downloadButtonWhenANewerVersionExists', async () => {
    stubApi(CURRENT);
    render(<UpdateBanner />);
    await waitFor(() => expect(screen.getByRole('button', { name: /download/i })).toBeTruthy());
    // The sentence, not a bare version: the asset name carries the same
    // string, and a loose matcher here would pass on the wrong element.
    expect(screen.getByText(/^Version 0\.1\.0-beta\.3 is available$/)).toBeTruthy();
  });

  it('update.ui.buttonOpensTheDownloadThroughMain', async () => {
    const openUpdate = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 's3Bypass', {
      configurable: true,
      value: { checkForUpdate: () => Promise.resolve(CURRENT), openUpdate },
    });
    render(<UpdateBanner />);
    const button = await screen.findByRole('button', { name: /download/i });
    fireEvent.click(button);
    await waitFor(() => expect(openUpdate).toHaveBeenCalledTimes(1));
    // No URL crosses the bridge — main opens the one it published itself.
    expect(openUpdate.mock.calls[0]?.length ?? 0).toBe(0);
  });
});

describe('UpdateBanner — the honest answers', () => {
  it('update.ui.unknownPlatformFallsBackToTheReleasePage', async () => {
    // A newer build exists but this machine has no installer for it. Saying
    // "you are up to date" would leave the user knowingly behind.
    stubApi({ ...CURRENT, url: null, assetName: null, sizeBytes: null });
    render(<UpdateBanner />);
    await waitFor(() => expect(screen.getByRole('button', { name: /view release/i })).toBeTruthy());
    expect(screen.getByText(/0\.1\.0-beta\.3/)).toBeTruthy();
  });

  it('update.ui.failedCheckIsReportedNotThrown', async () => {
    stubApi({ current: '0.1.0-beta.2', latest: null, available: false, url: null });
    render(<UpdateBanner />);
    await waitFor(() => expect(screen.getByText(/could not check/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
  });

  it('update.ui.rejectedCheckIsSurvived', async () => {
    Object.defineProperty(window, 's3Bypass', {
      configurable: true,
      value: { checkForUpdate: () => Promise.reject(new Error('ENOTFOUND')) },
    });
    render(<UpdateBanner />);
    await waitFor(() => expect(screen.getByText(/could not check/i)).toBeTruthy());
  });

  it('update.ui.absentBridgeIsSurvived', async () => {
    // Plain-browser render (no Electron): the component must not throw.
    Object.defineProperty(window, 's3Bypass', { configurable: true, value: undefined });
    const { container } = render(<UpdateBanner />);
    expect(container).toBeTruthy();
  });
});
