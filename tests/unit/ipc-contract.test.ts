/**
 * M1-06 (RED) — IPC contract between renderer and main, executable specification.
 *
 * Test plan IDs: TC-IPC-01, TC-IPC-02 (with the TC-07-03 payload-type half),
 * TC-IPC-03, TC-IPC-04, TC-IPC-05 (docs/qa/m1-test-plan.md §7) + plan M1-06
 * explicit cases: "only allowlisted channels reachable from renderer;
 * attempting a secret-bearing channel from renderer fails".
 * Spec sources: docs/analysis/data-flows.md §4.1–§4.3 (diagram, channel table,
 * shared payload types, explicit denylist), docs/analysis/requirements.md
 * FR-61..FR-64 (F9), NFR-1, US-07 AC-07.3, docs/qa/strategy.md §7 (NFR-1 pins
 * TC-IPC-01/02), docs/plans/m1-mvp.md M1-06 → M1-07.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT FOR M1-07 (developer GREEN task) — expected additions to the IPC
 * surface. Only the two M0 rows exist today (`app:ping` invoke + the `versions`
 * static field); this file must keep failing until all of the following lands:
 *
 * A) `src/shared/ipc.ts` — every channel declared here with direction and
 *    payload type (FR-61/FR-62, data-flows §4.2 "shared payload types"):
 *
 *      export const IPC_INVOKE_CHANNELS = [
 *        'app:ping', 'profile:import-dialog', 'profile:get', 'profile:remove',
 *        'core:start', 'core:stop', 'status:get', 'logs:get', 'logs:clear',
 *        'proxy:get', 'proxy:set',
 *      ] as const;                 // R → M, kind "invoke"  (11 rows of §4.2)
 *      export const IPC_PUSH_CHANNELS = [
 *        'status:changed', 'log:line',
 *      ] as const;                 // M → R, kind "send"    (2 rows of §4.2)
 *      export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number];
 *      export type IpcPushChannel = (typeof IPC_PUSH_CHANNELS)[number];
 *      export type IpcChannel = IpcInvokeChannel | IpcPushChannel;
 *        // namespaced literal union `<namespace>:<action>` — an unknown
 *        // channel must be a compile error (FR-61; @ts-expect-error pin below)
 *
 *    Payload types (exact shapes — no `any`, no undocumented extra fields):
 *
 *      export interface ProfileSummary { displayName: string;
 *        endpointHost: string; bucket: string; prefix: string;
 *        region: string; importedAt: string; socksPort: number; }
 *                                                // requirements §8.3
 *      export interface StatusSnapshot {
 *        state: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
 *        lastError: AppError | null;
 *        socksPort: number; }                   // §4.2 status:get / status:changed
 *                                                // (M1-05 machine snapshot +
 *                                                //  socksPort per the §4.2 row)
 *      export interface LogLine { ts: string;
 *        level: 'debug' | 'info' | 'warn' | 'error';
 *        source: 'core' | 'app';
 *        text: string; }                        // redacted text (FR-47)
 *      export interface AppError { code: string; title: string;
 *        cause: string; nextStep: string; }     // NFR-5 triple as data
 *      // AppError may be re-exported from src/shared/status-machine.ts (M1-05).
 *
 * B) `src/preload/index.ts` — the object passed to
 *    `contextBridge.exposeInMainWorld('s3Bypass', api)` maps 1:1 onto the
 *    allowlist (FR-61):
 *      • each of the 11 invoke channels → exactly one member calling
 *        `ipcRenderer.invoke(<channel>)`, resolving with the handler payload
 *        untouched (FR-62);
 *      • each of the 2 push channels → exactly one member registering
 *        `ipcRenderer.on(<channel>, listener)` and returning an unsubscribe
 *        function; the renderer listener receives main's payload unchanged
 *        (FR-63: pushed main→renderer, never polled);
 *      • plus the existing static `versions` field (§4.2: a preload constant,
 *        NOT a channel) — and nothing else: no extra members, no generic
 *        channel-string passthrough;
 *      • `ping()` keeps invoking `IPC_PING` ('app:ping', §4.2 EXISTS row).
 *
 * C) `src/main/index.ts` — one `ipcMain.handle(...)` per invoke channel;
 *    status transitions pushed with `webContents.send('status:changed',
 *    StatusSnapshot)` (FR-63). Main-side handlers are wired by M1-07 and
 *    exercised end-to-end later (M1-16/M1-17 exposure tests).
 *
 * Renderer-payload denylist encoded here INDEPENDENTLY of the allowlist
 * (data-flows §4.3, FR-64) so M1-07 cannot pass by accident: `accessKey` ·
 * `secretKey` · any `*token*` field · full profile/config JSON · the
 * materialized config path · the keychain blob. Adding a secret-bearing
 * channel to the allowlist fails the denylist test even when allowlist and
 * surface agree with each other; a raw passthrough member fails both.
 *
 * RED status: assertion RED (preload exists with `ping`/`versions` only) plus
 * absence RED (channel exports absent from src/shared/ipc.ts). Type-level pins
 * additionally fail `tsc --noEmit -p tsconfig.node.json`.
 * Do not weaken, skip, or delete anything here; M1-07 implements the contract.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import '../../src/preload/index';

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { IPC_PING } from '../../src/shared/constants';
import {
  type AppError,
  IPC_INVOKE_CHANNELS,
  IPC_PUSH_CHANNELS,
  type IpcChannel,
  type IpcInvokeChannel,
  type IpcPushChannel,
  type LogLine,
  type ProfileSummary,
  type StatusSnapshot,
} from '../../src/shared/ipc';

/**
 * Observes what the preload registers on the mocked electron APIs, so the
 * renderer-reachable surface can be enumerated channel by channel.
 */
