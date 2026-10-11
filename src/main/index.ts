import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  type OpenDialogReturnValue,
  session,
  shell,
  Tray,
} from 'electron';

import { APP_NAME, DEFAULT_SOCKS_PORT, IPC_PING } from '../shared/constants';
import {
  DIALOG_FAILED,
  E_STOR_005 as PROFILE_SAVE_FAILED,
  FILE_READ_FAILED,
} from '../shared/error-triples';
import type {
  IpcPushChannel,
  LogLine,
  LogsView,
  OperationResult,
  PingResult,
  ProfileImportResult,
  ProfileRemovalResult,
  ProfileSummary,
  ProfileView,
  ProxyState,
  StatusSnapshot,
} from '../shared/ipc';
import { type AppError, type CoreState } from '../shared/status-machine';
import { resolveCoreBinaryPath } from './core-binary-path';
import { createSupervisor } from './core-supervisor';
import { createCoreWiring } from './core-wiring';
import { assertTrustedSender } from './ipc-guard';
import { createLogCollector, redactionContextFromConfig } from './log-collector';
import { validateClientConfig } from './profile-validator';
import {
  deleteStoredProfile,
  loadProfile,
  saveProfile,
  storedProfileModifiedAt,
} from './secret-store';
import {
  type CommandResult,
  isSupportedPlatform,
  restoreSystemProxy,
  setSystemProxy,
  type SystemProxyContext,
  type SystemProxySnapshot,
} from './system-proxy';
import { buildTrayMenu, createWindowLifecycle, type TrayMenuAction } from './window-lifecycle';

/** `status:changed` push channel (§4.2, FR-63) — a contract literal, never a free string. */
const STATUS_CHANGED = 'status:changed' satisfies IpcPushChannel;

/** `log:line` push channel (§4.2, FR-63) — same rule: a contract literal, never a free string. */
const LOG_LINE = 'log:line' satisfies IpcPushChannel;

/**
 * FR-63 (data-flows §4.2): pushes a status snapshot main → renderer with
 * `webContents.send` — the renderer never polls for state that main owns.
 * Called once the page is ready and on every future transition: every push
 * comes from the M1-17 wiring's injected `broadcast`, so a transition is
 * fanned out exactly once (FR-26, no double-send). The send is best-effort
 * so a window closing mid-push cannot break the notification path (same
 * rule as the `log:line` push below); the tray mirror runs first so a
 * closed window still leaves the state visible (AC-05.4, FR-43).
 */
function broadcastStatus(snapshot: StatusSnapshot): void {
  syncTray(snapshot.state);
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(STATUS_CHANGED, snapshot);
    } catch {
      // The window is gone — the snapshot already reached the tray, and the
      // renderer re-fetches `status:get` on its next mount (data-flows §5).
    }
  }
}

/**
 * The bounded log buffer (FR-45/FR-46, M1-19): the single redaction entry
 * point (FR-47) every core/app line passes through — the renderer only ever
 * receives what this collector returns (data-flows (b) step 6).
 */
const logCollector = createLogCollector();

/**
 * Issue #24/DV-63: the §8.4 INTERNAL values of the STORED profile feed the
 * collector's redaction context — refreshed at startup and after every
 * (re-)import; fields MERGE, never clear (fail-closed: removing the profile
 * does not un-redact lines that already carried its values). An unreadable
 * store keeps the previous (possibly empty) context instead of failing.
 */
function refreshRedactionContext(): void {
  try {
    const raw = loadProfile();
    if (raw === null) return;
    const doc = parseStoredProfile(raw);
    if (doc === null) return;
    logCollector.setRedactionContext(redactionContextFromConfig(doc));
  } catch {
    // Degraded store (FR-59): the previous context stays, never a crash.
  }
}

// Startup wiring (issue #24): a profile already present at boot counts too.
refreshRedactionContext();

/**
 * S5-7 (issue #13): the `log:line` coalescing window — lines accumulate and
 * are flushed as ONE batched send at most this often (FR-46/FR-52: a 10k
 * core-log burst must not become 10k IPC round-trips + 10k renders; the
 * report's fix allows up to 250 ms per batch).
 */
const LOG_FLUSH_MS = 100;

/** Lines accumulated since the last flush — already redacted by the collector. */
const pendingLogLines: LogLine[] = [];

/** The scheduled flush, if any — one timer at a time, never one per line. */
let logFlushTimer: NodeJS.Timeout | null = null;

/** Sends the accumulated batch as ONE `log:line` payload (FR-63 per batch). */
function flushLogLines(): void {
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (pendingLogLines.length === 0) {
    return;
  }
  const batch = pendingLogLines.splice(0, pendingLogLines.length);
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(LOG_LINE, batch);
    } catch {
      // The window is gone — the lines stay in the buffer for the next one.
    }
  }
}

/**
 * FR-63 (data-flows (d) H4): stored (post-redaction) lines are pushed to
 * every window — COALESCED: the subscriber only accumulates and (re)arms the
 * flush timer above, so a synchronous flood collapses into a handful of sends
 * with every line delivered (FR-47 "replaced, never dropped", FR-63 payload
 * unchanged — the preload expands a batch into per-line listener calls).
 * Mirrors `broadcastStatus`; each send is best-effort so a window closing
 * mid-push cannot break the collector's notification path.
 */
logCollector.subscribe((line) => {
  pendingLogLines.push(line);
  if (logFlushTimer === null) {
    logFlushTimer = setTimeout(flushLogLines, LOG_FLUSH_MS);
  }
});

// ————————————————————————————————————————————————————————————————
// Tray mirror (FR-24/FR-41, AC-05.4 — M1-17 wiring half): the state reaches
// the tray as TEXT (menu model + tooltip), never color-only (NFR-5/FR-41).
// Tray/window actions are main-internal, never IPC (data-flows §4.2 "Not
// IPC"); the close-to-tray / quit-teardown wiring is attached in the M1-23
// lifecycle section below.
// ————————————————————————————————————————————————————————————————

