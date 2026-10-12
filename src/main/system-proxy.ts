/**
 * System-proxy control — M1-21 (GREEN half of the M1-20 RED contract
 * declared in tests/unit/system-proxy.test.ts and mirrored as
 * `SystemProxyApi` in tests/helpers/system-proxy-stub.ts).
 *
 * Spec: docs/analysis/data-flows.md flow (c) §3.1 (macOS `networksetup`),
 * §3.2 (Linux GNOME `gsettings`), §3.3 (unsupported-desktop hint);
 * docs/analysis/requirements.md F5 (FR-30..FR-37) + platform rules PR-01,
 * PR-02 and PR-08 (argv arrays, never a shell string);
 * docs/analysis/errors.md §4 (E-PLAT-001/002/003 triples).
 *
 * Pure node module: every OS call travels through the INJECTED executor
 * `context.run(args: string[]) => Promise<CommandResult>` (PR-08) — the
 * module never spawns a process itself, never imports Electron, and never
 * reads `process.env`: `platform`/`desktopEnv` are passed in, so platform
 * branching is a pure function of the call arguments (TC-04-05).
 *
 * ENABLE (both platforms): support check → detect/probe → snapshot → apply
 * → verify. Any non-zero exit after the snapshot was captured rolls back to
 * that snapshot and resolves `{ ok:false, E-PLAT-002 }` (FR-34: toggle
 * reported Off, no partial proxy change left unreported — errors.md §6).
 * DISABLE (`restoreSystemProxy`) replays the captured snapshot byte-for-byte;
 * `snapshot === null` is an idempotent no-op that runs no command, and a
 * failing replay resolves `{ ok:false, E-PLAT-003 }` — fail closed, never
 * throws (FR-35).
 *
 * Fixed M1 values (BRIEF §2.4): SOCKS on loopback `127.0.0.1:10808`.
 */
import { DEFAULT_SOCKS_PORT } from '../shared/constants';
import type { OperationResult } from '../shared/ipc';
import type { AppError } from '../shared/status-machine';

/** Result of one argv-array command (contract: PR-08, data-flows (c)). */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable executor — the ONLY way this module may reach the OS. */
export type RunCommand = (args: string[]) => Promise<CommandResult>;

/** Everything a `setSystemProxy`/`restoreSystemProxy` call needs. */
export interface SystemProxyContext {
  /** `process.platform` equivalent — PASSED IN, never read from the ambient environment. */
  readonly platform: string;
  /** `XDG_CURRENT_DESKTOP` value — PASSED IN (may be undefined). */
  readonly desktopEnv?: string | undefined;
  /** Injected command executor; the caller (main process) provides the real one. */
  readonly run: RunCommand;
}

/** One `-get*proxy` line group as parsed from `Enabled:`/`Server:`/`Port:` (DV-26(5)). */
export interface MacProxySetting {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
}

/** macOS snapshot captured before apply, replayed byte-for-byte on restore (FR-31/AC-04.3). */
export interface MacProxySnapshot {
  readonly service: string;
  readonly socks: MacProxySetting;
  readonly secureWeb: MacProxySetting;
}

/** GNOME snapshot: the documented `(mode, host, port)` triple (data-flows §3.2). */
export interface GnomeProxySnapshot {
  readonly mode: string;
  readonly socksHost: string;
  readonly socksPort: number;
}

/** Either platform's captured prior state. */
export type SystemProxySnapshot = MacProxySnapshot | GnomeProxySnapshot;

/** Platform-detection answer; `hint` is the exact data-flows §3.3 sentence when unsupported. */
export interface PlatformSupport {
  readonly supported: boolean;
  readonly hint?: string | undefined;
}

/** `setSystemProxy`: success carries the snapshot the caller must restore later. */
export type SetSystemProxyResult =
  | { readonly ok: true; readonly snapshot: SystemProxySnapshot }
  | { readonly ok: false; readonly error: AppError };

/** App-owned loopback values — BRIEF §2.4 / data-flows (c), fixed for M1. */
const LOOPBACK_HOST = '127.0.0.1';

/** data-flows §3.3 — the EXACT fallback sentence (FR-33, AC-04.5, E-PLAT-001 hint). */
const MANUAL_HINT = `Not supported on this desktop — set it manually: SOCKS proxy ${LOOPBACK_HOST}, port ${DEFAULT_SOCKS_PORT}.`;