const probe = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ channel: string; args: unknown[] }>,
  onCalls: [] as Array<{ channel: string; listener: (...args: unknown[]) => void }>,
  exposed: null as null | { key: string; api: Record<string, unknown> },
  invokeResult: undefined as unknown,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>) => {
      probe.exposed = { key, api };
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      probe.invokeCalls.push({ channel, args });
      return Promise.resolve(probe.invokeResult);
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      probe.onCalls.push({ channel, listener });
      return () => undefined;
    },
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
    send: () => undefined,
  },
}));

/** data-flows §4.2 — the M1 channel table: direction, kind, payload out. */
interface ChannelSpec {
  readonly channel: string;
  readonly direction: 'R→M' | 'M→R';
  readonly kind: 'invoke' | 'send';
  readonly payloadOut: string;
}

const CONTRACT_TABLE: readonly ChannelSpec[] = [
  {
    channel: 'app:ping',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut: 'PingResult { ok, app, socksPort }',
  },
  {
    channel: 'profile:import-dialog',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut:
      '{ ok:true, summary:ProfileSummary } | { ok:false, reason:"cancelled" } | { ok:false, error:AppError }',
  },
  {
    channel: 'profile:get',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut: '{ summary: ProfileSummary | null } — never the full config',
  },
  {
    channel: 'profile:remove',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut: '{ ok: boolean, error?: AppError }',
  },
  {
    channel: 'core:start',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut: '{ ok:true } | { ok:false, error:AppError }',
  },
  {
    channel: 'core:stop',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut: '{ ok:true } | { ok:false, error:AppError }',
  },
  {
    channel: 'status:get',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut: 'StatusSnapshot { state, lastError, socksPort }',
  },
  { channel: 'status:changed', direction: 'M→R', kind: 'send', payloadOut: 'StatusSnapshot' },
  {
    channel: 'logs:get',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut: '{ lines: LogLine[] } (redacted, ≤ 2000)',
  },
  {
    channel: 'log:line',
    direction: 'M→R',
    kind: 'send',
    payloadOut: 'LogLine { ts, level, source, text /* redacted */ }',
  },
  { channel: 'logs:clear', direction: 'R→M', kind: 'invoke', payloadOut: '{ ok: true }' },
  // "Copy logs" writes through main: navigator.clipboard rejects on an
  // unfocused window and the promise was discarded, so a failure looked
  // exactly like a button that does nothing.
  { channel: 'logs:copy', direction: 'R→M', kind: 'invoke', payloadOut: '{ ok: boolean }' },
  {
    channel: 'proxy:get',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut:
      '{ supported: boolean, active: boolean, hint?: { host: "127.0.0.1", port: 10808 } }',
  },
  {
    channel: 'proxy:set',
    direction: 'R→M',
    kind: 'invoke',
    payloadOut: '{ ok:true } | { ok:false, error:AppError } (in: { enabled: boolean })',
  },
];