/**
 * 16×16 PNG icon embedded as a data URL — no icon asset ships with the repo
 * yet (packaging supplies the real icon later); an embedded image keeps the
 * tray working on macOS and Linux alike with no filesystem dependency.
 */
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVR42mNgoDbQMnX8jw8TpTl69n+sGK8h+DRiM4gkmwm6hBTNWF0xagCVDKAoGilOSFRJylTJTOQAAExzvBA3oawXAAAAAElFTkSuQmCC';

/** The tray instance, created once the app is ready (`app.whenReady`). */
let tray: Tray | null = null;

/**
 * FR-24/FR-41 + AC-05.4: rebuild the tray from the state alone — the menu
 * template comes from the pinned `buildTrayMenu(state)` model (all four
 * items always listed, `enabled` following the data-flows §2.3 guards) and
 * the tooltip carries the model's `statusText`, so the state is readable as
 * TEXT in both places (never icon/color only, NFR-5).
 *
 * @param state current core lifecycle state (every `status:changed` push
 *   fans out here before it reaches the windows)
 */
function syncTray(state: CoreState): void {
  const current = tray;
  if (current === null) {
    return;
  }
  const model = buildTrayMenu(state);
  current.setToolTip(model.statusText);
  current.setContextMenu(
    Menu.buildFromTemplate(
      model.items.map((item) => ({
        label: item.label,
        enabled: item.enabled,
        click: (): void => {
          void dispatchTrayAction(item.id);
        },
      })),
    ),
  );
}

/**
 * Tray "Show window" (FR-40 / AC-05.3): un-minimize + show + focus the main
 * window — one implementation shared by the tray menu dispatch and the
 * lifecycle's `showWindow` dep (data-flows §4.2 "Not IPC": no window handle
 * inside the pure policy).
 */
function showMainWindow(): void {
  const [win] = BrowserWindow.getAllWindows();
  if (win !== undefined) {
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  }
}

/**
 * Tray menu dispatch (data-flows §4.2 "Not IPC"): `start`/`stop` reuse the
 * very same wiring the `core:*` handlers delegate to, `open` shows the main
 * window (FR-40), and `quit` runs the ONE shared data-flows §5 teardown —
 * stop the core, then revert the system proxy, then request the exit (M1-23b,
 * FR-19/FR-35/FR-42: no shortcut route beside `before-quit`).
 */
async function dispatchTrayAction(action: TrayMenuAction): Promise<void> {
  switch (action) {
    case 'open':
      showMainWindow();
      return;
    case 'start':
      // M1-27b (amended AC-04.1, owner Q1): the tray route runs the ONE
      // start sequence — auto-on-start cannot be skipped by changing entry point.
      await runStartRoute(() => coreWiring.handleStart());
      return;
    case 'stop':
      // M1-27b (AC-04.7): the ONE stop sequence — revert runs here too.
      await runStopRoute(() => coreWiring.handleStop());
      return;
    case 'quit':
      // Same teardown as `before-quit` (AC-05.5 single shared teardown) —
      // the policy stops the core, restores the proxy and requests the exit.
      beginQuit();
      return;
  }
}

/**
 * Creates the tray icon once the app is ready; `syncTray` fills menu + tooltip.
 * The tray is a best-effort affordance: a headless session may expose no
 * system tray at all, and a missing one must never break startup — with
 * `tray === null` the mirror simply stays off and the renderer status view
 * remains the source of truth.
 */
function createTray(): void {
  try {
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  } catch {
    tray = null;
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    title: APP_NAME,
    // M1-27b (D-02, blocker B-02, issue #15): the window is CREATED hidden —
    // BRIEF §2.5 "app starts hidden to tray", FR-38, US-05 AC-05.1. Whether
    // anything shows right away is the lifecycle policy's call (consulted on
    // the launch path below), never the constructor's show-default: the old
    // missing `show` key made Electron display the window on EVERY launch
    // (DV-27(3)).
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Navigation guard (M0-19 / S3-1 / S5-4 / issue #3): the window may only
  // stay on the local renderer — the EXACT app document when packaged, the
  // dev server URL in a NON-packaged run only (an inherited env var may
  // never widen a packaged window's allowlist, issue #10). Any other URL is
  // denied: the former blanket `url.startsWith('file://')` let an
  // attacker-controlled local HTML file navigate the window with the
  // preload still attached (M1-10 S3-3, security-m1-26b.md §1), so the
  // file:// arm is now pinned to the same document `loadFile` serves below.
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const appDocumentUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString();
  const isAllowedNavigation = (url: string): boolean =>
    url === appDocumentUrl || (!app.isPackaged && devUrl !== undefined && url === devUrl);
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });

  // M1-23b (FR-39 / US-05 AC-05.2, PR-03 close-to-tray): every close request
  // routes through the lifecycle policy — verdict 'hide' (not quitting)
  // prevents the close and HIDES the window to tray (the process and a
  // running core stay alive); verdict 'close' (quitting) lets the window
  // really close so the exit can complete (AC-05.5). Registration is
  // best-effort like `createTray`: a window surface without native close
  // events must never break startup.
  try {
    win.on('close', (event) => {
      if (windowLifecycle.handleCloseRequest() === 'hide') {
        event.preventDefault();
        win.hide();
      }
    });
  } catch {
    // No native close events on this surface — there is nothing to gate.
  }

  // FR-63: hand the renderer main's current status by push as soon as the
  // page is ready (the renderer additionally calls `status:get` once at
  // startup per data-flows §5).
  win.webContents.on('did-finish-load', () => {
    broadcastStatus(coreWiring.getStatus());
  });

  // M0-19 / S4-3: never load a dev URL in a packaged app even if the env
  // var was inherited from the environment.
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

// ————————————————————————————————————————————————————————————————
// Import-pipeline helpers (M1-12, data-flows (a)) — main-internal, never
// bridged to the renderer (FR-55).
// ————————————————————————————————————————————————————————————————

/** `errors.md` §2: the picked file vanished between dialog and read (FR-06).
 *  M3-A: the triple itself lives in `src/shared/error-triples.ts` (imported
 *  above) — single source, pinned by the TC-POL-01 wording rows. */

/** BR-V-02 ceiling in bytes (same value the validator's in-memory gate uses, DV-09). */
const MAX_PROFILE_BYTES = 1_048_576;

/**
 * `errors.md` §1 E-VAL-002 (S5-5, issue #11): the documented size refusal,
 * answered from `statSync` METADATA before any read — the in-memory gate of
 * `validateClientConfig` stays as defense in depth, never as the first gate
 * (FR-02 / data-flows (a) step 1: a huge file must be rejected, not read).
 */
function profileTooLargeError(size: number): AppError {
  const mib = (size / MAX_PROFILE_BYTES).toFixed(2);
  return {
    code: 'E-VAL-002',
    title: 'Profile file too large',
    cause: `The selected file is ${mib} MiB; profiles must be under 1 MiB.`,
    nextStep: 'Pick the actual profile JSON — this file is probably something else.',
  };
}

/** Structural NFR-5 shape — the store throws `SecretStoreError implements AppError`. */
function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<AppError>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.cause === 'string' &&
    typeof candidate.nextStep === 'string'
  );
}