/**
 * `errors.md` §4 E-PLAT-001 — unsupported desktop (FR-33) or missing GNOME
 * schema (FR-32): a hint, not a failure; returned with ZERO OS commands run.
 */
function manualProxyError(): AppError {
  return {
    code: 'E-PLAT-001',
    title: 'Manual proxy setup required',
    cause: 'Automatic system-proxy control is not supported on this desktop environment.',
    nextStep: `Set it manually: SOCKS proxy ${LOOPBACK_HOST}, port ${DEFAULT_SOCKS_PORT}.`,
  };
}

/**
 * `errors.md` §4 E-PLAT-002 — an operating-system command failed mid-apply
 * (FR-34). `binary` names the failed command family (`networksetup` /
 * `gsettings`); the raw OS stderr never reaches user-visible text (NFR-2).
 */
function commandFailedError(binary: string): AppError {
  return {
    code: 'E-PLAT-002',
    title: 'System proxy change failed',
    cause: `The operating system command (${binary}) failed.`,
    nextStep:
      // M3-A (errors.md §0/§4, DV-64): the values themselves, never a code citation.
      `The toggle was returned to Off; set the proxy manually (SOCKS host ${LOOPBACK_HOST}, port ${DEFAULT_SOCKS_PORT}), or retry.`,
  };
}

/** `errors.md` §4 E-PLAT-003 — restore refused; persistent warning, fail closed (FR-35). */
function restoreFailedError(): AppError {
  return {
    code: 'E-PLAT-003',
    title: 'System proxy could not be restored',
    cause: 'The app could not revert the system proxy to its previous settings.',
    nextStep: `Manual action required: restore your proxy settings to the previous values, or set SOCKS to ${LOOPBACK_HOST}:${DEFAULT_SOCKS_PORT} off.`,
  };
}

/** `{ ok:false }` shorthand for the E-PLAT-001 refusal (unsupported desktop / missing schema). */
function unsupportedDesktop(): SetSystemProxyResult {
  return { ok: false, error: manualProxyError() };
}

/** `{ ok:false }` shorthand for the E-PLAT-002 result of a failed operating-system command. */
function commandFailure(binary: string): SetSystemProxyResult {
  return { ok: false, error: commandFailedError(binary) };
}

// ─── Pure argv builders (PR-08: element arrays, never a shell string) ───────

/** data-flows §3.1 step 1 — active-service detection. */
export function buildMacDetectCommand(): string[] {
  return ['networksetup', '-listnetworkserviceorder'];
}

/** §3.1 step 2 — SNAPSHOT reads: prior SOCKS AND secure-web state (FR-31). */
export function buildMacSnapshotCommands(service: string): string[][] {
  return [
    macGetCommand('-getsocksfirewallproxy', service),
    macGetCommand('-getsecurewebproxy', service),
  ];
}

/** §3.1 step 3 — APPLY argv arrays (SOCKS only — FR-31, DV-26(4)). */
export function buildMacOnCommands(service: string, host: string, port: number): string[][] {
  return [
    ['networksetup', '-setsocksfirewallproxy', service, host, String(port)],
    ['networksetup', '-setsocksfirewallproxystate', service, 'on'],
  ];
}

/** DISABLE step 1 — inverse argv arrays replaying the captured snapshot (AC-04.3): socks, then secureWeb. */
export function buildMacRestoreCommands(snapshot: MacProxySnapshot): string[][] {
  return [
    ...macRestoreSettingCommands(
      '-setsocksfirewallproxy',
      '-setsocksfirewallproxystate',
      snapshot.service,
      snapshot.socks,
    ),
    ...macRestoreSettingCommands(
      '-setsecurewebproxy',
      '-setsecurewebproxystate',
      snapshot.service,
      snapshot.secureWeb,
    ),
  ];
}

/** §3.2 SNAPSHOT — `gsettings get` for mode / socks host / socks port (DV-26(2): the probe key is socks host). */
export function buildGnomeSnapshotCommands(): string[][] {
  return [gnomeGetModeCommand(), gnomeGetSocksHostCommand(), gnomeGetSocksPortCommand()];
}

/**
 * §3.2 APPLY — host, port, then mode `manual`, as RAW argv elements: the
 * quotes in data-flows are shell notation and must NOT travel as argv
 * content (DV-26(3), PR-08).
 */
