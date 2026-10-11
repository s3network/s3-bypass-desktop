import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { IPC_PING } from '../shared/constants';
import type {
  IpcInvokeChannel,
  IpcPushChannel,
  LogLine,
  LogsView,
  OperationResult,
  PingResult,
  ProfileImportResult,
  ProfileRemovalResult,
  ProfileView,
  ProxyState,
  S3BypassApi,
  StatusSnapshot,
} from '../shared/ipc';

/**
 * Invokes an allowlisted R→M channel (FR-61): the channel argument is
 * compile-time constrained to `IpcInvokeChannel`, so an arbitrary channel
 * string cannot be forwarded from here. The resolved value is main's
 * handler payload, untouched (FR-62 — payload types are the §4.2 contract
 * each `ipcMain.handle` is declared to return).
 */
function invoke<T>(channel: IpcInvokeChannel, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

/**
 * Subscribes to an allowlisted M→R push channel (FR-63): Electron delivers
 * `(event, payload)`; the event is consumed here and the renderer listener
 * receives main's payload unchanged. Returns the unsubscribe function so the
 * renderer can detach again.
 */
function subscribe<T>(channel: IpcPushChannel, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

// Renderer-only access pattern: the renderer may call exactly the members
// exposed on this object — it never touches ipcRenderer directly. The surface
// mirrors the §4.2 channel allowlist 1:1 (FR-61); docs/analysis/data-flows.md
// §4 defines what may cross the bridge (and what never may, FR-64).
const api: S3BypassApi = {
  ping: () => invoke<PingResult>(IPC_PING),
  importProfileDialog: () => invoke<ProfileImportResult>('profile:import-dialog'),
  getProfile: () => invoke<ProfileView>('profile:get'),
  removeProfile: () => invoke<ProfileRemovalResult>('profile:remove'),
  startCore: () => invoke<OperationResult>('core:start'),
  stopCore: () => invoke<OperationResult>('core:stop'),
  getStatus: () => invoke<StatusSnapshot>('status:get'),
  getLogs: () => invoke<LogsView>('logs:get'),
  clearLogs: () => invoke<{ ok: true }>('logs:clear'),
  copyLogs: (text: string) => invoke<{ ok: boolean }>('logs:copy', text),
  getProxy: () => invoke<ProxyState>('proxy:get'),
  setProxy: (request) => invoke<OperationResult>('proxy:set', request),
  onStatusChanged: (listener) => subscribe<StatusSnapshot>('status:changed', listener),
  // S5-7 (issue #13): main batches `log:line` payloads (a send may carry one
  // `LogLine` or a `LogLine[]` of accumulated lines) — the renderer-facing
  // contract is still ONE call per line, so a batch expands here (FR-63:
  // payload coalesced in main, listener semantics unchanged).
  onLogLine: (listener) =>
    subscribe<LogLine | LogLine[]>('log:line', (payload) => {
      if (Array.isArray(payload)) {
        for (const line of payload) {
          listener(line);
        }
        return;
      }
      listener(payload);
    }),
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
  },
};

contextBridge.exposeInMainWorld('s3Bypass', api);