/**
 * FR-48 / NFR-5: only a documented triple may cross the bridge — a thrown
 * value that is not already an `AppError` degrades to `fallback` instead of
 * leaking its message or stack into the renderer.
 */
function asAppError(value: unknown, fallback: AppError): AppError {
  if (isAppError(value)) {
    return {
      code: value.code,
      title: value.title,
      cause: value.cause,
      nextStep: value.nextStep,
    };
  }
  return fallback;
}

/** Plain JSON object guard — arrays and null are never config documents. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fedarisha outbound's `settings.storage`, or null when absent. */
function storageOf(doc: Record<string, unknown>): Record<string, unknown> | null {
  const outbounds = doc['outbounds'];
  if (!Array.isArray(outbounds)) {
    return null;
  }
  for (const entry of outbounds) {
    if (!isRecord(entry) || entry['protocol'] !== 'fedarisha') {
      continue;
    }
    const settings = entry['settings'];
    if (!isRecord(settings)) {
      return null;
    }
    const storage = settings['storage'];
    return isRecord(storage) ? storage : null;
  }
  return null;
}

/** A non-empty string field of the storage block — '' when absent. */
function stringField(storage: Record<string, unknown> | null, key: string): string {
  const value = storage === null ? undefined : storage[key];
  return typeof value === 'string' ? value : '';
}

/** Hostname only (§8.3) — never scheme, path or userinfo. */
function hostOf(endpoint: string): string {
  if (endpoint === '') {
    return '';
  }
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '';
  }
}

/** Last path segment of `prefix` (fallback: bucket) — the profile's label (§8.3). */
function labelOf(prefix: string, bucket: string): string {
  const segments = prefix.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  if (last !== undefined && last !== '.' && last !== '..') {
    return last;
  }
  return bucket === '' ? 'profile' : bucket;
}

/**
 * §8.3 `ProfileSummary` — the only config shape the renderer may receive
 * (FR-05/FR-55): internal display fields only — never accessKey, secretKey,
 * any `*token*` field and never the document itself (§8.4, §4.3 denylist).
 */
function buildProfileSummary(doc: Record<string, unknown>, importedAt: string): ProfileSummary {
  const storage = storageOf(doc);
  const bucket = stringField(storage, 'bucket');
  const prefix = stringField(storage, 'prefix');
  const endpointHost = hostOf(stringField(storage, 'endpoint'));
  const label = labelOf(prefix, bucket);
  return {
    displayName: endpointHost === '' ? label : `${label} @ ${endpointHost}`,
    endpointHost,
    bucket,
    prefix,
    region: stringField(storage, 'region'),
    importedAt,
    socksPort: DEFAULT_SOCKS_PORT,
  };
}