const CONTRACT_INVOKE: string[] = CONTRACT_TABLE.filter((spec) => spec.kind === 'invoke').map(
  (spec) => spec.channel,
);
const CONTRACT_PUSH: string[] = CONTRACT_TABLE.filter((spec) => spec.kind === 'send').map(
  (spec) => spec.channel,
);
/** Flat allowlist as plain strings, safe for membership checks. */
const CONTRACT_ALL: string[] = CONTRACT_TABLE.map((spec) => spec.channel);

const STATUS_CHANGED = 'status:changed';

/**
 * data-flows §4.3 denylist as channel-name rules — deliberately independent of
 * the allowlist above: a secret-bearing channel that M1-07 adds to
 * `IPC_INVOKE_CHANNELS` fails `ipc.allowlist.secretBearingChannelUnreachableFromRenderer`
 * even when declarations and exposed surface agree with each other. Each rule
 * is paired with an example channel name that would have to deliver one of the
 * §4.3 denied values; the pairs are self-checked (rule flags its example, rule
 * spares every contract channel) before any scan runs.
 */
const SECRET_DENYLIST: ReadonlyArray<{ readonly pattern: RegExp; readonly example: string }> = [
  // — data-flows §4.3 verbatim: accessKey · secretKey · *token* · full
  //   profile/config JSON · materialized path T · keychain blob —
  { pattern: /access[:_-]?key/i, example: 'accesskey:get' },
  { pattern: /secret[:_-]?key/i, example: 'secretkey:get' },
  { pattern: /token/i, example: 'token:get' },
  { pattern: /full[:_-]?config/i, example: 'fullconfig:get' },
  { pattern: /raw[:_-]?config/i, example: 'rawconfig:get' },
  { pattern: /config[:_-]?(full|raw|json|path|file|blob)/i, example: 'config:path' },
  { pattern: /profile[:_-]?(raw|full|document|json)/i, example: 'profile:raw' },
  { pattern: /materiali[sz]ed/i, example: 'materialized:path' },
  { pattern: /keychain/i, example: 'keychain:get' },
  { pattern: /blob/i, example: 'store:blob' },
  // — NFR-2 hygiene: the word "secret", credentials, session tokens (the
  //   canary fixture §9.3) — still never allowed to cross main → renderer —
  { pattern: /secret/i, example: 'secrets:get' },
  { pattern: /credential/i, example: 'credentials:get' },
  { pattern: /session/i, example: 'session:get' },
  { pattern: /keystore/i, example: 'keystore:get' },
  { pattern: /password/i, example: 'password:get' },
];

function isSecretChannelName(name: string): boolean {
  return SECRET_DENYLIST.some(({ pattern }) => pattern.test(name));
}

/**
 * Absence-RED helper: an export the M1-07 contract requires but that does not
 * exist yet must fail with a message naming the contract, never silently pass
 * as `undefined`.
 */
function requireDeclared<T>(value: T | undefined, expectation: string): T {
  if (value === undefined) {
    throw new Error(
      `M1-07 contract missing: src/shared/ipc.ts must export ${expectation} ` +
        '(docs/analysis/data-flows.md §4.2, requirements FR-61/FR-62). ' +
        'Expected RED until M1-07 implements it — do not weaken or delete this test.',
    );
  }
  return value;
}

function exposedApi(): Record<string, unknown> {
  if (probe.exposed === null) {
    throw new Error(
      'preload never called contextBridge.exposeInMainWorld — ' +
        'M1-07 must expose the renderer surface (FR-61, data-flows §4.1)',
    );
  }
  expect(probe.exposed.key, 'the bridge must be exposed under the documented global name').toBe(
    's3Bypass',
  );
  return probe.exposed.api;
}