export function buildGnomeOnCommands(host: string, port: number): string[][] {
  return [
    gnomeSetSocksHostCommand(host),
    gnomeSetSocksPortCommand(port),
    gnomeSetModeCommand('manual'),
  ];
}

/** §3.2 DISABLE step 1 — restore the `(mode, host, port)` triple, always all three (AC-04.3). */
export function buildGnomeRestoreCommands(snapshot: GnomeProxySnapshot): string[][] {
  return [
    gnomeSetSocksHostCommand(snapshot.socksHost),
    gnomeSetSocksPortCommand(snapshot.socksPort),
    gnomeSetModeCommand(snapshot.mode),
  ];
}

/** One `networksetup -get*` argv row. */
function macGetCommand(flag: string, service: string): string[] {
  return ['networksetup', flag, service];
}

/** One setting's byte-for-byte inverse pair: set host/port, then switch state. */
function macRestoreSettingCommands(
  setFlag: string,
  stateFlag: string,
  service: string,
  setting: MacProxySetting,
): string[][] {
  return [
    ['networksetup', setFlag, service, setting.host, String(setting.port)],
    ['networksetup', stateFlag, service, setting.enabled ? 'on' : 'off'],
  ];
}

function gnomeGetModeCommand(): string[] {
  return ['gsettings', 'get', 'org.gnome.system.proxy', 'mode'];
}

function gnomeGetSocksHostCommand(): string[] {
  return ['gsettings', 'get', 'org.gnome.system.proxy.socks', 'host'];
}

function gnomeGetSocksPortCommand(): string[] {
  return ['gsettings', 'get', 'org.gnome.system.proxy.socks', 'port'];
}

function gnomeSetSocksHostCommand(host: string): string[] {
  return ['gsettings', 'set', 'org.gnome.system.proxy.socks', 'host', host];
}

function gnomeSetSocksPortCommand(port: number): string[] {
  return ['gsettings', 'set', 'org.gnome.system.proxy.socks', 'port', String(port)];
}

function gnomeSetModeCommand(mode: string): string[] {
  return ['gsettings', 'set', 'org.gnome.system.proxy', 'mode', mode];
}

// ─── Platform rule (PR-01/PR-02) ────────────────────────────────────────────

/**
 * Pure platform rule: macOS is supported unconditionally (`networksetup`
 * assumed present, PR-02); Linux only when `XDG_CURRENT_DESKTOP` mentions
 * GNOME. The desktop value is the PASSED-IN parameter — this function never
 * reads `process.env` (TC-04-05). Unsupported answers carry the exact
 * data-flows §3.3 hint sentence.
 */
export function isSupportedPlatform(
  platform: string,
  desktopEnv?: string | undefined,
): PlatformSupport {
  const supported =
    platform === 'darwin' || (platform === 'linux' && /gnome/i.test(desktopEnv ?? ''));
  if (!supported) {
    return { supported: false, hint: MANUAL_HINT };
  }
  return { supported: true };
}

// ─── Executed flows (through the injected executor only) ────────────────────

/**
 * Runs ONE argv array through the injected executor. An executor that throws
 * (spawn error, missing binary) counts as a failed command — every flow below
 * treats it exactly like a non-zero exit (FR-34/FR-35 fail closed), so this
 * module never rejects a promise.
 */
async function runCommand(run: RunCommand, command: string[]): Promise<CommandResult> {
  try {
    return await run(command);
  } catch {
    return { code: -1, stdout: '', stderr: '' };
  }
}

/**
 * Full ENABLE flow of data-flows (c): support check → detect/probe →
 * snapshot → apply → verify. Resolves `{ ok:true, snapshot }`, or
 * `{ ok:false, error }` with the documented `errors.md` §4 triple
 * (E-PLAT-001 unsupported / schema missing, E-PLAT-002 command failure
 * after a snapshot-restore attempt).
 */
export async function setSystemProxy(context: SystemProxyContext): Promise<SetSystemProxyResult> {
  const support = isSupportedPlatform(context.platform, context.desktopEnv);
  if (!support.supported) {
    // Refused BEFORE any OS command runs — zero executor calls (TC-04-05).
    return unsupportedDesktop();
  }
  if (context.platform === 'darwin') {
    return setMacProxy(context);
  }
  return setGnomeProxy(context);
}