/** Parses a stored profile document; a damaged one means "no profile" (§5). */
function parseStoredProfile(raw: string): Record<string, unknown> | null {
  try {
    const doc: unknown = JSON.parse(raw);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

// ————————————————————————————————————————————————————————————————
// M1-17 (data-flows (b)): supervisor → IPC status wiring — the HOST resolves
// every collaborator here, the glue itself stays pure node (DV-28).
// ————————————————————————————————————————————————————————————————

/**
 * M2-04 (TC-02-16/17/18, DV-40): the resolution rules live in the pure
 * `core-binary-path` module (S4-5 comment there) — the host only injects
 * its environment at the wiring site below.
 */

/**
 * The M1-17 status wiring (FR-13/FR-25/FR-26/FR-63): `core:start`,
 * `core:stop` and `status:get` delegate to it, and every supervisor
 * transition reaches `broadcastStatus` (→ tray text mirror + the single
 * `status:changed` push) through the injected `broadcast` — exactly one
 * fan-out per transition, never a second `getStatus()` poll.
 */
const coreWiring = createCoreWiring({
  createSupervisor,
  isPackaged: app.isPackaged,
  binaryPath: resolveCoreBinaryPath({
    isPackaged: app.isPackaged,
    override: process.env.CORE_BINARY_PATH,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
  }),
  loadConfig: (): string | null => {
    // Same degradation rule `profile:get` applies: an unreadable store
    // answers "no profile" (data-flows §5) — the step-0 guard refuses Start.
    try {
      return loadProfile();
    } catch {
      return null;
    }
  },
  logSink: (line): void => {
    // M1-19 (FR-47): the collector is main's single redaction entry point —
    // raw child lines reach it here, never a window (data-flows (b) step 6).
    logCollector.push(line);
  },
  broadcast: (snapshot): void => {
    broadcastStatus(snapshot);
    // M2-11 / issue #19 (FR-35 crash arm, errors.md §6 E-CORE-* row): a crash
    // while the toggle is ON reverts the system proxy; a FAILED revert raises
    // the persistent E-PLAT-003 warning — `restoreAppliedProxy` owns both the
    // snapshot replay and the surfacing. `!quitting` keeps the exit path
    // single-shot (the teardown's own restore arm owns the quit — one
    // replay, one warning); `proxySnapshot !== null` is the module's own
    // idempotency: nothing applied → no-op, and a second push after a
    // successful revert sees `null`.
    if (snapshot.state === 'crashed' && !quitting && proxySnapshot !== null) {
      void restoreAppliedProxy();
    }
  },
});

// ————————————————————————————————————————————————————————————————
// M1-23b (data-flows §5; FR-19/FR-35/FR-39/FR-42; US-05 AC-05.2/AC-05.5,
// US-04 AC-04.7; PR-03/PR-08): native window-lifecycle wiring — the M1-22
// policy (window-lifecycle.ts) attached to the real Electron close/quit
// events, with the system-proxy restore hook and the execFile executor seam.
// ————————————————————————————————————————————————————————————————

/**
 * S5-15 kill budget (issue #22): a hung platform command (networksetup /
 * gsettings) must not strand restore/quit — execFile gets an explicit
 * 10 s timeout; the killed error lands on the fail-closed `-1` convention
 * below (its `error.code` is not a number), and the quit-teardown's
 * per-step bound (window-lifecycle, 12 s) outlives this one.
 */
const EXEC_TIMEOUT_MS = 10_000;

/**
 * PR-08 executor seam for `SystemProxyContext.run`: executes ONE argv array
 * through `execFile` (never a shell string — no `exec`/`execSync`/`shell:true`
 * anywhere in this file), resolving the `{code, stdout, stderr}` shape the
 * system-proxy module consumes. A non-zero exit maps to its numeric code; a
 * spawn failure (missing binary) or a kill-timeout kill degrades to `-1`,
 * exactly the fail-closed convention the module applies to a throwing
 * executor (FR-35, S5-15).
 *
 * @param args argv array — `[binary, ...args]`, no shell metacharacters
 */
function runExecFile(args: string[]): Promise<CommandResult> {
  const [command, ...argv] = args;
  if (command === undefined) {
    return Promise.resolve({ code: -1, stdout: '', stderr: 'execFile: empty argv' });
  }
  return new Promise((resolve) => {
    execFile(
      command,
      argv,
      { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/**
 * Host context handed to `restoreSystemProxy` (data-flows §3): `platform` is
 * PASSED IN as `process.platform` (never read by the pure module, PR-01) and
 * `run` is the injected `execFile` executor above (PR-08).
 */
const systemProxyContext: SystemProxyContext = {
  platform: process.platform,
  // M1-27b D-03 / S5-10 (issue #16): the desktop environment rides into
  // every call — without it `isSupportedPlatform('linux', undefined)` can
  // never answer supported, so AC-04.2 would fail on GNOME (data-flows §3
  // SUPPORT DETECT; the value is PASSED IN, the pure module never reads env).
  desktopEnv: process.env.XDG_CURRENT_DESKTOP,
  run: runExecFile,
};

/**
 * The snapshot `setSystemProxy` captured for the CURRENT apply — replayed
 * byte-for-byte on restore (FR-31/AC-04.3). LIVE since M1-27b: the
 * auto-on-start wrapper (owner decision Q1, acceptance-m1-27.md §8) stores it
 * on a successful apply and clears it only on a successful restore; `null`
 * means nothing is applied and `restoreSystemProxy(ctx, null)` stays the
 * module's documented idempotent no-op (FR-35 — the quit teardown below
 * reads this very variable).
 */
let proxySnapshot: SystemProxySnapshot | null = null;

/**
 * M1-27b (amended AC-04.1 — owner Q1 AUTO-ON-START): apply the system proxy
 * once the tunnel reached `running`. The pure platform rule is consulted
 * FIRST: an unsupported desktop gets NO module call and NO error dialog
 * (AC-04.5's manual hint stays the answer — no per-start spam). A failed
 * apply leaves `proxySnapshot` null (nothing partial reported as applied),
 * does not touch the start result (AC-04.6 — the core keeps running) and
 * surfaces the module's triple through the import-confirm dialog precedent
 * (a plain-language surface; A-14: the exact wording is errors.md's own).
 *
 * Test-hygiene seam (S4-5 `CORE_BINARY_PATH` pattern): an automated run
 * (`npm run test:e2e`) sets `DISABLE_AUTO_PROXY=1` so clicking Start in a
 * fixture never rewrites the HOST proxy — honored ONLY while
 * `!app.isPackaged`, never inside a package.
 */
async function autoApplySystemProxy(): Promise<void> {
  if (!app.isPackaged && process.env.DISABLE_AUTO_PROXY === '1') {
    return;
  }
  const support = isSupportedPlatform(process.platform, process.env.XDG_CURRENT_DESKTOP);
  if (!support.supported) {
    return;
  }
  const applied = await setSystemProxy(systemProxyContext);
  if (applied.ok) {
    proxySnapshot = applied.snapshot;
    return;
  }
  await dialog.showMessageBox({
    title: applied.error.title,
    message: applied.error.cause,
    detail: applied.error.nextStep,
  });
}

/**
 * M2-11 / issue #19 (FR-35 fail-closed): surface a FAILED system-proxy
 * revert as the persistent E-PLAT-003 warning — the same plain-language
 * dialog precedent `autoApplySystemProxy` applies to a failed apply (A-14:
 * the wording is errors.md's own; the triple travels title/message/detail).
 * EVERY restore arm routes through this — graceful stop, quit teardown and
 * the crash hook — never a silent leftover.
 *
 * @param error the module's plain-language triple (E-PLAT-003)
 */
async function surfaceRestoreFailure(error: AppError): Promise<void> {
  await dialog.showMessageBox({
    title: error.title,
    message: error.cause,
    detail: error.nextStep,
  });
}

/**
 * M1-27b (AC-04.7) + M2-11 (FR-35 on ALL arms): revert the applied system
 * proxy — UNCONDITIONAL delegation (the module owns the `snapshot === null`
 * no-op, the same rule as the quit teardown below) and the stored snapshot
 * is cleared only on success: an E-PLAT-003 refusal keeps `proxy:get`
 * reporting the TRUTH (`active:true` — still applied) AND raises the
 * persistent warning (issue #19: the stop, quit and crash arms must never
 * swallow it). The renderer's `proxy:set` path stays separate — it surfaces
 * the triple inline on its own result, no dialog.
 */
async function restoreAppliedProxy(): Promise<void> {
  const restored = await restoreSystemProxy(systemProxyContext, proxySnapshot);
  if (restored.ok) {
    proxySnapshot = null;
    return;
  }
  await surfaceRestoreFailure(restored.error);
}

/**
 * The ONE start sequence (amended AC-04.1 — owner Q1 AUTO-ON-START): run the
 * given start route, then auto-apply the system proxy on success, and return
 * the START result verbatim (AC-04.6 — a failed apply never fakes a start
 * failure). Every start entry point — the ipc `core:start` handler, the tray
 * `Start tunnel` action and the lifecycle `startTunnel` dep — passes
 * `coreWiring.handleStart` through here, so no route can skip the apply
 * (TC-04-17 pins the ipc + tray routes behaviourally).
 */
async function runStartRoute(start: () => Promise<OperationResult>): Promise<OperationResult> {
  const result = await start();
  if (result.ok) {
    await autoApplySystemProxy();
  }
  return result;
}

/**
 * The ONE stop sequence (AC-04.7): run the given graceful stop route, then
 * revert the applied proxy on success — same composition as the start side,
 * so the ipc `core:stop` handler, the tray `Stop tunnel` action and the
 * lifecycle `stopTunnel` dep all revert on every graceful stop.
 */
async function runStopRoute(stop: () => Promise<OperationResult>): Promise<OperationResult> {
  const result = await stop();
  if (result.ok) {
    await restoreAppliedProxy();
  }
  return result;
}

/** Main's quit marker (FR-42): true once the app is on its way out. */
let quitting = false;

/**
 * True once the quit teardown reached `requestQuit` (the policy's LAST step).
 * Checked BEFORE `preventDefault` so Electron's re-fired `before-quit` — from
 * `requestQuit`'s own `app.quit()` — passes through instead of being gated
 * into a stranded exit (FR-42 "full app exit", AC-05.5).
 */
let teardownSettled = false;

/**
 * The M1-23 lifecycle policy over its Electron/host collaborators (plan
 * M1-23a deps contract, FR-19/FR-35): `stopCore` takes the S5-3 force route
 * (`handleStopForce` — kill from any state, issue #9) while the tray Stop
 * action keeps the graceful `handleStop()`; `restoreProxy` delegates to
 * the system-proxy restore hook UNCONDITIONALLY (no caller-side guard — the
 * module owns the `snapshot === null` no-op), and `requestQuit` opens the
 * before-quit gate before asking the host to exit.
 */
const windowLifecycle = createWindowLifecycle({
  isQuitting: () => quitting,
  stopCore: async (): Promise<void> => {
    // FR-19 / S5-3 (issue #9): the quit teardown takes the FORCE route —
    // it awaits any in-flight graceful stop, then kills from any state
    // (`starting`/`stopping` would orphan the child otherwise), so no
    // leftover child and no leftover T (data-flows §2.1 step 9). The tray
    // Stop action below keeps the graceful `handleStop()`.
    // M3-05 / audit B-13: the OperationResult is BIND-checked — a failed
    // force-stop throws its documented triple so the policy records it as
    // the first failure (it rethrows after `requestQuit` → surfaced below;
    // awaited-and-dropped was the swallow the audit found).
    const result = await coreWiring.handleStopForce();
    if (!result.ok) {
      throw result.error;
    }
  },
  restoreProxy: async (): Promise<void> => {
    // FR-35 / AC-04.7: UNCONDITIONAL delegation — the module itself owns the
    // `snapshot === null` idempotent no-op, never a caller-side guard.
    // M2-11 / issue #19 item 1: a FAILED revert raises the persistent
    // E-PLAT-003 warning BEFORE `requestQuit` (the pre-exit dialog) —
    // beginQuit must not swallow it silently. The straight-to-hook shape is
    // intentional: the structural pin TC-04-15 keeps THIS dep delegating to
    // the system-proxy restore hook itself (the stop route owns
    // `restoreAppliedProxy`, the quit route owns the pre-exit surfacing).
    const restored = await restoreSystemProxy(systemProxyContext, proxySnapshot);
    if (!restored.ok) {
      await surfaceRestoreFailure(restored.error);
    }
  },
  showWindow: showMainWindow,
  startTunnel: async (): Promise<void> => {
    // M1-27b: the ONE start sequence — auto-on-start applies on this route too.
    await runStartRoute(() => coreWiring.handleStart());
  },
  stopTunnel: async (): Promise<void> => {
    // M1-27b: the ONE stop sequence — graceful `handleStop()` kept (S5-3
    // contract), now with the AC-04.7 revert on this route too.
    await runStopRoute(() => coreWiring.handleStop());
  },
  // M2-11 / issue #19 (tray freshness advisory): the LIVE state the dispatcher
  // re-validates `start`/`stop` against before forwarding. Provided here;
  // the re-check itself lands in handleMenuAction with GREEN (own commit).
  getLiveState: () => coreWiring.getStatus().state,
  requestQuit: (): void => {
    // Gate open BEFORE the quit request (see `teardownSettled` above).
    teardownSettled = true;
    app.quit();
  },
});

/**
 * M3-05 / audit B-13 (AC-05.5 fail closed): the quit teardown's FIRST
 * failure — the policy rethrows it AFTER `requestQuit`, and this dialog path
 * is its surface (the sibling of `surfaceRestoreFailure`, same precedent).
 * Only documented triples reach the user (`isAppError`): non-triple
 * infrastructure failures (hung-step budget timeouts, S5-15) stay
 * non-visual — errors.md §0 forbids invented wording (FR-48: nothing raw).
 */
async function surfaceQuitFailure(failure: unknown): Promise<void> {
  if (!isAppError(failure)) return;
  await dialog.showMessageBox({
    type: 'warning',
    title: APP_NAME,
    message: failure.title,
    detail: `${failure.cause}\n\n${failure.nextStep}`,
    buttons: ['OK'],
  });
}

/**
 * The single quit entry (FR-42 / AC-05.5): flips the quit marker — close
 * verdicts become 'close' from here on — and runs the ONE shared lifecycle
 * teardown (stop core → restore proxy → requestQuit), shared between the
 * tray Quit item and `before-quit`. Safe to call repeatedly (the policy is
 * idempotent: repeated calls await the SAME teardown, M1-22/AC-05.5).
 */
function beginQuit(): void {
  quitting = true;
  void windowLifecycle.handleBeforeQuit().catch((failure: unknown) => {
    // Fail closed (AC-05.5) + M3-05 audit B-13: every step was attempted
    // and `requestQuit` ran LAST inside the policy — the rethrown first
    // failure is shown here through the dialog path instead of swallowed.
    void surfaceQuitFailure(failure);
  });
}

// FR-19 / FR-42 (US-05 AC-05.5, data-flows §5): gate the exit — the FIRST
// before-quit is cancelled SYNCHRONOUSLY (before any await) so the async
// teardown can settle first; a before-quit arriving AFTER the teardown
// reached `requestQuit` is NOT gated again, or Electron would cancel its own
// re-fired event forever and FR-42's full app exit would never happen.
app.on('before-quit', (event) => {
  if (teardownSettled) {
    return;
  }
  event.preventDefault();
  beginQuit();
});

// ————————————————————————————————————————————————————————————————
// §4.2 invoke handlers: one `ipcMain.handle` per R→M channel (FR-61/FR-62).
// Feature logic lands with later M1 tasks; until then each handler returns
// the documented §4.2 payload shape — placeholder results where the feature
// does not exist yet, otherwise an NFR-5 `AppError` triple taken verbatim
// from docs/analysis/errors.md (no stacks, no secrets — FR-48/NFR-2).
// Sender validation (issue #1 / M1-10 S3-1): every callback calls the shared
// `assertTrustedSender(event)` FIRST — before any logic, dialog, or store
// access (src/main/ipc-guard.ts).
// ————————————————————————————————————————————————————————————————

ipcMain.handle(IPC_PING, (event: IpcMainInvokeEvent): PingResult => {
  assertTrustedSender(event);
  return { ok: true, app: APP_NAME, socksPort: DEFAULT_SOCKS_PORT };
});

// M1-12 (data-flows (a)): the picker is owned by `main` — the renderer never
// reads files (FR-01). Picker cancel is not an error (FR-01); the size gate
// lives inside the validator, so the raw text is handed over untouched (no
// double gate). M1-13 (FR-08, data-flows (a) step 6): after validation and
// before any write, an already-stored profile is confirmed — decline is a
// NON-error outcome, never an NFR-5 failure (FR-01 cancelled precedent).
// S4-6 (issue #5 / M1-10, security-m1-26b.md §3): exactly one native import
// picker may be open at a time. A second renderer invoke while the first
// modal is up refuses with the NON-error `busy` arm (DV-34(4): M1-13
// `declined` precedent, DV-19 — no E-* code) instead of stacking a second
// native dialog; the flag clears in `finally`, so the next invoke re-arms.
let importDialogInFlight = false;

/** The picker → stat → read → validate → confirm → save journey (data-flows
 * (a)), behind the in-flight flag registered below (S4-6). */
async function importDialogFlow(): Promise<ProfileImportResult> {
  let picked: OpenDialogReturnValue;
  try {
    picked = await dialog.showOpenDialog({
      title: 'Import profile',
      properties: ['openFile'],
      filters: [{ name: 'JSON profile', extensions: ['json'] }],
    });
  } catch {
    // errors.md §2 defensive entry — the dialog failure never escapes raw (FR-48).
    return { ok: false, error: DIALOG_FAILED };
  }

  const path = picked.filePaths[0];
  if (picked.canceled || path === undefined) {
    return { ok: false, reason: 'cancelled' };
  }

  // S5-5 (issue #11) / FR-02 / BR-V-02 / data-flows (a) step 1: size from
  // METADATA first — a file over 1 MiB is refused WITHOUT ever being read
  // (a stat failure keeps FR-06's documented read refusal). The read below
  // therefore only ever runs for a plausibly small file; the validator's
  // in-memory gate stays as defense in depth.
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    // FR-06 / US-01 edge: vanished or unstat-able between picker and stat.
    return { ok: false, error: FILE_READ_FAILED };
  }
  if (size > MAX_PROFILE_BYTES) {
    return { ok: false, error: profileTooLargeError(size) };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // FR-06 / US-01 edge: deleted or unreadable between picker and read.
    return { ok: false, error: FILE_READ_FAILED };
  }

  // Steps 3-4: size/NUL/parse/schema gates answer here, each with exactly
  // one errors.md §1 triple (FR-11) — no raw parser text, no stack.
  const validation = validateClientConfig(raw);
  if (!validation.ok) {
    // Validation (data-flows (a) step 4) precedes the overwrite confirmation
    // (step 6): a known-invalid file never reaches the prompt.
    return { ok: false, error: validation.error };
  }

  // Step 6 (FR-08): the store is consulted BEFORE the write — `loadProfile()`
  // answers "is a profile already stored?" (an unreadable blob degrades to
  // "no profile", errors.md §6 recovery matrix, the rule profile:get applies).
  let stored: string | null;
  try {
    stored = loadProfile();
  } catch {
    stored = null;
  }

  if (stored !== null) {
    // An existing profile would be overwritten → explicit confirmation first
    // (FR-08 / AC-01.7), called with exactly the options object, no window.
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Overwrite stored profile',
      message: 'A profile is already stored on this computer.',
      detail:
        'Importing this file will overwrite the stored profile — the previous one will be replaced.',
      buttons: ['Overwrite', 'Cancel'],
      // Esc / window-close maps to Cancel (index 1): closing the dialog must
      // never overwrite a stored profile (FR-08 explicit confirmation).
      cancelId: 1,
    });
    if (confirmation.response !== 0) {
      // Response 1: refusal is a user CHOICE, not a failure (FR-01
      // cancelled precedent) — the non-error decline arm, no NFR-5 triple,
      // and the store is left untouched.
      return { ok: false, reason: 'declined' };
    }
  }

  // Steps 8-9: the whole document is encrypted at rest (§8.2, A-20);
  // a keychain or write failure surfaces as its documented E-STOR triple.
  try {
    saveProfile(raw);
  } catch (failure) {
    return { ok: false, error: asAppError(failure, PROFILE_SAVE_FAILED) };
  }

  // §8.3 / FR-05: the stored blob's mtime is the import (or re-import)
  // moment — the same signal profile:get reports. An absent stat falls back
  // to "now"; this runs only after a successful save and never raises
  // (FR-01: a completed import always resolves with its summary).
  let importedAt: string;
  try {
    importedAt = (storedProfileModifiedAt() ?? new Date()).toISOString();
  } catch {
    importedAt = new Date().toISOString();
  }

  return {
    ok: true,
    summary: buildProfileSummary(validation.config, importedAt),
  };
}

ipcMain.handle(
  'profile:import-dialog',
  async (event: IpcMainInvokeEvent): Promise<ProfileImportResult> => {
    assertTrustedSender(event);
    // S4-6 (issue #5): refuse a second invoke while a picker is open —
    // never a second native modal; `finally` re-arms the flag below.
    if (importDialogInFlight) {
      return { ok: false, reason: 'busy' };
    }
    importDialogInFlight = true;
    try {
      const result = await importDialogFlow();
      // Issue #24/DV-63: the freshly imported profile's §8.4 INTERNAL
      // values feed the redaction context immediately (fail-closed merge).
      if (result.ok) refreshRedactionContext();
      return result;
    } finally {
      importDialogInFlight = false;
    }
  },
);

// M1-12: main decrypts (FR-55) and returns only the §8.3 summary — never the
// config document. An unreadable store or a document that no longer parses
// degrades to "no profile" instead of crashing (data-flows §5, FR-59).
ipcMain.handle('profile:get', (event: IpcMainInvokeEvent): ProfileView => {
  assertTrustedSender(event);
  let raw: string | null;
  try {
    raw = loadProfile();
  } catch {
    return { summary: null };
  }
  if (raw === null) {
    return { summary: null };
  }
  const doc = parseStoredProfile(raw);
  if (doc === null) {
    return { summary: null };
  }
  // The blob's mtime is the import (or re-import) moment of §8.3.
  const modifiedAt = storedProfileModifiedAt() ?? new Date();
  return { summary: buildProfileSummary(doc, modifiedAt.toISOString()) };
});

// M1-12: removal deletes the stored blob itself, not a UI flag (FR-60,
// AC-07.7); a store failure answers its documented triple, never a raw one.
ipcMain.handle('profile:remove', (event: IpcMainInvokeEvent): ProfileRemovalResult => {
  assertTrustedSender(event);
  try {
    deleteStoredProfile();
    return { ok: true };
  } catch (failure) {
    return { ok: false, error: asAppError(failure, PROFILE_SAVE_FAILED) };
  }
});

// M1-17 (FR-13, data-flows (b) step 0): Start delegates to the status
// wiring — the no-profile guard refuses BEFORE any supervisor exists, and a
// start failure comes back verbatim from the M1-15 pre-checks (the M1-07
// inline E-IO-004 placeholder is gone).
// M1-17 (§4.2) + M1-27b: the shared start sequence — the no-profile guard
// still refuses BEFORE any supervisor exists, a start failure comes back
// verbatim, and a SUCCESSFUL start auto-applies the system proxy (amended
// AC-04.1, owner Q1 — acceptance §8; the failure surface there is the
// dialog, never a fake start failure, AC-04.6). The literal
// `coreWiring.handleStart` here is the FR-13 wiring pin (TC-03-15 sibling).
ipcMain.handle('core:start', (event: IpcMainInvokeEvent): Promise<OperationResult> => {
  assertTrustedSender(event);
  return runStartRoute(() => coreWiring.handleStart());
});

// M1-17 (§4.2) + M1-27b: without a constructed supervisor this stays the
// documented idempotent `{ok:true}` no-op (the restore inside is the module's
// own `snapshot === null` no-op); a real graceful stop reverts the applied
// proxy first-class (AC-04.7). The literal `coreWiring.handleStop` here is
// the wiring pin (TC-03-15 sibling).
ipcMain.handle('core:stop', (event: IpcMainInvokeEvent): Promise<OperationResult> => {
  assertTrustedSender(event);
  return runStopRoute(() => coreWiring.handleStop());
});

// M1-17 (FR-25): status:get answers the wiring's LIVE snapshot — the latest
// pushed transition, not a frozen placeholder (data-flows §4.2).
ipcMain.handle('status:get', (event: IpcMainInvokeEvent): StatusSnapshot => {
  assertTrustedSender(event);
  return coreWiring.getStatus();
});

// M1-19 (FR-45): `logs:get` answers with the collector's buffer — redacted
// lines, oldest-first, at most the FR-46 cap (§4.2) — never a literal.
ipcMain.handle('logs:get', (event: IpcMainInvokeEvent): LogsView => {
  assertTrustedSender(event);
  return logCollector.get();
});

// M1-19 (FR-46, AC-06.6 data half): clearing empties the collector buffer;
// the cap still applies to the lines pushed afterwards.
ipcMain.handle('logs:clear', (event: IpcMainInvokeEvent): { ok: true } => {
  assertTrustedSender(event);
  logCollector.clear();
  return { ok: true };
});

// "Copy logs" (AC-06.5) goes through main rather than the renderer's
// navigator.clipboard. In a renderer that call rejects with "Document is not
// focused" whenever the window is not frontmost, and the promise was being
// discarded with `void`, so the rejection vanished and the button looked
// dead. Main's clipboard has no such precondition, and the renderer learns
// whether the write happened instead of assuming it.
ipcMain.handle('logs:copy', (event: IpcMainInvokeEvent, text: string): { ok: boolean } => {
  assertTrustedSender(event);
  try {
    clipboard.writeText(typeof text === 'string' ? text : '');
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// M1-27b (D-01, issue #14): the REAL state report — `supported` answers the
// pure platform rule (PR-01: platform + $XDG_CURRENT_DESKTOP PASSED IN),
// `active` mirrors main's stored snapshot (never a renderer-side guess — the
// checkbox reads exactly this), and `hint` keeps the exact §4.2/AC-04.5
// loopback values for manual setup (errors.md §4).
ipcMain.handle('proxy:get', (event: IpcMainInvokeEvent): ProxyState => {
  assertTrustedSender(event);
  const support = isSupportedPlatform(process.platform, process.env.XDG_CURRENT_DESKTOP);
  return {
    supported: support.supported,
    active: proxySnapshot !== null,
    hint: { host: '127.0.0.1', port: DEFAULT_SOCKS_PORT },
  };
});

// M1-27b (D-01 + S4-4, issues #14/#5): the REAL toggle. The payload guard
// runs AFTER the sender guard and BEFORE any module call — TS types are
// erased, so `enabled` must be re-checked at runtime with zero side effects
// on a malformed payload. The throw follows the house guard precedent
// (`UntrustedSenderError` in ipc-guard.ts): Electron turns it into an invoke
// rejection the renderer catches without rendering anything raw (FR-48) —
// no new E-* code (DV-19). The module owns apply/restore: its `{ok}` answer
// passes through unchanged and the captured snapshot threads the
// byte-for-byte restore (FR-31/AC-04.3).
ipcMain.handle(
  'proxy:set',
  async (event: IpcMainInvokeEvent, request: unknown): Promise<OperationResult> => {
    assertTrustedSender(event);
    const enabled =
      typeof request === 'object' && request !== null
        ? (request as { readonly enabled?: unknown }).enabled
        : undefined;
    if (typeof enabled !== 'boolean') {
      const error = new Error('proxy:set expects { enabled: boolean } — S4-4 payload guard');
      error.name = 'InvalidPayloadError';
      throw error;
    }
    if (enabled) {
      const applied = await setSystemProxy(systemProxyContext);
      if (applied.ok) {
        proxySnapshot = applied.snapshot;
        return { ok: true };
      }
      return applied;
    }
    const restored = await restoreSystemProxy(systemProxyContext, proxySnapshot);
    if (restored.ok) {
      proxySnapshot = null;
    }
    return restored;
  },
);

app.whenReady().then(() => {
  // S3-2 (issue #1 second half): deny every renderer permission request by
  // default — Electron is allow-by-default for several permissions, and no
  // feature needs one yet. An allowlist arrives with the first feature that
  // does. Registered inside the whenReady path: Electron exposes `session`
  // only once the ready event has fired.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  // M1-17 (FR-24/FR-41, AC-05.4): the tray exists from launch and mirrors
  // the CURRENT state as text (menu model + tooltip) — every later
  // transition re-syncs it through broadcastStatus above.
  createTray();
  syncTray(coreWiring.getStatus().state);

  // M1-27b (D-02, blocker B-02, issue #15), AMENDED by owner decision
  // issue #25 (2026-10-08): launch consults the pinned lifecycle policy
  // instead of the constructor default — `shouldShowWindowOnLaunch()`
  // answers true for every launch (FR-38 amended: the window shows on
  // launch; GREEN TC-05-14), so the launch path performs the show right
  // here. The window itself was created hidden above; tray "Open"
  // (FR-40/AC-05.3) still re-shows/focuses on demand.
  const launchWindow = createWindow();
  if (windowLifecycle.shouldShowWindowOnLaunch()) {
    launchWindow.show();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // A dock re-open is an explicit user gesture, not a launch — the newly
      // created (hidden) window is shown right away (AC-05.3 semantics; the
      // launch policy governs LAUNCHES only).
      createWindow().show();
    }
  });
});

app.on('window-all-closed', () => {
  // M1-23b (PR-03 "Must be changed"; FR-39 / US-05 AC-05.2): while the tray
  // exists the process STAYS ALIVE — the scaffold's quit-on-last-window for
  // non-darwin is the documented conflict with close-to-tray. Fall back to
  // the platform default only when there is no tray to keep running for.
  if (tray !== null) {
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