/** Benign first argument: invokers ignore it, subscribers treat it as a listener. */
const NOOP_LISTENER = () => undefined;

interface SurfaceScan {
  /** Channels reached through `ipcRenderer.invoke` (R → M). */
  readonly invokeObserved: string[];
  /** Channels reached through `ipcRenderer.on` (M → R push subscription). */
  readonly pushObserved: string[];
  /** Members that touch no contract channel — forbidden (FR-61 "nothing extra"). */
  readonly unmappedMembers: string[];
  /** Non-function members — only the §4.2 `versions` field is allowed. */
  readonly staticKeys: string[];
}

function scanSurface(): SurfaceScan {
  const api = exposedApi();
  const scan: SurfaceScan = {
    invokeObserved: [],
    pushObserved: [],
    unmappedMembers: [],
    staticKeys: [],
  };
  for (const [key, member] of Object.entries(api)) {
    if (typeof member !== 'function') {
      scan.staticKeys.push(key);
      continue;
    }
    const invokeBefore = probe.invokeCalls.length;
    const onBefore = probe.onCalls.length;
    try {
      const unsubscribe = (member as (arg: unknown) => unknown)(NOOP_LISTENER);
      if (typeof unsubscribe === 'function') (unsubscribe as () => void)();
    } catch {
      // A member rejecting the benign probe argument is acceptable; anything it
      // registered before rejecting is still counted below.
    }
    const invoked = probe.invokeCalls.slice(invokeBefore).map((call) => call.channel);
    const subscribed = probe.onCalls.slice(onBefore).map((call) => call.channel);
    scan.invokeObserved.push(...invoked);
    scan.pushObserved.push(...subscribed);
    if (invoked.length === 0 && subscribed.length === 0) scan.unmappedMembers.push(key);
  }
  return scan;
}

/** Minimal stand-in for Electron's `IpcRendererEvent` (payload arrives second). */
const FAKE_IPC_EVENT = { sender: null, preventDefault: () => undefined };

const CORE_STATES = ['stopped', 'starting', 'running', 'stopping', 'crashed'] as const;

/**
 * Contract shape only (data-flows §4.2 StatusSnapshot) — pins what may cross
 * the push boundary, not any business behavior of the status machine.
 */
