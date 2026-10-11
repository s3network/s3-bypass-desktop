// @vitest-environment jsdom
/**
 * M1-18 (RED, addendum batch) — renderer Logs view: "Copy logs" puts exactly
 * the visible (redacted) text on the clipboard (AC-06.5), rows render
 * oldest-first (AC-06.1 component half).
 *
 * Test plan IDs: TC-06-05 (`logs.copy.deliversVisibleRedactedTextOnly`) +
 * one sibling (order-render) — docs/qa/m1-test-plan.md §6 (the row's
 * `addendum (M1-18 batch; §10)` status) and the M1-18 row in §10;
 * allocations recorded in §14 (DV-25). The L3 twin of the same TC rides
 * M1-24 (same ID, never renumbered — strategy §4.3).
 *
 * Spec sources: docs/product/stories/US-06-logs.md AC-06.1 (oldest-first with
 * timestamps), AC-06.5 ("Copy logs" → clipboard receives the visible
 * redacted text and nothing else); docs/analysis/requirements.md FR-49;
 * docs/analysis/data-flows.md §4.2 (`logs:get`, `log:line` push); plan
 * M1-19 ("renderer logs view (scroll, clear, copy)"). Scrolling (AC-06.7 /
 * TC-06-07) and clear (AC-06.6 UI half) are NOT pinned here — TC-06-07 is
 * the M1-19-window addendum row; only the copy + order halves belong to the
 * M1-18 batch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT FOR M1-19's renderer half (declared here — header-contract style):
 *
 *  - `App` (src/renderer/src/App.tsx) renders a Logs section filled from
 *    `window.s3Bypass.getLogs()` on mount and kept current via
 *    `window.s3Bypass.onLogLine(...)` (AC-06.1/FR-45: the view shows the
 *    lines main pushed — the renderer never redacts, it only displays what
 *    `main` already redacted, FR-47).
 *  - Each log line is rendered in ONE element whose text content contains the
 *    line's `text` (the test discovers rows leaf-most, so nesting the
 *    timestamp/level around the text is fine; splitting a single line's text
 *    across elements is not).
 *  - A button named "Copy logs" (exact AC-06.5 wording) writes, in one
 *    `navigator.clipboard.writeText` call, exactly the visible rows'
 *    text — nothing more, nothing less (whitespace-insensitive).
 *
 * RED status: ABSENCE RED — App has no Logs section, no "Copy logs" button
 * (plan M1-19); both cases fail at their first query. Strategy §5.2:
 * legitimate first-test-of-a-subsystem failure; do not weaken, skip, or
 * delete. Synthetic data only: fixed ISO timestamps, `[REDACTED]`-form lines
 * exactly as `main` delivers them, one canary used only as a negative probe.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App from '../../src/renderer/src/App';
import type { LogLine } from '../../src/shared/ipc';

afterEach(cleanup);

/** Lines exactly as main's redaction entry point delivers them (FR-47). */
const VISIBLE_LINES: LogLine[] = [
  { ts: '2026-01-01T10:00:00.000Z', level: 'info', source: 'core', text: 'fake-core: READY' },
  {
    ts: '2026-01-01T10:00:01.000Z',
    level: 'warn',
    source: 'core',
    text: 'core: upsert to [REDACTED] completed',
  },
  {
    ts: '2026-01-01T10:00:02.000Z',
    level: 'info',
    source: 'app',
    text: 'app: profile import finished',
  },
];

const CANARY_PROBE = 'EXAMPLESECRETKEY0123456789'; // §9.3 — must never surface

const writeText = vi.fn().mockResolvedValue(undefined);

function installBridge(): void {
  window.s3Bypass = {
    ping: async () => ({ ok: true, app: 'S3 Bypass Desktop', socksPort: 10808 }),
    versions: { electron: '0', chrome: '0', node: '0' },
    getLogs: async () => ({ lines: VISIBLE_LINES }),
    onLogLine: () => () => undefined,
    clearLogs: async () => ({ ok: true }),
    copyLogs: async (text: string) => {
      writeText(text);
      return { ok: true };
    },
  };
}

/**
 * Leaf-most elements whose text content contains one of the line texts —
 * robust to nesting (timestamp/level decorations around the text), one row
 * per line, in DOM order.
 */
function visibleLogRows(): string[] {
  const texts = VISIBLE_LINES.map((line) => line.text);
  const containsLine = (el: Element): boolean =>
    texts.some((text) => (el.textContent ?? '').includes(text));
  const matches = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(containsLine);
  const rows = matches.filter(
    (el) => !Array.from(el.children).some((child) => containsLine(child)),
  );
  return rows.map((el) => el.textContent ?? '');
}

const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();

describe('Logs view — copy delivers the visible text (AC-06.5, FR-49)', () => {
  it('logs.copy.deliversVisibleRedactedTextOnly', async () => {
    installBridge();
    render(<App />);
    const button = await screen.findByRole('button', { name: /copy logs/i });
    fireEvent.click(button);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0] ?? '');

    const rows = visibleLogRows();
    expect(rows.length, 'one visible row per stored line (AC-06.1)').toBe(VISIBLE_LINES.length);
    expect(
      normalize(copied),
      'AC-06.5/FR-49: the clipboard receives exactly the visible text and nothing else',
    ).toBe(normalize(rows.join(' ')));
    for (const line of VISIBLE_LINES) {
      expect(copied, `the copied text includes the visible line "${line.text}"`).toContain(
        line.text,
      );
    }
    expect(copied, 'AC-06.3: the copied text is the redacted one').toContain('[REDACTED]');
    expect(copied, `NFR-2: no canary in the clipboard (${CANARY_PROBE})`).not.toContain(
      CANARY_PROBE,
    );
    expect(
      document.body.textContent ?? '',
      'NFR-2: no canary in the rendered DOM either',
    ).not.toContain(CANARY_PROBE);
  });

  it('logs.view.oldestFirstRowsRenderedForCopy', async () => {
    // Sibling of TC-06-05 (DV-03 convention): the component half of AC-06.1
    // — rows appear oldest-first, so "copy what is visible" copies a
    // meaningful chronology.
    installBridge();
    render(<App />);

    await waitFor(() => expect(visibleLogRows().length).toBe(VISIBLE_LINES.length));
    const rows = visibleLogRows();
    VISIBLE_LINES.forEach((line, index) => {
      expect(
        rows[index] ?? '',
        `AC-06.1: row ${index + 1} (oldest-first) contains "${line.text}"`,
      ).toContain(line.text);
    });
  });
});

/**
 * M3-05 (TC-POL-03, docs/qa/m3-test-plan.md §3): the empty-state copy ships
 * but was never pinned — a reword would pass every suite silently. Additive
 * only (strategy §5.2).
 */
describe('Logs view — empty state (M3-05, TC-POL-03)', () => {
  it('logs.view.emptyStateTextPinned', async () => {
    installBridge();
    if (window.s3Bypass !== undefined) {
      window.s3Bypass.getLogs = async () => ({ lines: [] });
    }
    render(<App />);

    expect(
      await screen.findByText('No log lines yet.'),
      'M3-05: the empty Logs view must keep its plain-language empty state (FR-45: ' +
        'an empty view explains itself instead of showing a blank box)',
    ).toBeTruthy();
  });
});
