/**
 * M1-26 (RED) — security hardening of the supervisor batch:
 *   S5-1 defense-in-depth at materialization (GitHub issue #7 → TC-02-19),
 *   S5-2 redaction BEFORE the crash line enters lastError (issue #8 →
 *   TC-07-19), S5-3 `forceStop()` kill-from-any-state (issue #9 → TC-05-20).
 *
 * Test plan IDs: TC-02-19 (§2 US-02), TC-07-19 (§7 US-07), TC-05-20 (§5
 * US-05) — docs/qa/m1-test-plan.md, allocated in §14 DV-32. The wiring half
 * of S5-3 (TC-05-21/22) lives in tests/unit/quit-force-stop.test.ts.
 *
 * Spec sources: docs/qa/security-m1-25.md §2/§3 S5-1/S5-2/S5-3 (findings +
 * fix options); docs/analysis/requirements.md FR-16/FR-17/FR-23 (stop, crash,
 * never log T), BR-V-09 (loopback-only — fix option 2: "pin every socks
 * inbound … not just the first"); docs/analysis/errors.md §3 (E-CORE-001
 * cause names the exit code AND the "last redacted core line" — S5-2 quotes
 * errors.md:70,74 + data-flows.md:90/127/293), §6 (child reaped, T deleted);
 * docs/analysis/data-flows.md §2.1 step 9 (quit: no orphan, no leftover) and
 * §2.3 (crash path).
 *
 * Layer: L2 integration with REAL child processes (stub binary, strategy §2/§1)
 * — the rig below is the core-supervisor.test.ts harness copied per the batch
 * plan (module-local rig: `tests/` files never import each other's suites),
 * including the DV-29 port barrier, child reaping and env restoration.
 * Cross-file determinism (§14 DV-33): both this file and core-supervisor
 * .test.ts bind 127.0.0.1:10808 with REAL children while vitest runs test
 * FILES in parallel workers, so the file-level `beforeEach`/`afterEach` below
 * additionally take the DV-33 lockfile mutex (os.tmpdir()/.port-10808.lock)
 * shared with that suite — barrier/setup addition only, zero assertions
 * touched.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT FOR M1-26 (header-contract style, DV-09/DV-16; any deviation
 * requires an upstream spec note first — strategy §5.2, never a silent test
 * edit):
 *
 * A) TC-02-19 (S5-1 defense-in-depth, EITHER documented fix arm accepted):
 *    starting with a profile carrying a non-loopback extra inbound must
 *    either REFUSE start with a documented `E-VAL-*` code, or materialize T
 *    with EVERY inbound entry loopback-only (127.0.0.1 / ::1) — i.e. the
 *    extra entry is rejected upstream (validator, TC-01-37..39), stripped at
 *    materialization, or pinned to loopback. Today neither arm holds: the
 *    0.0.0.0 dokodemo-door entry rides into T untouched.
 *
 * B) TC-07-19 (S5-2, redact-then-embed — the drop-line fix option is excluded
 *    by the GREEN TC-02-06 pin that the cause carries the stub's diagnostic):
 *    the last child line is run through the single redaction entry point
 *    BEFORE it is embedded in E-CORE-001's cause, so for a secret-bearing
 *    last line the cause carries `[REDACTED]`; the canary value and the
 *    materialized path T appear NOWHERE in the OperationResult or any
 *    StatusSnapshot.lastError (NFR-2 / FR-23 / §4.3 denylist); the exit code
 *    and the documented code/title/nextStep stay as TC-02-06 pins them.
 *
 * C) TC-05-20 (S5-3 supervisor half): `forceStop(): Promise<OperationResult>`
 *    kills an existing child FROM ANY LIVE STATE (SIGTERM → 2 s → SIGKILL,
 *    FR-16 escalation), awaits its exit, deletes T, resolves `{ok:true}`;
 *    with no child it is the idempotent `{ok:true}` no-op (nothing spawned,
 *    nothing killed). `stop()` semantics are untouched (graceful path stays
 *    state-machine gated — the force route exists FOR those gated states).
 *    No state-transition sequence is pinned here (S5-3 explicitly leaves the
 *    emission order to the developer).
 *
 * Fixture: tests/fixtures/fake-core.sh mode `fail-canary` (added by this
 * batch, DV-32 — existing modes byte-untouched): two stderr lines then exit 3,
 * the LAST line quoting `<T>` + the §9.3 access-key canary.
 *
 * RED status: ASSERTION RED — (TC-02-19) start succeeds and T contains the
 * 0.0.0.0 entry; (TC-07-19) the cause embeds the raw last line (no
 * `[REDACTED]`); (TC-05-20) `forceStop` is absent. Never a mock-setup error;
 * strategy §5.2 — do not weaken, skip, or delete.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { existsSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SOCKS_PORT } from '../../src/shared/constants';
import type { OperationResult } from '../../src/shared/ipc';
import type { StatusSnapshot } from '../../src/shared/status-machine';
import {
  acquirePortLock,
  portBusySkipMessage,
  portHeldExternally,
  cleanupScratches,
  type CoreLogLine,
  type CoreSupervisor,
  createScratch,
  FAKE_CORE_ENV_KEYS,
  fakeCorePath,
  isProcessGone,
  loadCoreSupervisor,
  PORT_LOCK_HOOK_TIMEOUT_MS,
  PORT_LOCK_TIMEOUT_MS,
  readInvocations,
  reapRecordedChildren,
  releasePortLock,
  type Scratch,
  waitFor,
  waitForPortFree,
} from '../helpers/core-supervisor-stub';
import { readConfigFixture } from '../helpers/profile-validator-stub';
import { tripleText } from '../helpers/secret-store-stub';

/** §9.3 access-key canary embedded by the `fail-canary` fixture (S5-2). */
const ACCESS_KEY_CANARY = 'EXAMPLEACCESSKEYID01';

