import { useEffect, useRef, useState } from 'react';

import type { LogLine } from '../../../shared/ipc';
import { t } from '../../../shared/strings';

/** FR-46 cap mirrored into the renderer (S5-7: main's 2000-line bound, end-to-end). */
const MAX_RENDERED_LINES = 2000;

/**
 * The logs section (FR-45/FR-49, US-06): fills from `logs:get` on mount and
 * stays current through the `log:line` push (AC-06.1 — oldest-first, one row
 * per line). The renderer never redacts: it only displays what main's single
 * entry point already redacted (FR-47). The mirror is capped at
 * `MAX_RENDERED_LINES` with drop-oldest on append (S5-7, FR-46: memory must
 * not grow unbounded under a log flood — the bound holds end-to-end).
 *
 * "Copy logs" (AC-06.5/FR-49) writes exactly the visible rows' text — one
 * `navigator.clipboard.writeText` call, nothing more; Clear (AC-06.6 UI
 * half) empties the buffer through `logs:clear`. Each line's text lives in
 * its own leaf element, so the visible text is exactly `line.text`.
 */
export default function LogsView() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Subscribe BEFORE the snapshot (data-flows §4.2): main stores a line
    // before it notifies, so a push racing the `logs:get` round-trip is
    // either already in the snapshot or appended right after it. The cap
    // applies on append: keep the newest `MAX_RENDERED_LINES`, oldest out.
    const unsubscribe = window.s3Bypass?.onLogLine?.((line) => {
      if (!cancelled) {
        setLines((previous) => [...previous, line].slice(-MAX_RENDERED_LINES));
      }
    });
    window.s3Bypass
      ?.getLogs?.()
      .then((view) => {
        if (!cancelled) {
          setLines(view.lines);
        }
      })
      .catch(() => {
        // No bridge (plain-browser render) — the view simply stays empty.
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // AC-06.7: new lines scroll the list to the bottom.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [lines]);

  // AC-06.5: exactly the visible (already redacted) rows, one write.
  //
  // Routed through main, not navigator.clipboard: that call rejects with
  // "Document is not focused" whenever the window is not frontmost, and the
  // promise was discarded with `void`, so a failure looked exactly like a
  // button that does nothing. The result is now shown either way — a silent
  // copy is indistinguishable from a broken one, which is how this went
  // unnoticed.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyLogs = (): void => {
    const text = lines.map((line) => line.text).join('\n');
    window.s3Bypass
      ?.copyLogs?.(text)
      .then((result) => {
        setCopyState(result?.ok === true ? 'copied' : 'failed');
        window.setTimeout(() => setCopyState('idle'), 2000);
      })
      .catch(() => {
        setCopyState('failed');
        window.setTimeout(() => setCopyState('idle'), 2000);
      });
  };

  const clearLogs = (): void => {
    window.s3Bypass
      ?.clearLogs?.()
      .then(() => {
        setLines([]);
      })
      .catch(() => {
        // A bridge failure leaves the view untouched (FR-48: nothing raw to show).
      });
  };

  return (
    <section className="status logs">
      <h2>{t('logs.title')}</h2>
      <div className="log-actions">
        <button type="button" onClick={copyLogs}>
          {copyState === 'copied' ? t('logs.copied') : copyState === 'failed' ? t('logs.copyFailed') : t('logs.copy')}
        </button>
        <button type="button" onClick={clearLogs}>
          {t('logs.clear')}
        </button>
      </div>
      <ul className="log-list" ref={listRef}>
        {lines.map((line, index) => (
          <li className="log-row" key={`${line.ts}-${index}`}>
            <span className="log-ts">{line.ts}</span>
            <span className="log-level">{line.level}</span>
            <span className="log-text">{line.text}</span>
          </li>
        ))}
      </ul>
      {lines.length === 0 && <p className="log-empty">{t('logs.empty')}</p>}
    </section>
  );
}
