import { useEffect, useState } from 'react';

import type { UpdateCheckResult } from '../../../shared/ipc';
import { t } from '../../../shared/strings';

/**
 * The update surface: one button, shown only when a newer build really exists.
 *
 * The renderer decides nothing here. It asks main once on mount and renders
 * main's answer verbatim — which version, which file, whether there is a file
 * for this machine at all. Version comparison and artifact selection live in
 * src/main/update-checker.ts, where they are testable without a window.
 *
 * Why the button is conditional rather than always present with a polite
 * message: a control that is inert almost every time teaches people to dismiss
 * it, and they will dismiss it on the one launch where it matters.
 *
 * Why nothing is rendered until the check answers: flashing a control in and
 * retracting it on every start is worse than waiting a moment. The check has a
 * six-second ceiling and swallows its own failures — this is a VPN client, and
 * the lookup dies with the tunnel, which must never become a dialog.
 */
export default function UpdateBanner() {
  const [state, setState] = useState<
    { kind: 'checking' } | { kind: 'answer'; result: UpdateCheckResult } | { kind: 'failed' }
  >({ kind: 'checking' });
  const [openFailed, setOpenFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.s3Bypass
      ?.checkForUpdate?.()
      .then((result) => {
        if (!cancelled && result != null) {
          setState({ kind: 'answer', result });
        }
      })
      .catch(() => {
        // A lookup that never answers is the normal case with a dead tunnel.
        if (!cancelled) setState({ kind: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'checking') {
    return null;
  }

  if (state.kind === 'failed') {
    return (
      <section className="status update">
        <h2>{t('update.title')}</h2>
        <p className="hint">{t('update.checkFailed')}</p>
      </section>
    );
  }

  const { result } = state;

  // No artifact for this platform: say the newer build exists and where to
  // read about it, rather than pretending this machine is current.
  if (result.available && result.url === null) {
    return (
      <section className="status update">
        <h2>{t('update.title')}</h2>
        <p>{t('update.available', { version: result.latest ?? '' })}</p>
        <div className="update-actions">
          <button
            type="button"
            onClick={() => {
              setOpenFailed(false);
              window.s3Bypass
                ?.openUpdate?.()
                .then((answer) => setOpenFailed(answer?.ok !== true))
                .catch(() => setOpenFailed(true));
            }}
          >
            {t('update.viewRelease')}
          </button>
        </div>
        {openFailed && <p className="hint">{t('update.openFailed')}</p>}
      </section>
    );
  }

  if (!result.available) {
    // `latest: null` is what an unreachable or rate-limited lookup looks like.
    // "You are on the latest version" would be a claim we cannot support, so
    // an unknown answer gets the unknown wording.
    if (result.latest === null) {
      return (
        <section className="status update">
          <h2>{t('update.title')}</h2>
          <p className="hint">{t('update.checkFailed')}</p>
        </section>
      );
    }
    return (
      <section className="status update">
        <h2>{t('update.title')}</h2>
        <p>{t('update.upToDate', { version: result.latest })}</p>
      </section>
    );
  }

  return (
    <section className="status update">
      <h2>{t('update.title')}</h2>
      <p>{t('update.available', { version: result.latest ?? '' })}</p>
      {result.assetName !== null && (
        <p className="hint">
          {t('update.assetSize', {
            name: result.assetName,
            mb: result.sizeBytes === null ? '?' : Math.round(result.sizeBytes / 1_048_576),
          })}
        </p>
      )}
      {/* Why a link rather than an install: the macOS build is unsigned by
          owner decision, and an unsigned bundle cannot replace itself. */}
      <p className="hint">{t('update.unsignedNote')}</p>
      <div className="update-actions">
        <button
          type="button"
          onClick={() => {
            setOpenFailed(false);
            window.s3Bypass
              ?.openUpdate?.()
              .then((answer) => setOpenFailed(answer?.ok !== true))
              .catch(() => setOpenFailed(true));
          }}
        >
          {t('update.download')}
        </button>
      </div>
      {openFailed && <p className="hint">{t('update.openFailed')}</p>}
    </section>
  );
}