function expectStatusSnapshotShape(value: unknown, context: string): void {
  expect(value, `${context}: status:changed payload must be a StatusSnapshot`).toBeTypeOf('object');
  const snapshot = value as Record<string, unknown>;
  expect([...CORE_STATES], `${context}: state must be a §2.3 lifecycle state`).toContain(
    snapshot.state,
  );
  if (snapshot.lastError === undefined) {
    expect(
      snapshot.lastError,
      `${context}: lastError must be explicitly null, not missing`,
    ).toBeNull();
  } else if (snapshot.lastError === null) {
    expect(
      snapshot.lastError,
      `${context}: lastError must be null when there is no error`,
    ).toBeNull();
  } else {
    const lastError = snapshot.lastError as Record<string, unknown>;
    for (const field of ['code', 'title', 'cause', 'nextStep']) {
      expect(
        typeof lastError[field],
        `${context}: lastError.${field} must be a string (NFR-5 triple)`,
      ).toBe('string');
      expect(
        String(lastError[field]).length,
        `${context}: lastError.${field} must not be empty (NFR-5 triple)`,
      ).toBeGreaterThan(0);
    }
    expect(
      JSON.stringify(lastError),
      `${context}: lastError must not contain a raw stack trace (FR-48 / NFR-5)`,
    ).not.toMatch(/\n\s+at\s+\S+\(/);
  }
  expect(snapshot.socksPort, `${context}: socksPort must be a number (§4.2)`).toBeTypeOf('number');
  expect(
    Object.keys(snapshot).sort(),
    `${context}: StatusSnapshot carries exactly { state, lastError, socksPort } (§4.2)`,
  ).toEqual(['lastError', 'socksPort', 'state']);
}

beforeEach(() => {
  probe.invokeCalls.length = 0;
  probe.onCalls.length = 0;
  probe.invokeResult = { ok: true, app: 'S3 Bypass Desktop', socksPort: 10808 };
});

describe('IPC allowlist — renderer-reachable surface (FR-61, §4.2) — TC-IPC-01', () => {
  it('ipc.allowlist.exposedSurfaceMatchesContractExactly', () => {
    // FR-61 / plan M1-06 "only allowlisted channels reachable from renderer":
    // every §4.2 channel reachable through the bridge in its documented
    // direction, and nothing outside the allowlist.
    const scan = scanSurface();

    const missing = [
      ...CONTRACT_INVOKE.filter((channel) => !scan.invokeObserved.includes(channel)),
      ...CONTRACT_PUSH.filter((channel) => !scan.pushObserved.includes(channel)),
    ];
    const missingDetail = CONTRACT_TABLE.filter((spec) => missing.includes(spec.channel))
      .map(
        (spec) =>
          `${spec.channel} (${spec.direction} ${spec.kind}, payload out: ${spec.payloadOut})`,
      )
      .join('; ');
    expect(
      missing,
      'every §4.2 channel must be reachable via the s3Bypass surface in its ' +
        `documented direction (FR-61). No member found for: ${missingDetail}`,
    ).toEqual([]);

    const extra = [
      ...scan.invokeObserved.filter((channel) => !CONTRACT_INVOKE.includes(channel)),
      ...scan.pushObserved.filter((channel) => !CONTRACT_PUSH.includes(channel)),
    ];
    expect(
      extra,
      'the surface must expose nothing beyond the §4.2 allowlist — a non-' +
        'allowlisted channel on the surface fails FR-61',
    ).toEqual([]);

    const observed = [...scan.invokeObserved, ...scan.pushObserved];
    expect(
      observed,
      'each contract channel must be bound by exactly one surface member — ' +
        'no duplicate or shadow bindings',
    ).toEqual([...new Set(observed)]);

    expect(
      scan.unmappedMembers,
      'every function member of the surface must bind to a §4.2 channel — ' +
        'extra members widen the renderer reach beyond the allowlist (FR-61)',
    ).toEqual([]);

    expect(
      scan.staticKeys,
      'the only non-function member allowed on the surface is the §4.2 ' +
        '`versions` preload constant (a field, not a channel)',
    ).toEqual(['versions']);
    const api = exposedApi();
    expect('versions' in api, 'the §4.2 preload constant `versions` must stay on the surface').toBe(
      true,
    );
    if ('versions' in api) {
      const versions = api.versions as Record<string, unknown>;
      expect(
        Object.keys(versions).sort(),
        'versions is AppVersions { chrome, electron, node } (§4.2 / src/shared/ipc.ts)',
      ).toEqual(['chrome', 'electron', 'node']);
      for (const field of ['electron', 'chrome', 'node']) {
        expect(typeof versions[field], `versions.${field} must be a string`).toBe('string');
      }
    }
  });

  it('ipc.allowlist.unknownChannelFromRendererFails', () => {
    // FR-61: an unknown channel must fail — the renderer has no way to name a
    // channel itself, so the only escape hatch would be a member that forwards
    // arbitrary channel strings (a raw ipcRenderer passthrough). Probe every
    // member with a canary channel that is deliberately not in the allowlist.
    const CANARY_CHANNEL = 'secrets:get';
    const api = exposedApi();
    for (const [key, member] of Object.entries(api)) {
      if (typeof member !== 'function') continue;
      const invokeBefore = probe.invokeCalls.length;
      const onBefore = probe.onCalls.length;
      try {
        const unsubscribe = (member as (arg: unknown) => unknown)(CANARY_CHANNEL);
        if (typeof unsubscribe === 'function') (unsubscribe as () => void)();
      } catch {
        // Rejecting the canary is fine — the attempt must simply never land on
        // an electron API.
      }
      const touched = [
        ...probe.invokeCalls.slice(invokeBefore).map((call) => `invoke:${call.channel}`),
        ...probe.onCalls.slice(onBefore).map((call) => `on:${call.channel}`),
      ];
      // Strip the "invoke:"/"on:" prefix; anything left must be a contract channel.
      const offContract = touched.filter(
        (binding) => !CONTRACT_ALL.includes(binding.slice(binding.indexOf(':') + 1)),
      );
      expect(
        offContract,
        `api.${key} must bind contract channels only — forwarding arbitrary ` +
          `channel names (here: "${CANARY_CHANNEL}") would bypass the FR-61 ` +
          'allowlist and could reach secret-bearing channels (FR-64)',
      ).toEqual([]);
    }
  });
});

describe('channel declarations in src/shared/ipc.ts (FR-62) — TC-IPC-03', () => {
  it('ipc.contract.declaresChannelsWithDirectionAndPayloadTypes', () => {
    // FR-62: direction (which array a channel sits in ⇔ invoke vs push) and
    // payload type are declared in src/shared/ipc.ts — the artifact M1-07 must
    // add; absence fails with the contract message, never silently.
    const declaredInvoke = requireDeclared(
      IPC_INVOKE_CHANNELS,
      'IPC_INVOKE_CHANNELS — the R→M invoke allowlist (§4.2, 11 rows)',
    );
    const declaredPush = requireDeclared(
      IPC_PUSH_CHANNELS,
      'IPC_PUSH_CHANNELS — the M→R push list (§4.2, 2 rows)',
    );

    expect(
      [...(declaredInvoke as readonly string[])].sort(),
      'the declared invoke allowlist must equal the §4.2 R→M rows, exact names',
    ).toEqual([...CONTRACT_INVOKE].sort());
    expect(
      [...(declaredPush as readonly string[])].sort(),
      'the declared push list must equal the §4.2 M→R rows, exact names',
    ).toEqual([...CONTRACT_PUSH].sort());

    // Shared payload types declared alongside the channels (§4.2 "shared
    // payload types"; type-level pins — enforced by `npm run typecheck`):
    expectTypeOf<AppError>().toEqualTypeOf<{
      code: string;
      title: string;
      cause: string;
      nextStep: string;
    }>();
    expectTypeOf<LogLine>().toEqualTypeOf<{
      ts: string;
      level: 'debug' | 'info' | 'warn' | 'error';
      source: 'core' | 'app';
      text: string;
    }>();
  });

  it('ipc.contract.channelsAreNamespacedLiteralUnions', () => {
    // FR-61/FR-62: channel names form namespaced literal unions — misuse is a
    // compile error, not a runtime surprise. Runtime half: the declared names
    // are namespaced `<namespace>:<action>` with a §4.2 namespace.
    const declared = [
      ...(requireDeclared(
        IPC_INVOKE_CHANNELS,
        'IPC_INVOKE_CHANNELS — the namespaced channel literal union',
      ) as readonly string[]),
      ...(requireDeclared(
        IPC_PUSH_CHANNELS,
        'IPC_PUSH_CHANNELS — the namespaced channel literal union',
      ) as readonly string[]),
    ];
    const NAMESPACES = ['app', 'profile', 'core', 'status', 'logs', 'log', 'proxy'];
    expect(
      declared.filter((channel) => {
        const [namespace, action] = channel.split(':');
        return (
          namespace === undefined ||
          action === undefined ||
          !NAMESPACES.includes(namespace) ||
          !/^[a-z][a-z0-9-]*$/.test(action)
        );
      }),
      'every channel must be a namespaced `<namespace>:<action>` literal from ' +
        'the §4.2 namespaces',
    ).toEqual([]);

    // Type-level half (enforced by `npm run typecheck`, tsc --noEmit):
    expectTypeOf<IpcInvokeChannel>().toEqualTypeOf<
      | 'app:ping'
      | 'profile:import-dialog'
      | 'profile:get'
      | 'profile:remove'
      | 'core:start'
      | 'core:stop'
      | 'status:get'
      | 'logs:get'
      | 'logs:clear'
      | 'logs:copy'
      | 'proxy:get'
      | 'proxy:set'
    >();
    expectTypeOf<IpcPushChannel>().toEqualTypeOf<'status:changed' | 'log:line'>();
    expectTypeOf<IpcChannel>().toEqualTypeOf<
      | 'app:ping'
      | 'profile:import-dialog'
      | 'profile:get'
      | 'profile:remove'
      | 'core:start'
      | 'core:stop'
      | 'status:get'
      | 'logs:get'
      | 'logs:clear'
      | 'logs:copy'
      | 'proxy:get'
      | 'proxy:set'
      | 'status:changed'
      | 'log:line'
    >();

    // Only the contract literals may be assigned: an unknown channel must be a
    // compile error (FR-61). If the union widens, tsc reports this directive as
    // "Unused '@ts-expect-error'" and `npm run typecheck` fails.
    // @ts-expect-error — 'profile:export' is not part of the §4.2 allowlist
    const unknownChannel: IpcChannel = 'profile:export';
    expect(CONTRACT_ALL, 'the compile-error example must not be a contract channel').not.toContain(
      unknownChannel,
    );
  });
});

describe('secret denylist (FR-64 / data-flows §4.3, TC-IPC-02 + TC-07-03)', () => {
  it('ipc.denylist.patternRulesFlagSecretExamplesAndSpareContract', () => {
    // Self-validation of the encoded denylist: every rule must flag the §4.3
    // example it was written for, no rule may collide with a contract channel
    // (false positives), and no example channel may sit in the allowlist.
    for (const { pattern, example } of SECRET_DENYLIST) {
      expect(
        pattern.test(example),
        `denylist rule ${pattern} must flag its §4.3 example channel "${example}"`,
      ).toBe(true);
      expect(
        CONTRACT_ALL.filter((channel) => pattern.test(channel)),
        `denylist rule ${pattern} must not flag contract channels (false-positive guard)`,
      ).toEqual([]);
      expect(
        CONTRACT_ALL,
        `§4.3 example channel "${example}" must never be part of the allowlist`,
      ).not.toContain(example);
    }
  });

  it('ipc.allowlist.secretBearingChannelUnreachableFromRenderer', () => {
    // FR-64 / AC-07.3 / §4.3 "test hook": scan what actually crosses (or can
    // cross) toward the renderer. Rules are independent of the allowlist, so
    // M1-07 cannot pass by accident by declaring and exposing the same secret
    // channel consistently.
    const declared = [
      ...(requireDeclared(
        IPC_INVOKE_CHANNELS,
        'IPC_INVOKE_CHANNELS — the §4.3 denylist has no allowlist to scan without it (FR-64)',
      ) as readonly string[]),
      ...(requireDeclared(
        IPC_PUSH_CHANNELS,
        'IPC_PUSH_CHANNELS — the §4.3 denylist has no allowlist to scan without it (FR-64)',
      ) as readonly string[]),
    ];
    expect(
      declared.filter(isSecretChannelName),
      'denylist (§4.3): a declared channel matches a secret-bearing name — ' +
        'no such channel may exist on the renderer side (FR-64)',
    ).toEqual([]);

    // Live surface scanned independently of the declarations (defense in depth
    // on top of TC-IPC-01's surface ≡ allowlist equality).
    const scan = scanSurface();
    expect(
      [...scan.invokeObserved, ...scan.pushObserved].filter(isSecretChannelName),
      'denylist (§4.3): the renderer-reachable surface subscribes to or invokes ' +
        'a secret-bearing channel',
    ).toEqual([]);
    expect(
      Object.keys(exposedApi()).filter(isSecretChannelName),
      'denylist (§4.3): even a member NAME hinting at secrets must not be ' +
        'exposed (FR-55: secrets live exclusively in main)',
    ).toEqual([]);

    // FR-55 / §8.3: the only config shape the renderer may ever receive is
    // ProfileSummary — exact fields, no accessKey/secretKey/*token* (type-level
    // pin, enforced by `npm run typecheck`).
    expectTypeOf<ProfileSummary>().toEqualTypeOf<{
      displayName: string;
      endpointHost: string;
      bucket: string;
      prefix: string;
      region: string;
      importedAt: string;
      socksPort: number;
    }>();
  });
});

describe('status-change push events (FR-63) — TC-IPC-04', () => {
  it('ipc.push.statusChangedDeliversStatusSnapshotToRenderer', () => {
    // FR-63: status changes are pushed main → renderer; the renderer registers
    // one listener per push channel and receives main's StatusSnapshot
    // unchanged (contract shape only — data-flows §4.2).
    const api = exposedApi();
    const received: unknown[] = [];
    let subscriberKey: string | undefined;

    for (const [key, member] of Object.entries(api)) {
      if (typeof member !== 'function') continue;
      const onBefore = probe.onCalls.length;
      try {
        const unsubscribe = (member as (listener: unknown) => unknown)((payload: unknown) =>
          received.push(payload),
        );
        if (typeof unsubscribe === 'function') (unsubscribe as () => void)();
      } catch {
        // Discovery continues: a member rejecting the probe listener is not the
        // subscriber we are looking for.
      }
      if (probe.onCalls.slice(onBefore).some((call) => call.channel === STATUS_CHANGED)) {
        subscriberKey = key;
        break;
      }
    }
    expect(
      subscriberKey,
      `M1-07 must expose a '${STATUS_CHANGED}' subscriber on the s3Bypass ` +
        'surface — status is pushed main→renderer, never polled (FR-63, FR-26)',
    ).toBeDefined();

    const registration = probe.onCalls.find((call) => call.channel === STATUS_CHANGED);
    if (registration === undefined) {
      throw new Error('unreachable: the subscriber registered above');
    }

    const running: StatusSnapshot = { state: 'running', lastError: null, socksPort: 10808 };
    const crashed: StatusSnapshot = {
      state: 'crashed',
      lastError: {
        code: 'E-CORE-001',
        title: 'Core exited unexpectedly',
        cause: 'core process exited with code 1',
        nextStep: 'Check the logs for details.',
      },
      socksPort: 10808,
    };
    // Electron invokes the registered listener as (event, payload) — simulate
    // main's webContents.send('status:changed', snapshot) faithfully.
    registration.listener(FAKE_IPC_EVENT, running);
    registration.listener(FAKE_IPC_EVENT, crashed);

    expect(
      received,
      `every '${STATUS_CHANGED}' push must reach the renderer listener ` +
        '(FR-63: two transitions pushed, both delivered)',
    ).toHaveLength(2);
    expect(
      received,
      'the push payload must be forwarded to the renderer unchanged ' +
        '(FR-62: declared payload type crosses the bridge as-is)',
    ).toEqual([running, crashed]);
    received.forEach((payload, index) => {
      expectStatusSnapshotShape(payload, `status:changed push #${index + 1}`);
    });

    // Type-level pin (npm run typecheck): the payload is the §4.2
    // StatusSnapshot — { state, lastError: AppError | null, socksPort }.
    expectTypeOf<StatusSnapshot>().toEqualTypeOf<{
      state: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
      lastError: AppError | null;
      socksPort: number;
    }>();
  });
});

describe('M0 regression guard (§4.2 EXISTS row) — TC-IPC-05', () => {
  it('ipc.ping.regressionKeepsExistingChannelAndResultShape', async () => {
    // The one channel that already exists must survive M1-07 unchanged:
    // app:ping stays invocable, keeps its name, and returns PingResult as-is.
    const api = exposedApi();
    expect(typeof api.ping, 'the ping member must stay on the surface').toBe('function');

    const handlerResult = { ok: true, app: 'S3 Bypass Desktop', socksPort: 10808 };
    probe.invokeResult = handlerResult;

    const result = await (api.ping as () => Promise<unknown>)();

    expect(
      probe.invokeCalls.map((call) => call.channel),
      'ping must keep using the existing app:ping channel (§4.2 EXISTS row)',
    ).toEqual([IPC_PING]);
    expect(IPC_PING, 'the app:ping channel name is frozen by §4.2').toBe('app:ping');
    expect(
      result,
      'PingResult { ok, app, socksPort } must reach the renderer untouched (FR-62)',
    ).toEqual(handlerResult);
    expect(
      Object.keys(result as Record<string, unknown>).sort(),
      'PingResult carries exactly { app, ok, socksPort } (src/shared/ipc.ts)',
    ).toEqual(['app', 'ok', 'socksPort']);
  });
});
