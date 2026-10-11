/**
 * M3-08 (board Phase D, batch D) — the single English strings module with a
 * `t(key)` seam. One map, one accessor, byte-identical output: every value
 * below is EXACTLY the string the existing exact-wording pins already
 * assert (m3-test-plan §5 TC-POL-05 — e2e `Import a profile first`,
 * TC-04-04, TC-05-04 `Show window`, TC-06-05 `No log lines yet.`, the
 * AC-04.5 manual-proxy sentence, the FR-41 status words). The seam may
 * re-export; it may never reword — rewording is an owner decision (batch A
 * / a wording pin), never a refactor.
 *
 * Keys: `status.* hint.* action.* tray.* logs.* app.*` (the namespace is
 * pinned in §5). OUT of scope by design (recorded in §5): identity strings
 * (`S3 Bypass Desktop` h1/footer — BRIEF §9 productName), the dev-only IPC
 * line, and error triples (their wording belongs to
 * `docs/analysis/errors.md`, batch A).
 *
 * BRIEF §3: English first, Russian → backlog — NO Cyrillic may enter this
 * map (the `strings.enMapCarriesNoRussianContent` pin scans every value).
 * A future locale adds a sibling map and `t` resolves per locale; the MVP
 * ships `EN` only.
 */

const EN = {
  // FR-41 / AC-03.1 visible-state words (also the tray's statusText).
  'status.stopped': 'Stopped',
  'status.starting': 'Starting...',
  'status.running': 'Running',
  'status.stopping': 'Stopping...',
  'status.crashed': 'Core crashed',
  // FR-12 / FR-30 exact hint wording (AC-02.3 / AC-04.4).
  'hint.noProfile': 'Import a profile first',
  'hint.proxyNotRunning': 'Start the tunnel first',
  // AC-04.5 (data-flows §3.3): parameterized manual-proxy sentence.
  'hint.unsupportedDesktop':
    'Not supported on this desktop — set it manually: SOCKS proxy {host}, port {port}.',
  // The Start/Stop accessible name (the availability contract seam).
  'action.start': 'Start',
  'action.stop': 'Stop',
  // FR-41 verbatim tray item labels (AC-05.4 "Start/Stop tunnel").
  'tray.showWindow': 'Show window',
  'tray.startTunnel': 'Start tunnel',
  'tray.stopTunnel': 'Stop tunnel',
  'tray.quit': 'Quit',
  // FR-45/AC-06.5/AC-06.6 logs surface copy.
  'logs.title': 'Logs',
  'logs.empty': 'No log lines yet.',
  'logs.copy': 'Copy logs',
  // The copy button reports its outcome. A silent copy is indistinguishable
  // from a broken one — which is exactly how a clipboard that rejects on an
  // unfocused window went unnoticed here.
  'logs.copied': 'Copied',
  'logs.copyFailed': 'Copy failed',
  'logs.clear': 'Clear',
  // The product tagline (renderer copy, unpinned by design).
  'app.tagline': 'Import a config — press Start — the internet works.',
} as const;

/** Every key of the EN map — the seam's public contract. */
export type StringKey = keyof typeof EN;

/**
 * The i18n seam: resolve `key` to its English string, substituting
 * `{name}` placeholders from `params` when given (values are never
 * re-cased or reworded — byte-identical out, per TC-POL-05).
 */
export function t(key: StringKey, params?: Readonly<Record<string, string | number>>): string {
  const value: string = EN[key];
  if (params === undefined) return value;
  return value.replace(/\{(\w+)\}/g, (whole: string, name: string): string => {
    const replacement = params[name];
    return replacement === undefined ? whole : String(replacement);
  });
}
