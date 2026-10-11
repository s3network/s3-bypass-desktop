/**
 * IPC contract between renderer, preload and main (FR-61..FR-64, feature F9).
 *
 * Spec: docs/analysis/data-flows.md §4.2 (channel table + shared payload
 * types) and §4.3 (secret denylist), docs/analysis/requirements.md FR-61..FR-64
 * and §8.3 (ProfileSummary), docs/analysis/errors.md §0 (NFR-5 AppError triple).
 *
 * Pure module: declarations and readonly allowlists only — no Electron imports,
 * no side effects; safe to consume from main, preload and renderer alike.
 */

import { IPC_PING } from './constants';
import type { AppError, CoreState } from './status-machine';

export type { AppError };

/**
 * R → M invoke channels (data-flows §4.2, FR-61): the complete allowlist of
 * channels the renderer may reach through the preload. A channel name absent
 * from this array must never appear on the renderer-facing surface (FR-64's
 * denylist test scans this list independently of the surface).
 */
export const IPC_INVOKE_CHANNELS = [
  IPC_PING,
  'profile:import-dialog',
  'profile:get',
  'profile:remove',
  'core:start',
  'core:stop',
  'status:get',
  'logs:get',
  'logs:clear',
  'logs:copy',
  'proxy:get',
  'proxy:set',
] as const;

/** M → R push channels (data-flows §4.2, FR-63): pushed via `webContents.send`, never polled. */
export const IPC_PUSH_CHANNELS = ['status:changed', 'log:line'] as const;

/** Namespaced literal union of every R→M channel — an unknown name is a compile error (FR-61). */
export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number];

/** Namespaced literal union of every M→R push channel (FR-63). */
export type IpcPushChannel = (typeof IPC_PUSH_CHANNELS)[number];

/** Every channel that may cross the bridge, in either direction. */
export type IpcChannel = IpcInvokeChannel | IpcPushChannel;

/**
 * The only config shape the renderer may ever receive (requirements §8.3,
 * FR-55): a redacted display summary — no accessKey, no secretKey, no
 * `*token*` field, never the full config JSON (data-flows §4.3 denylist).
 */
export interface ProfileSummary {
  /** Derived label, e.g. "vlt-alpha @ endpoint-host". */
  displayName: string;
  /** Hostname only — no scheme, path or userinfo. */
  endpointHost: string;
  bucket: string;
  prefix: string;
  region: string;
  /** ISO-8601 timestamp of the import. */
  importedAt: string;
  /** Fixed local SOCKS port (10808). */
  socksPort: number;
}

/**
 * Status of the supervised core as it crosses IPC (§4.2): the M1-05 status
 * machine snapshot (`state` + `lastError`) plus the SOCKS port the tunnel
 * listens on.
 */
export interface StatusSnapshot {
  state: CoreState;
  /** Most recent error as the NFR-5 triple, or null when there is none. */
  lastError: AppError | null;
  socksPort: number;
}

/** One log line pushed/returned across IPC (§4.2, FR-47) — `text` is redacted at the source. */
export interface LogLine {
  /** ISO-8601 timestamp. */
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: 'core' | 'app';
  /** Redacted line text — never raw credentials/config (NFR-2). */
  text: string;
}

/**
 * `profile:import-dialog` result (§4.2): success, a non-error user refusal
 * (picker cancel, a declined overwrite, or a second invoke while the picker
 * is already open — FR-08/FR-01: none of these is a failure, so none carries
 * an NFR-5 triple; the `busy` arm is S4-6 / issue #5, M1-26b), or an NFR-5
 * failure.
 */
export type ProfileImportResult =
  | { ok: true; summary: ProfileSummary }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'declined' }
  | { ok: false; reason: 'busy' }
  | { ok: false; error: AppError };

/** `profile:get` result (§4.2): the summary only — never the full config (FR-55). */
export interface ProfileView {
  summary: ProfileSummary | null;
}

/** `profile:remove` result (§4.2). */
export interface ProfileRemovalResult {
  ok: boolean;
  error?: AppError;
}

/** Discriminated result of `core:start`, `core:stop` and `proxy:set` (§4.2). */
export type OperationResult = { ok: true } | { ok: false; error: AppError };

/** `logs:get` result (§4.2): redacted lines, at most 2000 (FR-45/FR-47). */
export interface LogsView {
  lines: LogLine[];
}

/** Loopback hint shown when automatic system-proxy control is unavailable (§4.2, E-PLAT-001). */
export interface ProxyHint {
  host: '127.0.0.1';
  port: number;
}

/** `proxy:get` result (§4.2). */
export interface ProxyState {
  supported: boolean;
  active: boolean;
  hint?: ProxyHint;
}

/** `proxy:set` payload in (§4.2). */
export interface ProxyToggleRequest {
  enabled: boolean;
}

/**
 * The renderer-facing bridge the preload exposes as `window.s3Bypass`
 * (FR-61): exactly one member per §4.2 channel in its documented direction,
 * plus the static `versions` preload constant (a field, not a channel).
 *
 * - Invoke members resolve with the main handler's payload untouched (FR-62).
 * - Push members register one listener on a M→R channel and return an
 *   unsubscribe function; the renderer receives main's payload unchanged
 *   (FR-63 — pushed, never polled).
 * - No raw `ipcRenderer` passthrough: an unknown channel is unreachable
 *   from the renderer (FR-61/FR-64).
 */
export interface S3BypassApi {
  ping(): Promise<PingResult>;
  importProfileDialog(): Promise<ProfileImportResult>;
  getProfile(): Promise<ProfileView>;
  removeProfile(): Promise<ProfileRemovalResult>;
  startCore(): Promise<OperationResult>;
  stopCore(): Promise<OperationResult>;
  getStatus(): Promise<StatusSnapshot>;
  getLogs(): Promise<LogsView>;
  clearLogs(): Promise<{ ok: true }>;
  copyLogs(text: string): Promise<{ ok: boolean }>;
  getProxy(): Promise<ProxyState>;
  setProxy(request: ProxyToggleRequest): Promise<OperationResult>;
  onStatusChanged(listener: (snapshot: StatusSnapshot) => void): () => void;
  onLogLine(listener: (line: LogLine) => void): () => void;
  versions: AppVersions;
}

/** Result of the `app:ping` invoke channel (§4.2 EXISTS row). */
export interface PingResult {
  ok: boolean;
  app: string;
  socksPort: number;
}

/** Static preload constant on the bridge — not a channel (§4.2). */
export interface AppVersions {
  electron: string;
  chrome: string;
  node: string;
}