/** macOS ENABLE — §3.1 steps 1→5 over the injected executor. */
async function setMacProxy(context: SystemProxyContext): Promise<SetSystemProxyResult> {
  const { run } = context;
  const binary = 'networksetup';

  // step 1 — service detection (first candidate; multi-service stays Q-B/FR-37)
  const detect = await runCommand(run, buildMacDetectCommand());
  if (detect.code !== 0) {
    return commandFailure(binary);
  }
  const service = parseNetworkService(detect.stdout);
  if (service === undefined) {
    return commandFailure(binary);
  }

  // step 2 — SNAPSHOT (FR-31): prior socks AND secure-web state, kept in memory only
  const socksRead = await runCommand(run, macGetCommand('-getsocksfirewallproxy', service));
  if (socksRead.code !== 0) {
    return commandFailure(binary);
  }
  const secureWebRead = await runCommand(run, macGetCommand('-getsecurewebproxy', service));
  if (secureWebRead.code !== 0) {
    return commandFailure(binary);
  }
  const snapshot: MacProxySnapshot = {
    service,
    socks: parseMacSetting(socksRead.stdout),
    secureWeb: parseMacSetting(secureWebRead.stdout),
  };

  // step 3 — APPLY (arg arrays); step 4 — a non-zero exit rolls back to the
  // snapshot and reports the APPLY failure (E-PLAT-002, never the restore's)
  for (const command of buildMacOnCommands(service, LOOPBACK_HOST, DEFAULT_SOCKS_PORT)) {
    const applied = await runCommand(run, command);
    if (applied.code !== 0) {
      await replayMacSnapshot(run, snapshot);
      return commandFailure(binary);
    }
  }

  // step 5 — VERIFY via -getsocksfirewallproxy (AC-04.1); a bad read also rolls back
  const verify = await runCommand(run, macGetCommand('-getsocksfirewallproxy', service));
  if (verify.code !== 0 || !isMacLoopbackApplied(parseMacSetting(verify.stdout))) {
    await replayMacSnapshot(run, snapshot);
    return commandFailure(binary);
  }
  return { ok: true, snapshot };
}

/** GNOME ENABLE — §3.2 SUPPORT DETECT → steps 1→4 over the injected executor. */
async function setGnomeProxy(context: SystemProxyContext): Promise<SetSystemProxyResult> {
  const { run } = context;
  const binary = 'gsettings';

  // SUPPORT DETECT — schema present? (§3.2): a failing probe is NOT a command
  // failure, it is the unsupported-desktop case — EXACTLY E-PLAT-001, with
  // zero further commands (FR-32 ≡ FR-33, TC-04-11)
  const probe = await runCommand(run, gnomeGetSocksHostCommand());
  if (probe.code !== 0) {
    return unsupportedDesktop();
  }

  // step 1 — SNAPSHOT: the documented (mode, host, port) triple
  const modeRead = await runCommand(run, gnomeGetModeCommand());
  if (modeRead.code !== 0) {
    return commandFailure(binary);
  }
  const hostRead = await runCommand(run, gnomeGetSocksHostCommand());
  if (hostRead.code !== 0) {
    return commandFailure(binary);
  }
  const portRead = await runCommand(run, gnomeGetSocksPortCommand());
  if (portRead.code !== 0) {
    return commandFailure(binary);
  }
  const snapshot: GnomeProxySnapshot = {
    mode: parseGnomeString(modeRead.stdout),
    socksHost: parseGnomeString(hostRead.stdout),
    socksPort: parseGnomePort(portRead.stdout),
  };

  // step 2 — APPLY (raw argv); step 3 — a non-zero exit rolls back to the
  // snapshot triple and reports E-PLAT-002 (FR-34)
  for (const command of buildGnomeOnCommands(LOOPBACK_HOST, DEFAULT_SOCKS_PORT)) {
    const applied = await runCommand(run, command);
    if (applied.code !== 0) {
      await replayGnomeSnapshot(run, snapshot);
      return commandFailure(binary);
    }
  }

  // step 4 — VERIFY (AC-04.2): gsettings must report SOCKS 127.0.0.1:10808, mode manual
  const modeVerify = await runCommand(run, gnomeGetModeCommand());
  const hostVerify = await runCommand(run, gnomeGetSocksHostCommand());
  const portVerify = await runCommand(run, gnomeGetSocksPortCommand());
  if (
    modeVerify.code !== 0 ||
    hostVerify.code !== 0 ||
    portVerify.code !== 0 ||
    parseGnomeString(modeVerify.stdout) !== 'manual' ||
    parseGnomeString(hostVerify.stdout) !== LOOPBACK_HOST ||
    parseGnomePort(portVerify.stdout) !== DEFAULT_SOCKS_PORT
  ) {
    await replayGnomeSnapshot(run, snapshot);
    return commandFailure(binary);
  }
  return { ok: true, snapshot };
}