/** The loopback set BR-V-09 accepts (mirrors src/main/profile-validator.ts). */
const LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1'];

/** S5-3 contract C: the supervisor surface this batch pins. */
interface ForceSupervisor extends CoreSupervisor {
  forceStop(): Promise<OperationResult>;
}

/** One test's observable surface: child records, sink lines, snapshots. */
interface Rig {
  readonly supervisor: ForceSupervisor;
  readonly scratch: Scratch;
  readonly snapshots: StatusSnapshot[];
  readonly sink: CoreLogLine[];
  invocations(): ReturnType<typeof readInvocations>;
}

const rigs: Rig[] = [];
const scratchArgvFiles: string[] = [];

const ENV_ORIGINAL = Object.fromEntries(
  FAKE_CORE_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;

function restoreFakeEnv(): void {
  for (const key of FAKE_CORE_ENV_KEYS) {
    const value = ENV_ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// DV-33 cross-file port barrier (m1-test-plan §14): this file and
// core-supervisor.test.ts both spawn REAL children on 127.0.0.1:10808 while
// vitest runs test FILES in parallel workers — DV-29's waitForPortFree
// serializes only WITHIN a file (e.g. TC-05-20's `starting` child vs
// TC-02-12's single-child pin in the other suite). Acquire the lockfile mutex
// before every test here; it is released at the END of the afterEach below
// (after the DV-29 port-free barrier). Loud, named failure — never a silent
// skip, never an assertion change (DV-33).
beforeEach(async () => {
  await acquirePortLock(
    DEFAULT_SOCKS_PORT,
    PORT_LOCK_TIMEOUT_MS,
    'the DV-33 cross-file lock for 127.0.0.1:10808 (held by the other supervisor suite)',
  );
}, PORT_LOCK_HOOK_TIMEOUT_MS);

afterEach(async () => {
  try {
    for (const rig of rigs) {
      try {
        if (rig.supervisor.isRunning()) await rig.supervisor.stop();
      } catch {
        // best effort — a failed cleanup stop must not mask the real failure
      }
    }
    rigs.length = 0;
    await reapRecordedChildren(scratchArgvFiles);
    scratchArgvFiles.length = 0;
    // DV-29 port barrier: holders release asynchronously at the kernel level —
    // wait until 127.0.0.1:10808 is actually free (polling, never a sleep).
    await waitForPortFree(
      DEFAULT_SOCKS_PORT,
      5000,
      'afterEach cleanup: 127.0.0.1:10808 released by the finished test',
    );
    restoreFakeEnv();
    cleanupScratches();
  } finally {
    // DV-33: release only AFTER the barrier above proved 127.0.0.1:10808 free
    // (or after a genuine leak already failed this hook loudly) — in `finally`
    // so a failing test can never wedge the other suite on a forgotten lock.
    releasePortLock(DEFAULT_SOCKS_PORT);
  }
});

/** Rig copied from tests/unit/core-supervisor.test.ts (mode on env, argv recorded). */
async function createRig(scenario: { mode?: string; config?: string } = {}): Promise<Rig> {
  const scratch = createScratch();
  scratchArgvFiles.push(scratch.argvFile);
  process.env.FAKE_CORE_MODE = scenario.mode ?? 'sleep';
  process.env.FAKE_CORE_ARGV_FILE = scratch.argvFile;
  process.env.FAKE_CORE_SIGNAL_FILE = scratch.signalFile;

  const api = await loadCoreSupervisor();
  if (typeof api.createSupervisor !== 'function') {
    throw new Error(
      'src/main/core-supervisor.ts must export createSupervisor(options) — M1-15 contract',
    );
  }

  const snapshots: StatusSnapshot[] = [];
  const sink: CoreLogLine[] = [];
  const supervisor = api.createSupervisor({
    binaryPath: fakeCorePath(),
    config: scenario.config ?? readConfigFixture('valid-client-config.json'),
    onStateChange: (snapshot) => {
      snapshots.push(snapshot);
    },
    logSink: (line) => {
      sink.push(line);
    },
  }) as unknown as ForceSupervisor;

  const rig: Rig = {
    supervisor,
    scratch,
    snapshots,
    sink,
    invocations: () => readInvocations(scratch.argvFile),
  };
  rigs.push(rig);
  return rig;
}

/** The materialized config path T, recovered from the child's recorded argv. */
function materializedConfigPath(rig: Rig): string {
  const invocation = rig.invocations()[0];
  if (invocation === undefined) {
    throw new Error('no child invocation recorded — spawn never happened (flow (b) step 4)');
  }
  const cIndex = invocation.args.indexOf('-c');
  const path = cIndex === -1 ? undefined : invocation.args[cIndex + 1];
  if (path === undefined) {
    throw new Error(
      `argv is not the documented [run, -c, T] array: ${JSON.stringify(invocation.args)}`,
    );
  }
  return path;
}

function firstPid(rig: Rig): number {
  const invocation = rig.invocations()[0];
  if (invocation === undefined) {
    throw new Error('no child invocation recorded — spawn never happened');
  }
  return invocation.pid;
}

/**
 * Skip these suites when 127.0.0.1:10808 is already taken.
 *
 * mergeLoopbackInbound writes DEFAULT_SOCKS_PORT into the materialized
 * profile whatever the profile itself said, so a suite cannot choose a port
 * of its own. With the application open — the normal state while working on
 * it — every spawn-path case fails for a reason that has nothing to do with
 * the code under test. Two dozen red tests read as a defect; one skip that
 * names its cause does not.
 */
const PORT_TAKEN = await portHeldExternally(DEFAULT_SOCKS_PORT);
if (PORT_TAKEN) {
  // vitest's SuiteOptions carries no skip reason, so it is stated once
  // here instead: the skips below are otherwise unexplained.
  console.warn(portBusySkipMessage(DEFAULT_SOCKS_PORT));
}

describe.skipIf(PORT_TAKEN)(
  'supervisor — materialization defense-in-depth (S5-1, BR-V-09 fix item 2)',
  () => {
    it('supervisor.materialize.extraNonLoopbackInboundNeverReachesT', async () => {
      // TC-02-19 / S5-1: the stored profile below is what the validator would
      // hand over if the extra-entry gap (TC-01-37..39) ever reappeared. EITHER
      // documented fix arm must hold: start refused with a documented E-VAL-*
      // code, or T materialized loopback-only (reject, strip, or pin).
      const rig = await createRig({
        config: readConfigFixture('extra-inbound-0-0-0-0.json'),
      });
      await waitForPortFree(
        DEFAULT_SOCKS_PORT,
        5000,
        'TC-02-19: 127.0.0.1:10808 free before start()',
      );
      const result = await rig.supervisor.start();

      if (!result.ok) {
        expect(
          result.error.code,
          'TC-02-19/S5-1 fix arm 1: start refused with a documented errors.md E-VAL-* code ' +
            `(BR-V-09 at materialization); got ${result.error.code}`,
        ).toMatch(/^E-VAL-\d{3}$/);
        return;
      }

      const tPath = materializedConfigPath(rig);
      const materialized = JSON.parse(readFileSync(tPath, 'utf8')) as Record<string, unknown>;
      const inbounds = Array.isArray(materialized['inbounds'])
        ? (materialized['inbounds'] as Array<Record<string, unknown>>)
        : [];
      const offending = inbounds.filter(
        (entry) => !LOOPBACK_ADDRESSES.includes(String(entry['listen'])),
      );
      expect(
        offending,
        'TC-02-19/S5-1 fix arm 2: the materialized T must be loopback-only — every inbound ' +
          'entry (not just the first socks one) must listen on 127.0.0.1/::1, be stripped, or ' +
          `start must have been refused; found ${JSON.stringify(offending)}`,
      ).toEqual([]);

      await rig.supervisor.stop();
    }, 15_000);
  },
);

describe.skipIf(PORT_TAKEN)(
  'supervisor — redaction before lastError (S5-2, errors.md "last redacted core line")',
  () => {
    it('supervisor.crash.lastCoreLineRedactedBeforeLastError', async () => {
      // TC-07-19 / S5-2: fake-core --mode=fail-canary dies with a benign first
      // line and a LAST line quoting <T> + the access-key canary. The fixture
      // sanity first (the canary really reached the RAW sink — the sink is raw
      // by contract, M1-15), then the pin: the embedded line is REDACTED.
      const rig = await createRig({ mode: 'fail-canary' });
      const result = await rig.supervisor.start();

      await waitFor(
        () => rig.sink.some((line) => line.text.includes(ACCESS_KEY_CANARY)),
        5000,
        'the canary stderr line to reach the raw log sink (fixture sanity)',
      );
      expect(result.ok, 'TC-07-19/FR-17: a nonzero child exit settles start() as a failure').toBe(
        false,
      );
      if (result.ok) throw new Error('unreachable: assertion above failed');
      const error = result.error;

      expect(error.code, 'errors.md §3 crash code unchanged (TC-02-06)').toBe('E-CORE-001');
      expect(
        error.cause,
        'TC-07-19/FR-17: the cause keeps naming the actual exit code 3 (TC-02-06 contract)',
      ).toMatch(/exited with code 3\b/);
      expect(
        error.cause,
        'S5-2/TC-07-19: the embedded last core line must be REDACTED before it enters ' +
          'lastError — errors.md/data-flows require the "last redacted core line"; a raw ' +
          'secret-bearing line in the cause is the documented bypass (issue #8). ' +
          'issue #24/DV-63 RED-fixup: whole-line [REDACTED] or a class marker both count',
      ).toMatch(/\[REDACTED(\]|:)/);

      // Both IPC channels that carry lastError (OperationResult + every emitted
      // StatusSnapshot) must be free of the canary and of T's path.
      const tPath = materializedConfigPath(rig);
      const surfaced = [tripleText(error)];
      for (const snapshot of rig.snapshots) {
        if (snapshot.lastError !== null) surfaced.push(tripleText(snapshot.lastError));
      }
      expect(
        surfaced.some((text) => text.includes(ACCESS_KEY_CANARY)),
        'NFR-2/§8.4: the access-key canary may never surface in the OperationResult or any ' +
          'StatusSnapshot.lastError (S5-2)',
      ).toBe(false);
      expect(
        surfaced.some((text) => text.includes(tPath)),
        'FR-23/§4.3 denylist: the materialized config path T may never surface in lastError ' +
          '(S5-2)',
      ).toBe(false);
    }, 15_000);
  },
);

describe.skipIf(PORT_TAKEN)(
  'supervisor — forceStop, kill from any live state (S5-3, FR-19/FR-23)',
  () => {
    it('supervisor.forceStop.killsRunningChildDeletesTNoChildNoop', async () => {
      // TC-05-20 / S5-3 contract C: forceStop() exists, kills a live child
      // (SIGTERM → SIGKILL escalation), awaits the exit, deletes T, resolves
      // {ok:true}; with no child it is an idempotent {ok:true} no-op. The
      // `starting`/`stopping` force-stop cases are pinned at the wiring and
      // index levels (TC-05-21/22) — no state sequence is pinned here.
      const rig = await createRig();
      expect(
        typeof rig.supervisor.forceStop,
        'S5-3/TC-05-20 (M1-26): src/main/core-supervisor.ts must expose forceStop() on the ' +
          'supervisor — the quit teardown needs a kill-from-any-state route (issue #9)',
      ).toBe('function');

      await waitForPortFree(
        DEFAULT_SOCKS_PORT,
        5000,
        'TC-05-20: 127.0.0.1:10808 free before start()',
      );
      const startResult = await rig.supervisor.start();
      expect(
        startResult.ok,
        `TC-05-20 precondition: start failed — ${JSON.stringify(startResult)}`,
      ).toBe(true);
      const pid = firstPid(rig);
      const tPath = materializedConfigPath(rig);

      const result = await rig.supervisor.forceStop();
      expect(
        result,
        'S5-3/TC-05-20: forceStop() settles {ok:true} after the kill completed',
      ).toEqual({ ok: true });
      expect(
        isProcessGone(pid),
        `S5-3/errors.md §6: child ${pid} must be reaped by forceStop — no zombie, no orphan`,
      ).toBe(true);
      expect(existsSync(tPath), 'S5-3/FR-23: T must be deleted on forceStop').toBe(false);
      expect(rig.supervisor.isRunning(), 'isRunning() is false after forceStop').toBe(false);

      // Idempotence half: no child → {ok:true}, nothing spawned, nothing killed.
      const idle = await createRig();
      expect(
        await idle.supervisor.forceStop(),
        'S5-3/TC-05-20: forceStop with no child is the idempotent {ok:true} no-op',
      ).toEqual({ ok: true });
      expect(idle.invocations().length, 'the no-child forceStop must never spawn anything').toBe(0);
    }, 15_000);
  },
);