/**
 * DISABLE / STOP / CRASH / QUIT flow: replays `snapshot` through the
 * executor (every command is attempted, best effort). `snapshot === null`
 * (nothing was ever set) is an idempotent no-op that resolves `{ ok:true }`
 * without invoking `run` at all; a failing command resolves
 * `{ ok:false, E-PLAT-003 }` (FR-35, fail closed — never throws).
 */
export async function restoreSystemProxy(
  context: SystemProxyContext,
  snapshot: SystemProxySnapshot | null,
): Promise<OperationResult> {
  if (snapshot === null) {
    return { ok: true };
  }
  const commands =
    'service' in snapshot ? buildMacRestoreCommands(snapshot) : buildGnomeRestoreCommands(snapshot);
  let restored = true;
  for (const command of commands) {
    const result = await runCommand(context.run, command);
    if (result.code !== 0) {
      restored = false; // keep replaying: a full restore attempt beats a partial one
    }
  }
  if (!restored) {
    return { ok: false, error: restoreFailedError() };
  }
  return { ok: true };
}

// ─── Parsers (synthetic-format outputs, data-flows (c)) ─────────────────────

/**
 * `-listnetworkserviceorder` → the FIRST `Hardware Port: X, Device:`
 * candidate. Multi-service selection is Q-B/FR-37 and out of M1-21 scope —
 * fixtures carry exactly one candidate (DV-26(1)).
 */
function parseNetworkService(stdout: string): string | undefined {
  const match = /Hardware Port:\s*(.+?),\s*Device:/.exec(stdout);
  return match?.[1];
}

/** One `-get*proxy` getter block → `{ Enabled, Server, Port }` (DV-26(5)). */
function parseMacSetting(stdout: string): MacProxySetting {
  let enabled = false;
  let host = '';
  let port = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('Enabled: ')) {
      enabled = line.slice('Enabled: '.length) === 'Yes';
    } else if (line.startsWith('Server: ')) {
      host = line.slice('Server: '.length);
    } else if (line.startsWith('Port: ')) {
      const parsed = Number(line.slice('Port: '.length));
      port = Number.isFinite(parsed) ? parsed : 0;
    }
  }
  return { enabled, host, port };
}

/** Whether the step-5 verify read reports the applied loopback SOCKS proxy (AC-04.1). */
function isMacLoopbackApplied(setting: MacProxySetting): boolean {
  return setting.enabled && setting.host === LOOPBACK_HOST && setting.port === DEFAULT_SOCKS_PORT;
}

/** `gsettings get` string values come back single-quoted — strip the shell quotes (DV-26(3)). */
function parseGnomeString(stdout: string): string {
  const value = stdout.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/** `gsettings get` port → number; anything unparsable reads as 0 (documented default). */
function parseGnomePort(stdout: string): number {
  const parsed = Number(stdout.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

// ─── Snapshot replay helpers (rollback + restore) ───────────────────────────

/**
 * §3.1 step 4 rollback: replays the mac snapshot after a failed apply. The
 * reported error stays the APPLY failure (E-PLAT-002) whatever the replay
 * does — the restore attempt is best effort (errors.md §6).
 */
async function replayMacSnapshot(run: RunCommand, snapshot: MacProxySnapshot): Promise<void> {
  for (const command of buildMacRestoreCommands(snapshot)) {
    await runCommand(run, command);
  }
}

/** §3.2 rollback counterpart: replays the `(mode, host, port)` triple after a failed apply. */
async function replayGnomeSnapshot(run: RunCommand, snapshot: GnomeProxySnapshot): Promise<void> {
  for (const command of buildGnomeRestoreCommands(snapshot)) {
    await runCommand(run, command);
  }
}
